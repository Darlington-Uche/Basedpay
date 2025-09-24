require('dotenv').config();
const { Telegraf, Markup } = require("telegraf");
const { ethers } = require("ethers");
const admin = require("firebase-admin");
const axios = require("axios");
const express = require("express");
const app = express();

// Firebase setup
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIRE_PROJECT_ID,
    clientEmail: process.env.FIRE_CLIENT_EMAIL,
    privateKey: process.env.FIRE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  databaseURL: "https://crptmax-e1543.firebaseio.com",
});
const db = admin.firestore();

// Telegram bot setup
const bot = new Telegraf(process.env.BOT_TOKEN);
const MAIN_WALLET_ADDRESS = process.env.MAIN_WALLET_ADDRESS;
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL;

// Set webhook
bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

// Alchemy provider setup
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const provider = new ethers.providers.AlchemyProvider("base-mainnet", ALCHEMY_API_KEY);

// Global variables for payment week
let activePaymentWeek = null;
let reminderIntervals = new Map();
let paymentCheckIntervals = new Map();
let userCache = new Map(); // Cache user info when they click pay button

// Get Base ETH amount for $0.5
async function getBaseEthAmount(usdAmount = 0.5) {
  try {
    const response = await axios.get("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    const ethPrice = parseFloat(response.data.data.amount);
    const amount = usdAmount / ethPrice;
    return Number(amount.toFixed(8));
  } catch (error) {
    console.error("Error fetching ETH price:", error);
    return 0.0003;
  }
}

// Generate unique fractional amount for user identification
function generateFractionalAmount(baseAmount, userId) {
  const userIdFraction = (parseInt(userId.toString().slice(-4)) % 10000) / 100000000;
  const uniqueAmount = baseAmount + userIdFraction;
  return Number(uniqueAmount.toFixed(8));
}

// Monitor main wallet for incoming payments using Alchemy
async function monitorMainWallet(chatId) {
  if (!activePaymentWeek) return;

  console.log(`Starting Alchemy monitoring for chat ${chatId}`);
  
  const interval = setInterval(async () => {
    try {
      // Use Alchemy's enhanced API to get transactions
      const currentBlock = await provider.getBlockNumber();
      
      // Get transfers to our main wallet using Alchemy's getAssetTransfers
      const transfers = await getRecentTransfers(MAIN_WALLET_ADDRESS, currentBlock - 1000, currentBlock);
      
      for (const transfer of transfers) {
        await processIncomingTransfer(transfer, chatId);
      }
    } catch (error) {
      console.error("Error monitoring wallet with Alchemy:", error);
    }
  }, 30000); // Check every 30 seconds for faster detection

  paymentCheckIntervals.set(chatId, interval);
}

// Get recent transfers using Alchemy's enhanced API
async function getRecentTransfers(address, fromBlock, toBlock) {
  try {
    const alchemyUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
    
    const response = await axios.post(alchemyUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        toAddress: address,
        category: ["external", "internal"],
        withMetadata: true
      }]
    });

    if (response.data && response.data.result && response.data.result.transfers) {
      return response.data.result.transfers.map(transfer => ({
        hash: transfer.hash,
        from: transfer.from,
        value: ethers.utils.formatEther(transfer.value || "0"),
        blockNumber: parseInt(transfer.blockNum, 16),
        metadata: transfer.metadata
      }));
    }
    
    return [];
  } catch (error) {
    console.error("Error fetching transfers from Alchemy:", error);
    return [];
  }
}

// Process incoming transfer and identify user by exact amount
async function processIncomingTransfer(transfer, chatId) {
  if (!activePaymentWeek) return;

  const amount = parseFloat(transfer.value);
  
  console.log(`Processing transfer: ${amount} ETH from ${transfer.from}`);
  
  // Find user by exact fractional amount (strict matching)
  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    // Exact amount matching - since users are told exact amount
    if (amount === userData.amount && !userData.paid) {
      userData.paid = true;
      userData.txHash = transfer.hash;
      userData.paidAt = Date.now();

      // Save to database
      await db.collection("weekly_payments").doc(activePaymentWeek.weekId).collection("payments").doc(userId).set({
        userId: userId,
        username: userData.username,
        amount: userData.amount,
        paid: true,
        txHash: transfer.hash,
        fromAddress: transfer.from,
        paidAt: Date.now(),
        confirmed: true
      });

      // Notify group with tag
      const mention = userData.username ? `@${userData.username}` : `User ${userId}`;
      await bot.telegram.sendMessage(
        chatId,
        `✅ PAYMENT CONFIRMED!\n\n${mention} has paid their weekly fee.\nAmount: ${userData.amount} BASE ETH\nTransaction: ${transfer.hash.substring(0, 10)}...`
      );
      
      console.log(`Payment confirmed for user ${userId} with amount ${userData.amount}`);
      break;
    }
  }
}

// Start weekly payment cycle (admin only)
bot.command('week', async (ctx) => {
  // Admin check
  const adminUserId = process.env.ADMIN_USER_ID;
  if (ctx.from.id.toString() !== adminUserId) {
    return ctx.reply("❌ This command is for admins only.");
  }

  if (activePaymentWeek) {
    return ctx.reply("⚠️ A payment week is already active!");
  }

  const chatId = ctx.chat.id;
  const baseAmount = await getBaseEthAmount(0.5);
  
  // Generate unique week ID
  const weekId = `week_${Date.now()}`;
  
  activePaymentWeek = {
    weekId: weekId,
    chatId: chatId,
    startTime: Date.now(),
    endTime: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
    users: new Map() // Start with empty users map
  };

  // Send starting message with Pay button
  const message = await ctx.reply(
    `💰 WEEKLY PAYMENT CYCLE STARTED!\n\n` +
    `All members must pay $0.5 in Base ETH within 24 hours.\n` +
    `Each member has a unique fractional amount for identification.\n\n` +
    `Click the button below to see your specific amount and payment address.`,
    Markup.inlineKeyboard([
      Markup.button.callback("💰 Pay Your Fee", "show_payment_info")
    ])
  );

  // Start monitoring
  monitorMainWallet(chatId);

  // Start reminder system (15 minutes)
  const reminderInterval = setInterval(() => {
    sendReminders(chatId);
  }, 15 * 60 * 1000);

  reminderIntervals.set(chatId, reminderInterval);

  // Set timeout to end payment week after 24 hours
  setTimeout(() => {
    endPaymentWeek(chatId);
  }, 24 * 60 * 60 * 1000);

  console.log(`Weekly payment cycle started for chat ${chatId}`);
});

// Show payment info when users click the button - THIS IS WHERE WE GET USER INFO
bot.action("show_payment_info", async (ctx) => {
  if (!activePaymentWeek) {
    return ctx.answerCbQuery("❌ No active payment week.");
  }

  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name;
  const chatId = activePaymentWeek.chatId;

  // Check if user already exists in our system
  let userData = activePaymentWeek.users.get(userId);
  
  if (!userData) {
    // New user - generate their unique amount and add to system
    const baseAmount = await getBaseEthAmount(0.5);
    const userFractionalAmount = generateFractionalAmount(baseAmount, userId);
    
    userData = {
      username: username,
      amount: userFractionalAmount,
      paid: false,
      reminded: false,
      addedAt: Date.now()
    };
    
    activePaymentWeek.users.set(userId, userData);
    
    // Save user to database
    await db.collection("weekly_payments").doc(activePaymentWeek.weekId).collection("users").doc(userId).set({
      userId: userId,
      username: username,
      amount: userFractionalAmount,
      addedAt: Date.now()
    });
    
    console.log(`New user added: ${username} (${userId}) with amount ${userFractionalAmount}`);
  }

  await ctx.answerCbQuery();

  await ctx.reply(
    `💰 YOUR PAYMENT DETAILS\n\n` +
    `Amount: ${userData.amount} BASE ETH\n` +
    `Address: ${MAIN_WALLET_ADDRESS}\n\n` +
    `⚠️ IMPORTANT: Send EXACTLY ${userData.amount} BASE ETH\n` +
    `This unique amount identifies your payment!\n\n` +
    `You have 24 hours to complete this payment.`
  );
});

// Send reminders to unpaid users
async function sendReminders(chatId) {
  if (!activePaymentWeek || activePaymentWeek.chatId !== chatId) return;

  const now = Date.now();
  if (now > activePaymentWeek.endTime) {
    endPaymentWeek(chatId);
    return;
  }

  const unpaidUsers = [];
  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    if (!userData.paid) {
      unpaidUsers.push({ userId, userData });
    }
  }

  if (unpaidUsers.length > 0) {
    let reminderMessage = `⏰ PAYMENT REMINDER (15min)\n\n`;
    reminderMessage += `The following members need to pay their weekly fee:\n\n`;

    unpaidUsers.forEach(({ userId, userData }) => {
      const mention = userData.username ? `@${userData.username}` : `User ${userId}`;
      reminderMessage += `${mention}: ${userData.amount} BASE ETH\n`;
    });

    reminderMessage += `\nAddress: ${MAIN_WALLET_ADDRESS}\n`;
    reminderMessage += `Time remaining: ${getTimeRemaining(activePaymentWeek.endTime)}`;

    try {
      await bot.telegram.sendMessage(
        chatId,
        reminderMessage,
        Markup.inlineKeyboard([
          Markup.button.callback("💰 Pay Your Fee", "show_payment_info")
        ])
      );
    } catch (error) {
      console.error("Error sending reminder:", error);
    }
  }
}

// Get time remaining
function getTimeRemaining(endTime) {
  const remaining = endTime - Date.now();
  const hours = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

// End payment week and remove unpaid users
async function endPaymentWeek(chatId) {
  if (!activePaymentWeek || activePaymentWeek.chatId !== chatId) return;

  console.log(`Ending payment week for chat ${chatId}`);

  // Clear intervals
  if (reminderIntervals.has(chatId)) {
    clearInterval(reminderIntervals.get(chatId));
    reminderIntervals.delete(chatId);
  }
  
  if (paymentCheckIntervals.has(chatId)) {
    clearInterval(paymentCheckIntervals.get(chatId));
    paymentCheckIntervals.delete(chatId);
  }

  const unpaidUsers = [];
  const paidUsers = [];

  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    if (userData.paid) {
      paidUsers.push(userData.username || `User ${userId}`);
    } else {
      unpaidUsers.push({ userId, userData });
    }
  }

  // Remove unpaid users one by one
  let removalCount = 0;
  for (const { userId, userData } of unpaidUsers) {
    try {
      await bot.telegram.banChatMember(chatId, parseInt(userId));
      console.log(`Removed user ${userId} from group`);
      removalCount++;
      
      // Small delay between removals to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error removing user ${userId}:`, error);
    }
  }

  // Send final summary
  const summaryMessage = `📊 WEEKLY PAYMENT CYCLE ENDED\n\n` +
    `Total Participants: ${activePaymentWeek.users.size}\n` +
    `Paid: ${paidUsers.length} users\n` +
    `Removed: ${unpaidUsers.length} users\n\n` +
    `Paid users: ${paidUsers.length > 0 ? paidUsers.join(', ') : 'None'}\n` +
    `Removed users: ${unpaidUsers.length > 0 ? unpaidUsers.map(u => u.userData.username || `User ${u.userId}`).join(', ') : 'None'}`;

  await bot.telegram.sendMessage(chatId, summaryMessage);

  // Update database
  await db.collection("weekly_payments").doc(activePaymentWeek.weekId).update({
    ended: true,
    totalParticipants: activePaymentWeek.users.size,
    paidCount: paidUsers.length,
    removedCount: unpaidUsers.length,
    endedAt: Date.now()
  });

  activePaymentWeek = null;
  console.log(`Payment week ended. Removed ${removalCount} users.`);
}

// Status command to check current payment status
bot.command('status', async (ctx) => {
  if (!activePaymentWeek) {
    return ctx.reply("❌ No active payment week.");
  }

  const paidUsers = [];
  const unpaidUsers = [];

  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    const mention = userData.username ? `@${userData.username}` : `User ${userId}`;
    if (userData.paid) {
      paidUsers.push(mention);
    } else {
      unpaidUsers.push(mention);
    }
  }

  const timeRemaining = getTimeRemaining(activePaymentWeek.endTime);

  await ctx.reply(
    `📊 PAYMENT STATUS\n\n` +
    `Time remaining: ${timeRemaining}\n` +
    `Total Participants: ${activePaymentWeek.users.size}\n` +
    `Paid: ${paidUsers.length} users\n` +
    `Unpaid: ${unpaidUsers.length} users\n\n` +
    `Paid users: ${paidUsers.length > 0 ? paidUsers.join(', ') : 'None'}\n` +
    `Unpaid users: ${unpaidUsers.length > 0 ? unpaidUsers.join(', ') : 'None'}`
  );
});

// Root endpoint
app.get("/", (req, res) => {
  res.send("Group Payment Bot with Alchemy is running 🚀");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

console.log("💙 Group Payment Bot with Alchemy running...");