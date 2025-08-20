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
const MAIN_BOT_URL = process.env.MAIN_BOT_URL;
const PORT = process.env.PORT || 3000;
const URL = process.env.WEBHOOK_URL; // e.g. "https://your-domain.com"

// Set webhook
bot.telegram.setWebhook(`${URL}/bot${process.env.BOT_TOKEN}`);

// Mount webhook
app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

// Blockchain provider & main wallet
const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL);
const mainWallet = new ethers.Wallet(process.env.MAIN_WALLET_PRIVATE_KEY, provider);



async function getBaseEthAmount(usdAmount = 0.4) {
  try {
    const response = await axios.get("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    const ethPrice = parseFloat(response.data.data.amount);
    const amount = usdAmount / ethPrice;
    return Number(amount.toFixed(6));
  } catch (error) {
    console.error("Error fetching ETH price from Coinbase:", error);
    return 0.00011;
  }
}
// Create user wallet
async function createUserWallet(userId) {
  const wallet = ethers.Wallet.createRandom();
  await db.collection("payments").doc(userId).set({
    privateKey: wallet.privateKey,
    address: wallet.address,
    status: "pending",
    createdAt: Date.now(),
  });
  return wallet;
}

// Sweep user wallet to main wallet
// Get ETH amount equivalent to USD
async function getBaseEtAmount(usdAmount = 0.5) {
  try {
    // Coinbase first
    const response = await axios.get("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    const ethPrice = parseFloat(response.data.data.amount);
    const amount = usdAmount / ethPrice;
    return Number(amount.toFixed(6));
  } catch (error) {
    console.error("⚠️ Coinbase fetch failed, trying Coingecko:", error.message);
    try {
      const cg = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
      const ethPrice = cg.data.ethereum.usd;
      const amount = usdAmount / ethPrice;
      return Number(amount.toFixed(6));
    } catch (err) {
      console.error("❌ Coingecko fetch failed too:", err.message);
      return 0.00001; // fallback small amount
    }
  }
}

// Sweep user wallet but leave $0.008 in ETH
async function sweepUserWallet(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);

    if (balance.isZero()) return;

    // Calculate how much ETH to leave (~$0.008)
    const leaveAmount = await getBaseEtAmount(0.008);
    const leaveWei = ethers.utils.parseEther(leaveAmount.toString());

    // If balance too small, skip
    if (balance.lte(leaveWei)) {
      console.log("⚠️ Balance too low to sweep after leaving $0.008");
      return;
    }

    // Amount to transfer = balance - leaveWei
    const valueToSend = balance.sub(leaveWei);

    const tx = await wallet.sendTransaction({
      to: mainWallet.address,
      value: valueToSend
      // gas settings auto
    });

    await tx.wait();
    console.log(`✅ Swept ${ethers.utils.formatEther(valueToSend)} ETH (leaving ~$0.008)`);
  } catch (err) {
    console.error("❌ Sweep error:", err.message || err);
  }
}


// Monitor user payment
async function monitorPayment(userId, expectedAmount) {
  const start = Date.now();
  const interval = setInterval(async () => {
    const doc = await db.collection("payments").doc(userId).get();
    if (!doc.exists) return;

    const data = doc.data();
    const balance = await provider.getBalance(data.address);
    const balanceEth = parseFloat(ethers.utils.formatEther(balance));

    if (balanceEth >= expectedAmount) {
      clearInterval(interval);
      await db.collection("payments").doc(userId).update({ status: "paid" });

      await sweepUserWallet(data.privateKey);

      bot.telegram.sendMessage(
        userId,
        `✅ Payment received!\n\nUser: ${userId}\nAmount: ${balanceEth} BASE ETH\nRemarks: ¥ @Darlington_W3 is saying Thanks`,
        Markup.inlineKeyboard([
          Markup.button.url("Back to Bot", MAIN_BOT_URL)
        ])
      );
    }

    if (Date.now() - start > 10 * 60 * 1000) { // 10min timeout
      clearInterval(interval);
      await db.collection("payments").doc(userId).update({ status: "cancelled" });
      bot.telegram.sendMessage(userId, "❌ Payment cancelled due to timeout.", Markup.inlineKeyboard([
        Markup.button.url("Back to Bot", MAIN_BOT_URL)
      ]));
    }
  }, 30000);
}

// Bot start
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username || ctx.from.first_name;

  // Check if user already has a wallet
  let doc = await db.collection("payments").doc(userId).get();
  let wallet;
  if (!doc.exists) {
    // Create new wallet if not exists
    wallet = ethers.Wallet.createRandom();
    await db.collection("payments").doc(userId).set({
      privateKey: wallet.privateKey,
      address: wallet.address,
      status: "pending",
      createdAt: Date.now(),
    });
  } else {
    // Retrieve existing wallet
    const data = doc.data();
    wallet = new ethers.Wallet(data.privateKey, provider);
  }

  // Get current $0.5 BaseETH amount
  const baseEthAmount = await getBaseEthAmount(0.4);

  // Save the expected amount for this session
  await db.collection("payments").doc(userId).update({
    expectedAmount: parseFloat(baseEthAmount),
    sessionStart: Date.now()
  });

  await ctx.reply(
    `💰 Hello ${username}!\nSEND ${baseEthAmount} BASE ETH TO THIS ADDRESS TO GET SESSION\n\n${wallet.address}`,
    Markup.inlineKeyboard([
      Markup.button.callback("Cancel", "cancel_payment")
    ])
  );

  // Start monitoring payment
  monitorPayment(userId, parseFloat(baseEthAmount));
});

// Cancel button
bot.action("cancel_payment", async (ctx) => {
  const userId = ctx.from.id.toString();
  await db.collection("payments").doc(userId).update({ status: "cancelled" });
  await ctx.editMessageText("❌ Payment cancelled.", Markup.inlineKeyboard([
    Markup.button.url("Back to Bot", MAIN_BOT_URL)
  ]));
});

// Launch
// Root endpoint
app.get("/", (req, res) => {
  res.send("Bot is running with webhook 🚀");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
console.log("💙 Payment Bot running...");
