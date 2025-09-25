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
const provider = new ethers.providers.JsonRpcProvider(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`);

// Global variables for payment week
let activePaymentWeek = null;
let reminderIntervals = new Map();
let paymentCheckIntervals = new Map();
let lastCheckedBlocks = new Map();

// Get Base ETH amount for $0.5 with strict price constraints
async function getBaseEthAmount() {
  try {
    const response = await axios.get("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    const ethPrice = parseFloat(response.data.data.amount);

    // Calculate base amount for $0.5
    let baseAmount = 0.5 / ethPrice;

    // HARD CONSTRAINTS: Ensure base amount is within $0.4-$0.9 range
    const minDollar = 0.4;
    const maxDollar = 0.9;
    const minAmount = minDollar / ethPrice;
    const maxAmount = maxDollar / ethPrice;

    // Force the amount to stay within range
    if (baseAmount < minAmount) baseAmount = minAmount;
    if (baseAmount > maxAmount) baseAmount = maxAmount;

    console.log(`ETH Price: $${ethPrice}, Base Amount: ${baseAmount} ETH ($${baseAmount * ethPrice})`);
    return Number(baseAmount.toFixed(6));
  } catch (error) {
    console.error("Error fetching ETH price:", error);
    return 0.000167; // Safe fallback
  }
}

// Generate unique fractional amount for user identification
function generateFractionalAmount(baseAmount, userId) {
  // Use user ID to generate unique fraction
  const userHash = (parseInt(userId.toString().slice(-4)) % 99) + 1;
  const userIdFraction = userHash / 1000000; // Small fraction
  const uniqueAmount = baseAmount + userIdFraction;
  const fixedAmount = Number(uniqueAmount.toFixed(6));

  console.log(`Base: ${baseAmount}, User ID: ${userId}, Final: ${fixedAmount}`);
  return fixedAmount;
}

// Monitor main wallet for incoming payments using Alchemy - FIXED
async function monitorMainWallet(chatId) {
  if (!activePaymentWeek) return;

  console.log(`🚀 Starting Alchemy monitoring for chat ${chatId}`);
  
  let lastCheckedBlock = await provider.getBlockNumber();
  lastCheckedBlocks.set(chatId, lastCheckedBlock);
  console.log(`Starting from block: ${lastCheckedBlock}`);

  const interval = setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      const lastBlock = lastCheckedBlocks.get(chatId) || currentBlock - 1;
      
      if (currentBlock > lastBlock) {
        console.log(`Checking blocks ${lastBlock + 1} to ${currentBlock}`);
        const transfers = await getRecentTransfers(MAIN_WALLET_ADDRESS, lastBlock + 1, currentBlock);
        
        console.log(`Found ${transfers.length} transfers to process`);
        for (const transfer of transfers) {
          await processIncomingTransfer(transfer, chatId);
        }
        
        lastCheckedBlocks.set(chatId, currentBlock);
      }
    } catch (error) {
      console.error("Error monitoring wallet with Alchemy:", error);
    }
  }, 15000); // Check every 15 seconds

  paymentCheckIntervals.set(chatId, interval);
}

// Get recent transfers using Alchemy's enhanced API - FIXED
async function getRecentTransfers(address, fromBlock, toBlock) {
  try {
    const alchemyUrl = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

    console.log(`Checking blocks ${fromBlock} to ${toBlock} for address ${address}`);

    const response = await axios.post(alchemyUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        toAddress: address.toLowerCase(),
        category: ["external"],
        excludeZeroValue: false,
        withMetadata: true
      }]
    });

    if (response.data && response.data.result && response.data.result.transfers) {
      const transfers = response.data.result.transfers.map(transfer => {
        const value = ethers.utils.formatEther(transfer.value || "0");
        console.log(`Found transfer: ${value} ETH from ${transfer.from}`);
        return {
          hash: transfer.hash,
          from: transfer.from,
          value: value,
          blockNumber: parseInt(transfer.blockNum, 16),
          metadata: transfer.metadata
        };
      });
      console.log(`Found ${transfers.length} transfers total`);
      return transfers;
    } else {
      console.log('No transfers found in response');
      return [];
    }

  } catch (error) {
    console.error("Error fetching transfers from Alchemy:", error.response?.data || error.message);
    return [];
  }
}

// Process incoming transfer and identify user by exact amount - FIXED
async function processIncomingTransfer(transfer, chatId) {
  if (!activePaymentWeek) return;

  const amount = parseFloat(transfer.value);
  console.log(`🔍 Processing transfer: ${amount} ETH from ${transfer.from}, checking ${activePaymentWeek.users.size} users`);

  // Debug: log all user amounts
  console.log('Current user amounts:');
  activePaymentWeek.users.forEach((userData, userId) => {
    console.log(`User ${userId}: ${userData.amount} ETH (paid: ${userData.paid})`);
  });

  // Find user by fractional amount with tolerance
  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    const amountDifference = Math.abs(amount - userData.amount);
    const tolerance = 0.000001; // Small tolerance for floating point
    
    if (amountDifference < tolerance && !userData.paid) {
      console.log(`✅ Payment match found! User ${userId} amount: ${userData.amount}, received: ${amount}, difference: ${amountDifference}`);
      
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

      // Notify group with proper tag
      const mention = userData.username ? `@${userData.username}` : `[User](tg://user?id=${userId})`;
      await bot.telegram.sendMessage(
        chatId,
        `✅ PAYMENT CONFIRMED!\n\n${mention} has paid their weekly fee.\nAmount: ${userData.amount} BASE ETH\nTransaction: ${transfer.hash.substring(0, 10)}...`,
        { parse_mode: 'Markdown' }
      );

      console.log(`Payment confirmed for user ${userId}`);
      return; // Stop after finding match
    }
  }
  
  console.log(`❌ No user match found for amount ${amount}`);
}

// Start weekly payment cycle (admin only)
bot.command('week', async (ctx) => {
  const adminUserId = process.env.ADMIN_USER_ID;
  if (ctx.from.id.toString() !== adminUserId) {
    return ctx.reply("❌ This command is for admins only.");
  }

  if (activePaymentWeek) {
    return ctx.reply("⚠️ A payment week is already active!");
  }

  const chatId = ctx.chat.id;
  const baseAmount = await getBaseEthAmount();

  const weekId = `week_${Date.now()}`;
  activePaymentWeek = {
    weekId: weekId,
    chatId: chatId,
    startTime: Date.now(),
    endTime: Date.now() + (24 * 60 * 60 * 1000),
    users: new Map()
  };

  // Send starting message with Pay button
  await ctx.reply(
    `💰 WEEKLY PAYMENT CYCLE STARTED!\n\n` +
    `All members must pay $0.5 in Base ETH within 24 hours.\n` +
    `Each member has a unique fractional amount for identification.\n\n` +
    `Click the button below to see your specific amount and payment address.`,
    Markup.inlineKeyboard([
      Markup.button.callback("💰 Pay Your Fee", "show_payment_info")
    ])
  );

  // Start monitoring and reminders
  monitorMainWallet(chatId);
  
  const reminderInterval = setInterval(() => {
    sendReminders(chatId);
  }, 15 * 60 * 1000);

  reminderIntervals.set(chatId, reminderInterval);

  setTimeout(() => {
    endPaymentWeek(chatId);
  }, 24 * 60 * 60 * 1000);

  console.log(`Weekly payment cycle started for chat ${chatId}`);
});

// Show payment info when users click the button
bot.action("show_payment_info", async (ctx) => {
  if (!activePaymentWeek) {
    return ctx.answerCbQuery("❌ No active payment week.");
  }

  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name;
  const chatId = activePaymentWeek.chatId;

  // Debug current users
  console.log(`Current active users and amounts:`);
  activePaymentWeek.users.forEach((userData, uid) => {
    console.log(`User ${uid}: ${userData.amount} ETH`);
  });

  let userData = activePaymentWeek.users.get(userId);

  if (!userData) {
    const baseAmount = await getBaseEthAmount();
    const userFractionalAmount = generateFractionalAmount(baseAmount, userId);

    userData = {
      username: username,
      amount: userFractionalAmount,
      paid: false,
      reminded: false,
      addedAt: Date.now()
    };

    activePaymentWeek.users.set(userId, userData);

    await db.collection("weekly_payments").doc(activePaymentWeek.weekId).collection("users").doc(userId).set({
      userId: userId,
      username: username,
      amount: userFractionalAmount,
      addedAt: Date.now()
    });

    console.log(`New user added: ${username} with amount ${userFractionalAmount}`);
  }

  await ctx.answerCbQuery();

  await ctx.reply(
    `💰 YOUR PAYMENT DETAILS\n\n` +
    `for @${username}\n\n` +
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
      const mention = userData.username ? `@${userData.username}` : `[User](tg://user?id=${userId})`;
      reminderMessage += `${mention}: ${userData.amount} BASE ETH\n`;
    });

    reminderMessage += `\nAddress: ${MAIN_WALLET_ADDRESS}\n`;
    reminderMessage += `Time remaining: ${getTimeRemaining(activePaymentWeek.endTime)}`;

    try {
      await bot.telegram.sendMessage(
        chatId,
        reminderMessage,
        { 
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback("💰 Pay Your Fee", "show_payment_info")
          ]).reply_markup
        }
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

  if (lastCheckedBlocks.has(chatId)) {
    lastCheckedBlocks.delete(chatId);
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

  // Remove unpaid users
  let removalCount = 0;
  for (const { userId, userData } of unpaidUsers) {
    try {
      await bot.telegram.banChatMember(chatId, parseInt(userId));
      console.log(`Removed user ${userId} from group`);
      removalCount++;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error removing user ${userId}:`, error);
    }
  }

  const summaryMessage = `📊 WEEKLY PAYMENT CYCLE ENDED\n\n` +
    `Total Participants: ${activePaymentWeek.users.size}\n` +
    `Paid: ${paidUsers.length} users\n` +
    `Removed: ${unpaidUsers.length} users\n\n` +
    `Paid users: ${paidUsers.length > 0 ? paidUsers.join(', ') : 'None'}\n` +
    `Removed users: ${unpaidUsers.length > 0 ? unpaidUsers.map(u => u.userData.username || `User ${u.userId}`).join(', ') : 'None'}`;

  await bot.telegram.sendMessage(chatId, summaryMessage);

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

// Status command
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