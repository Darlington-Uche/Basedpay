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
let initialBalance = null;

// Remove all users except paid members
async function removeUnpaidUsers(chatId) {
  if (!activePaymentWeek) return 0;

  const paidUserIds = new Set();
  const unpaidUsers = [];

  // Identify paid and unpaid users
  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    if (userData.paid) {
      paidUserIds.add(userId.toString());
    } else {
      unpaidUsers.push({ userId, userData });
    }
  }

  let removalCount = 0;
  let errorCount = 0;

  try {
    // First, get all chat members to remove everyone except paid users
    const chatMembers = await getAllChatMembers(chatId);
    
    for (const member of chatMembers) {
      const memberUserId = member.user.id.toString();
      
      // Skip if user is paid, bot itself, or admin
      if (paidUserIds.has(memberUserId) || 
          memberUserId === bot.botInfo.id.toString() ||
          member.status === 'administrator' || 
          member.status === 'creator') {
        continue;
      }

      // Remove the user
      try {
        await bot.telegram.banChatMember(chatId, parseInt(memberUserId));
        console.log(`✅ Removed user ${memberUserId} from group`);
        removalCount++;
        
        // Add delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1500));
        
      } catch (error) {
        console.error(`❌ Error removing user ${memberUserId}:`, error.message);
        errorCount++;
        
        // Continue with next user even if one fails
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
  } catch (error) {
    console.error("Error fetching chat members:", error);
  }

  console.log(`Removal completed: ${removalCount} users removed, ${errorCount} errors`);
  return removalCount;
}

// Get all chat members (handles pagination)
async function getAllChatMembers(chatId) {
  const allMembers = [];
  let offset = 0;
  const limit = 200; // Telegram API limit
  
  try {
    while (true) {
      const members = await bot.telegram.getChatMembers(chatId, offset, limit);
      
      if (members.length === 0) break;
      
      allMembers.push(...members);
      offset += members.length;
      
      // Break if we got fewer members than requested (end of list)
      if (members.length < limit) break;
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error("Error fetching chat members:", error);
  }
  
  return allMembers;
}

// Enhanced endPaymentWeek function
async function endPaymentWeek(chatId) {
  if (!activePaymentWeek || activePaymentWeek.chatId !== chatId) return;

  console.log(`Ending payment week for chat ${chatId}`);

  // Clear intervals
  cleanupIntervals(chatId);

  const paidUsers = [];
  const unpaidUsers = [];

  // Categorize users
  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    if (userData.paid) {
      paidUsers.push({
        userId,
        username: userData.username || `User ${userId}`,
        amount: userData.amount
      });
    } else {
      unpaidUsers.push({
        userId,
        username: userData.username || `User ${userId}`,
        amount: userData.amount
      });
    }
  }

  // Send pre-removal notification
  await bot.telegram.sendMessage(
    chatId,
    `🔄 PAYMENT CYCLE ENDING...\n\n` +
    `Removing all unpaid users...\n` +
    `Paid users will remain in the group.`
  );

  // Remove ALL users except paid members
  const removalCount = await removeUnpaidUsers(chatId);

  // Send final summary
  const summaryMessage = `📊 WEEKLY PAYMENT CYCLE COMPLETED\n\n` +
    `Total Participants: ${activePaymentWeek.users.size}\n` +
    `✅ Paid Users: ${paidUsers.length}\n` +
    `❌ Removed Users: ${removalCount}\n\n` +
    `🏆 Paid Members (Safe):\n` +
    `${paidUsers.map(u => `• ${u.username}`).join('\n') || 'None'}\n\n` +
    `All unpaid users have been removed from the group.`;

  await bot.telegram.sendMessage(chatId, summaryMessage);

  // Save to database
  await db.collection("weekly_payments").doc(activePaymentWeek.weekId).update({
    ended: true,
    totalParticipants: activePaymentWeek.users.size,
    paidCount: paidUsers.length,
    removedCount: removalCount,
    paidUsers: paidUsers.map(u => ({ userId: u.userId, username: u.username })),
    endedAt: Date.now()
  });

  // Cleanup
  activePaymentWeek = null;
  initialBalance = null;
  
  console.log(`Payment week ended. Removed ${removalCount} users.`);
}

// Cleanup intervals function
function cleanupIntervals(chatId) {
  const intervals = [
    { map: reminderIntervals, name: 'reminder' },
    { map: paymentCheckIntervals, name: 'paymentCheck' }
  ];

  intervals.forEach(({ map, name }) => {
    if (map.has(chatId)) {
      clearInterval(map.get(chatId));
      map.delete(chatId);
      console.log(`Cleared ${name} interval for chat ${chatId}`);
    }
  });
}

// Add error handling for member fetching
async function safeGetChatMembers(chatId) {
  try {
    // Check if bot has admin permissions
    const chat = await bot.telegram.getChat(chatId);
    const botMember = await bot.telegram.getChatMember(chatId, bot.botInfo.id);
    
    if (botMember.status !== 'administrator' || !botMember.can_restrict_members) {
      console.error("Bot doesn't have permission to remove members");
      return [];
    }
    
    return await getAllChatMembers(chatId);
  } catch (error) {
    console.error("Failed to get chat members:", error);
    return [];
  }
}

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

// Monitor main wallet balance changes - SIMPLE & RELIABLE
async function monitorWalletBalance(chatId) {
  if (!activePaymentWeek) return;

  console.log(`🚀 Starting balance monitoring for chat ${chatId}`);
  
  // Get initial balance
  initialBalance = await provider.getBalance(MAIN_WALLET_ADDRESS);
  console.log(`Initial balance: ${ethers.utils.formatEther(initialBalance)} ETH`);

  const interval = setInterval(async () => {
    try {
      const currentBalance = await provider.getBalance(MAIN_WALLET_ADDRESS);
      const balanceDiff = currentBalance.sub(initialBalance);
      
      if (balanceDiff.gt(0)) {
        const amountReceived = parseFloat(ethers.utils.formatEther(balanceDiff));
        console.log(`💰 New payment detected: ${amountReceived} ETH`);
        
        await identifyPayment(amountReceived, chatId);
        
        // Update initial balance to current balance for next detection
        initialBalance = currentBalance;
      }
    } catch (error) {
      console.error("Balance monitoring error:", error.message);
    }
  }, 10000); // Check every 10 seconds

  paymentCheckIntervals.set(chatId, interval);
}

// Identify which user made the payment based on amount
async function identifyPayment(amountReceived, chatId) {
  if (!activePaymentWeek) return;

  console.log(`🔍 Identifying payment of ${amountReceived} ETH among ${activePaymentWeek.users.size} users`);

  // Single user payment detection
  for (const [userId, userData] of activePaymentWeek.users.entries()) {
    const amountDifference = Math.abs(amountReceived - userData.amount);
    const tolerance = 0.000001;
    
    if (amountDifference < tolerance && !userData.paid) {
      await processUserPayment(userId, userData, amountReceived, chatId);
      return;
    }
  }

  // Multiple payments detection (2-4 users paid at same time)
  const unpaidUsers = Array.from(activePaymentWeek.users.entries())
    .filter(([userId, userData]) => !userData.paid)
    .map(([userId, userData]) => ({ userId, userData }));

  // Check all combinations of 2, 3, or 4 users
  for (let count = 2; count <= 4; count++) {
    const combinations = getCombinations(unpaidUsers, count);
    
    for (const combo of combinations) {
      const totalAmount = combo.reduce((sum, user) => sum + user.userData.amount, 0);
      const amountDifference = Math.abs(amountReceived - totalAmount);
      const tolerance = 0.000001 * count; // Slightly larger tolerance for multiple payments
      
      if (amountDifference < tolerance) {
        console.log(`✅ Found ${count} users who paid together: ${combo.map(u => u.userId).join(', ')}`);
        
        // Process all users in this combination
        for (const { userId, userData } of combo) {
          await processUserPayment(userId, userData, userData.amount, chatId);
        }
        return;
      }
    }
  }

  console.log(`❌ No match found for payment of ${amountReceived} ETH`);
}

// Process individual user payment
async function processUserPayment(userId, userData, amount, chatId) {
  userData.paid = true;
  userData.paidAt = Date.now();

  // Save to database
  await db.collection("weekly_payments").doc(activePaymentWeek.weekId).collection("payments").doc(userId).set({
    userId: userId,
    username: userData.username,
    amount: userData.amount,
    paid: true,
    paidAt: Date.now(),
    confirmed: true
  });

  // Notify group with proper tag
  const mention = userData.username ? `@${userData.username}` : `[User](tg://user?id=${userId})`;
  await bot.telegram.sendMessage(
    chatId,
    `✅ PAYMENT CONFIRMED!\n\n${mention} has paid their weekly fee.\nAmount: ${userData.amount} BASE ETH`,
    { parse_mode: 'Markdown' }
  );

  console.log(`Payment confirmed for user ${userId} with amount ${userData.amount}`);
}

// Helper function to get combinations of users
function getCombinations(array, size) {
  const results = [];
  
  function combine(start, combo) {
    if (combo.length === size) {
      results.push([...combo]);
      return;
    }
    
    for (let i = start; i < array.length; i++) {
      combo.push(array[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  }
  
  combine(0, []);
  return results;
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

  // Start balance monitoring and reminders
  monitorWalletBalance(chatId);
  
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
  // Remove ALL users except paid members
const removalCount = await removeUnpaidUsers(chatId);

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
  initialBalance = null;
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
  res.send("Group Payment Bot with Balance Monitoring is running 🚀");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

console.log("💙 Group Payment Bot with Balance Monitoring running...");