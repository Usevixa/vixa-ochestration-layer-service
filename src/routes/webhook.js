import express from "express";
import { getSession, updateSession } from "../services/session.service.js";
import { createUserOnboarding } from "../services/onboarding.service.js";
import { verifyNIN } from "../services/kyc.service.js";
import { verifyBVN } from "../services/bvn.service.js";
import { loginUser, checkPhoneNumber } from "../services/auth.service.js";
import { fetchAuthMe } from "../services/user.service.js";
import { depositCrypto } from "../services/deposit.service.js";
import { fetchWalletBalances } from "../services/wallet.service.js";
import { fetchReceiveWallets } from "../services/recieve.service.js";
import { analyzeUserIntent } from "../services/ai.service.js";
import {
  isSessionTokenValid,
} from "../services/auth.service.js";
import {
  fetchSwapCurrencies,
  fetchSwapQuote,
  executeSwap,
} from "../services/swap.service.js";
import {
  fetchWithdrawalQuote,
  fetchBanks,
  validateBankAccount,
  executeWithdrawal,
} from "../services/withdrawal.service.js";
import { confirmPayment } from "../services/confirmPayment.service.js";
import {
  fetchSendSupportedCurrencies,
  executeSendCrypto,
} from "../services/send.service.js";

import { fetchRates } from "../services/rates.service.js";
// IMPORTANT: Ensure this file has the correct two-stage encryption/decryption functions
import { decryptRequest, encryptResponse } from "../utils/decrypt.js";

const router = express.Router();

// Environment configuration (Replace with environment variables in production)
const WHATSAPP_TOKEN =
  "EAAYMlHAusnwBRDx6KHY8bAZBkuqMP773wYlbnkLnsKOXxxHXNs9qc9DORyAYVxdQkJrr0zprJ3aX37K1HhFal619ntMwbUOZBU3iXSvxVWP4P0RdgJQkbrgPph6TR5e5Dl4utr4gJsUy8xODgCRAEAmllx7iubbCKo0qFJq12xvMO5IZAtJIO4e3ejZCsQZDZD";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const FLOW_ID = "1462140848896803";
const WHATSAPP_API_VERSION = "v25.0";

function formatDobToISO(dob) {
  if (!dob) return null;

  // If already ISO, return as-is
  if (!isNaN(Date.parse(dob))) {
    return new Date(dob).toISOString();
  }

  // If format is YYYY-MM-DD (Flow date picker)
  const isoCandidate = `${dob}T00:00:00.000Z`;
  return new Date(isoCandidate).toISOString();
}

function normalizePhone(phone) {
  if (!phone) return phone;

  // If already has +, return as-is
  if (phone.startsWith("+")) {
    return phone;
  }

  // WhatsApp sends Nigerian numbers as 234XXXXXXXXXX
  if (phone.startsWith("234")) {
    return `+${phone}`;
  }

  // Fallback (just in case)
  return `+${phone}`;
}

const PREFERRED_COINS = [
  "USDT",
  "BTC",
  "ETH",
  "USDC",
  "BNB",
  "XRP",
  "SOL",
  "LTC",
  "DOGE",
  "TRX",
];

function pickPreferredCoins(allCurrencies, preferredList) {
  return preferredList
    .map((symbol) => allCurrencies.find((c) => c.coin === symbol))
    .filter(Boolean) // remove missing coins safely
    .slice(0, 10); // enforce WhatsApp limit
}

function pickPreferredToCoins(allCurrencies, preferredList, fromCoin) {
  return preferredList
    .filter((symbol) => symbol !== fromCoin) // exclude from coin
    .map((symbol) => allCurrencies.find((c) => c.coin === symbol))
    .filter(Boolean)
    .slice(0, 10);
}

// function isFreeText(msg, session) {
//   if (msg.type !== "text") return false;
//   if (session.data?.expectedInput) return false;
//   return true;
// }

// Near the top of your webhook router, after your imports

// async function withAuthGuard(from, phone_number_id, action) {
//   const session = await getSession(from);

//   // 1. Check token validity before even attempting the action
//   if (!isSessionTokenValid(session.data)) {
//     console.warn(`Token expired or missing for ${from}. Prompting re-login.`);

//     await updateSession(from, {
//       data: {
//         ...session.data,
//         token: null,
//         tokenExpiresAt: null,
//         authenticated: false,
//         awaitingPin: true,
//         pinAttempts: 0,
//       },
//     });

//     await sendWhatsApp(
//       from,
//       "🔒 Your session has expired. Please enter your *4-digit PIN* to continue.",
//       phone_number_id,
//     );
//     return false;
//   }

//   // 2. Run the action, catch any surprise 401s the server sends back
//   try {
//     await action(session);
//     return true;
//   } catch (err) {
//     const is401 =
//       err?.response?.status === 401 ||
//       err?.message?.toLowerCase().includes("unauthorized");

//     if (is401) {
//       console.warn(`401 received mid-action for ${from}. Prompting re-login.`);

//       await updateSession(from, {
//         data: {
//           ...session.data,
//           token: null,
//           tokenExpiresAt: null,
//           authenticated: false,
//           awaitingPin: true,
//           pinAttempts: 0,
//         },
//       });

//       await sendWhatsApp(
//         from,
//         "🔒 Your session has expired. Please enter your *4-digit PIN* to continue.",
//         phone_number_id,
//       );
//       return false;
//     }

//     throw err; // anything else, let it bubble up normally
//   }
// }

/* ------------- verification for Meta webhook ------------- */
router.get("/callback", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ------------- main webhook for incoming WhatsApp events (FIXED FOR FLOW SUBMISSION) ------------- */
router.post("/callback", async (req, res) => {
  console.log("webhook hit successfully");
  // Acknowledge immediately to Meta
  res.sendStatus(200);

  try {
    // console.log("WEBHOOK ARRIVED:", JSON.stringify(req.body, null, 2));

    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const phone_number_id = value.metadata?.phone_number_id;

        // Ignore status updates
        if (value.statuses?.length > 0) {
          console.log("Status update received — ignoring");
          continue;
        }

        const messages = value.messages || [];
        for (const msg of messages) {
          const rawFrom = msg.from;
          if (!rawFrom) continue;

          const from = normalizePhone(rawFrom);
          if (!from) continue;

          // Store phone_number_id in session for later replies
          const session = await getSession(from);
          await updateSession(from, {
            data: { ...(session.data || {}), phone_number_id },
          });

          // --- FIX: Detect and process Flow Submission (nfm_reply) ---

          if (
            session.data?.authenticated &&
            !isSessionTokenValid(session.data)
          ) {
            console.warn(`Token expired for ${from} — forcing re-login`);

            await updateSession(from, {
              data: {
                ...session.data, // preserve ALL flow state intact
                token: null,
                tokenExpiresAt: null,
                authenticated: false,
                awaitingPin: true,
                pinAttempts: 0,
              },
            });

            await sendWhatsApp(
              from,
              "🔒 Your session has expired. Please enter your *4-digit PIN* to continue.",
              phone_number_id,
            );

            continue; // skip nfm_reply, list_reply, button_reply, text — everything
          }

          if (
            msg.type === "interactive" &&
            msg.interactive?.type === "nfm_reply"
          ) {
            console.log("Flow submission (nfm_reply) received. Processing...");
            const responseJson = msg.interactive.nfm_reply.response_json;
            const flowData = JSON.parse(responseJson);

            // Hand off the raw, parsed Flow data to the dedicated processing function
            await processFlowCompletion(from, phone_number_id, flowData);
            continue;
          }

          // --- HANDLE LIST MENU SELECTIONS ---
          if (
            msg.type === "interactive" &&
            msg.interactive?.type === "list_reply"
          ) {
            const actionId = msg.interactive.list_reply.id;

            console.log("Menu selection:", actionId);

            // ✅ ADD THIS NEW BLOCK FOR DEPOSIT CONFIRMATION
            if (actionId === "CONFIRM_DEPOSIT_PAYMENT") {
              const confirmDeposit = await confirmPayment({
                id: session.data.id,
              });
              console.log(confirmDeposit, "confirmDeposit.data");

              await sendWhatsApp(
                from,
                `✅ Your deposit is currently being processed in the background.\n\nYou’ll receive a notification on WhatsApp (and email, if available) once it’s completed.\n\nThanks for using VIXA 🚀`,
                phone_number_id,
              );

              // Reset the awaiting confirmation state so it doesn't trigger again
              await updateSession(from, {
                data: {
                  ...session.data,
                  awaitingDepositConfirmation: false,
                },
              });

              await sendWhatsApp(
                from,
                "What would you like to do next?",
                phone_number_id,
              );

              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (actionId.startsWith("SWAP_FROM_")) {
              const coin = actionId.replace("SWAP_FROM_", "");
              const selected = session.data.swap.currencies.find(
                (c) => c.coin === coin,
              );

              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: {
                    ...session.data.swap,
                    step: "ENTER_AMOUNT",
                    fromCoin: coin,
                    fromCoinLimits: selected,
                  },
                },
              });

              await sendWhatsApp(
                from,
                `💰 Enter amount of *${coin}* to swap\n\nMin: ${selected.minAmount}\nMax: ${selected.maxAmount}`,
                phone_number_id,
              );

              return;
            }

            if (actionId.startsWith("SWAP_TO_")) {
              const toCoin = actionId.replace("SWAP_TO_", "");
              const toLimits = session.data.swap.currencies.find(
                (c) => c.coin === toCoin,
              );
              const { amount } = session.data.swap;

              // 🔴 CRITICAL RULE
              if (amount < toLimits.minAmount || amount > toLimits.maxAmount) {
                await sendWhatsApp(
                  from,
                  `❌ Amount not supported for ${toCoin}. Range: ${toLimits.minAmount} - ${toLimits.maxAmount}`,
                  phone_number_id,
                );
                return;
              }

              const quote = await fetchSwapQuote({
                fromCoin: session.data.swap.fromCoin,
                toCoin,
                fromAmount: amount,
              });

              console.log(quote, "qouteres");

              if (!quote.success) {
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to get swap quote. Try again.",
                  phone_number_id,
                );
                return;
              }

              // await sendWhatsApp(
              //   from,
              //   `🔄 *Swap Quote*\n\nFrom: ${amount} ${session.data.swap.fromCoin}\nTo: ${quote.data.data.toAmount} ${toCoin}\nFee: ${quote.data.data.fee}`,
              //   phone_number_id,
              // );

              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: {
                    ...session.data.swap,
                    step: "AWAITING_SWAP_PIN",
                    toCoin,
                    quote: quote.data.data,
                  },
                },
              });

              await sendWhatsApp(
                from,
                `🔄 *Swap Ready*\n\n` +
                  `From: ${amount} ${session.data.swap.fromCoin}\n` +
                  `To: ${quote.data.data.toAmount} ${toCoin}\n` +
                  `Fee: ${quote.data.data.fee}\n\n` +
                  `🔐 Please enter your *PIN* to authorize this swap.`,
                phone_number_id,
              );

              return;
            }

            if (actionId.startsWith("RECEIVE_COIN_")) {
              const coin = actionId.replace("RECEIVE_COIN_", "");

              const walletsRes = await fetchReceiveWallets({ coin });

              if (!walletsRes.success) {
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to load receive wallets.",
                  phone_number_id,
                );
                return;
              }

              const wallets = walletsRes?.data?.data?.data || [];

              if (!wallets.length) {
                await sendWhatsApp(
                  from,
                  `⚠️ No receive wallets available for ${coin}.`,
                  phone_number_id,
                );
                return;
              }

              // ✅ If only ONE wallet → show address directly
              if (wallets.length === 1) {
                const w = wallets[0];

                await sendWhatsApp(
                  from,
                  `📥 *${w.coin} Receive Address*\n\n` +
                    `Network: ${w.network}\n` +
                    `Chain: ${w.chain}\n\n` +
                    `📌 *Tap & hold to copy address:*\n` +
                    `\`\`\`\n${w.address}\n\`\`\``,
                  phone_number_id,
                );

                await sendMainMenu(from, phone_number_id);
                return;
              }

              // ✅ Multiple chains → show selection menu
              const rows = wallets.slice(0, 10).map((w) => ({
                id: `RECEIVE_WALLET_${w.id}`,
                title: `${w.chain}`,
                description: `${w.network}`,
              }));

              await updateSession(from, {
                data: {
                  ...session.data,
                  receive: {
                    step: "SELECT_CHAIN",
                    wallets,
                    selectedCoin: coin,
                  },
                },
              });

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "list",
                    body: { text: `📥 Select ${coin} network` },
                    action: {
                      button: "Select network",
                      sections: [{ title: "Available Networks", rows }],
                    },
                  },
                },
                phone_number_id,
              );

              return;
            }

            if (actionId.startsWith("RECEIVE_WALLET_")) {
              const walletId = actionId.replace("RECEIVE_WALLET_", "");

              const wallet = session.data?.receive?.wallets?.find(
                (w) => w.id === walletId,
              );

              if (!wallet) {
                await sendWhatsApp(
                  from,
                  "⚠️ Wallet not found.",
                  phone_number_id,
                );
                return;
              }

              await sendWhatsApp(
                from,
                `📥 *${wallet.coin} Receive Address*\n\n` +
                  `Network: ${wallet.network}\n` +
                  `Chain: ${wallet.chain}\n\n` +
                  `📌 *Tap & hold to copy address:*\n` +
                  `\`\`\`\n${wallet.address}\n\`\`\``,
                phone_number_id,
              );

              // reset receive state
              await updateSession(from, {
                data: {
                  ...session.data,
                  receive: null,
                },
              });

              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (actionId.startsWith("SEND_COIN_")) {
              const coin = actionId.replace("SEND_COIN_", "");

              const selectedCoin = session.data?.send?.coins?.find(
                (c) => c.coin === coin,
              );

              if (!selectedCoin) {
                await sendWhatsApp(from, "⚠️ Coin not found.", phone_number_id);
                return;
              }

              if (session.data.send.type === "P2P") {
                await updateSession(from, {
                  data: {
                    ...session.data,
                    send: {
                      ...session.data.send,
                      coin,
                      chain: null, // No chain needed for P2P
                      step: "ENTER_AMOUNT",
                    },
                  },
                });
                await sendWhatsApp(
                  from,
                  `💸 Enter amount of *${coin}* to send:`,
                  phone_number_id,
                );
                return; // STOP here
              }

              const chains = selectedCoin.chains || [];

              // Single chain → auto select
              if (chains.length === 1) {
                await updateSession(from, {
                  data: {
                    ...session.data,
                    send: {
                      ...session.data.send,
                      coin,
                      chain: chains[0],
                      step: "ENTER_AMOUNT",
                    },
                  },
                });

                await sendWhatsApp(
                  from,
                  `💸 Enter amount of *${coin}* to send\nMin: ${chains[0].minWithdrawAmount}`,
                  phone_number_id,
                );

                return;
              }

              // Multi-chain → list selection
              const rows = chains.slice(0, 10).map((ch) => ({
                id: `SEND_CHAIN_${ch.chain}`,
                title: ch.chain,
                description: `Min: ${ch.minWithdrawAmount}`,
              }));

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: {
                    ...session.data.send,
                    coin,
                    chains,
                    step: "SELECT_CHAIN",
                  },
                },
              });

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "list",
                    body: { text: `📤 Select ${coin} network` },
                    action: {
                      button: "Select network",
                      sections: [{ title: "Available Networks", rows }],
                    },
                  },
                },
                phone_number_id,
              );

              return;
            }

            if (actionId.startsWith("SEND_CHAIN_")) {
              const chainName = actionId.replace("SEND_CHAIN_", "");

              const chain = session.data?.send?.chains?.find(
                (c) => c.chain === chainName,
              );

              if (!chain) {
                await sendWhatsApp(
                  from,
                  "⚠️ Network not found.",
                  phone_number_id,
                );
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: {
                    ...session.data.send,
                    chain,
                    step: "ENTER_AMOUNT",
                  },
                },
              });

              await sendWhatsApp(
                from,
                `💸 Enter amount of *${session.data.send.coin}* to send\nMin: ${chain.minWithdrawAmount}`,
                phone_number_id,
              );

              return;
            }

            if (
              actionId === "SEND_TYPE_P2P" ||
              actionId === "SEND_TYPE_EXTERNAL"
            ) {
              const type = actionId === "SEND_TYPE_P2P" ? "P2P" : "EXTERNAL";

              const coinsRes = await fetchSendSupportedCurrencies();

              if (!coinsRes.success) {
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to load supported coins.",
                  phone_number_id,
                );
                return;
              }

              const coins = coinsRes?.data?.data?.currencies || [];

              const uniqueCoins = Array.from(
                new Map(coins.map((c) => [c.coin, c])).values(),
              );

              let rows = [];

              // const rows = uniqueCoins.slice(0, 10).map((coinObj) => ({
              //   id: `SEND_COIN_${coinObj.coin}`,
              //   title: coinObj.coin,
              //   description: `${coinObj.chains?.length || 1} network(s)`,
              // }));

              if (type === "P2P") {
                // For P2P: Clean list, no network details needed
                rows = uniqueCoins.slice(0, 10).map((coinObj) => ({
                  id: `SEND_COIN_${coinObj.coin}`,
                  title: coinObj.coin,
                  description: "Send to Vixa user",
                }));
              } else {
                // For External: Show network counts
                rows = uniqueCoins.slice(0, 10).map((coinObj) => ({
                  id: `SEND_COIN_${coinObj.coin}`,
                  title: coinObj.coin,
                  description: `${coinObj.chains?.length || 1} network(s)`,
                }));
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: {
                    step: "SELECT_COIN",
                    type,
                    coins,
                  },
                },
              });

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "list",
                    body: { text: "📤 Select coin to send" },
                    action: {
                      button: "Select coin",
                      sections: [{ title: "Available Coins", rows }],
                    },
                  },
                },
                phone_number_id,
              );

              return;
            }
            // --- WITHDRAWAL: TYPE & COIN & BANK SELECTION ---
            if (actionId === "WITHDRAW_TYPE_USDT") {
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: { coin: "USDT", step: "ENTER_AMOUNT" },
                },
              });
              await sendWhatsApp(
                from,
                "💰 Please enter the amount of *USDT* you want to withdraw:",
                phone_number_id,
              );
              return;
            }

            if (actionId === "WITHDRAW_TYPE_OTHER") {
              const balances = await fetchWalletBalances();
              if (!balances || balances.length === 0) {
                await sendWhatsApp(
                  from,
                  "⚠️ You have no balances to withdraw.",
                  phone_number_id,
                );
                return;
              }
              const rows = balances.slice(0, 10).map((b) => ({
                id: `WITHDRAW_COIN_${b.coin}`,
                title: b.coin,
                description: `Bal: ${b.balance}`,
              }));

              await updateSession(from, {
                data: { ...session.data, withdraw: { step: "SELECT_COIN" } },
              });
              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "list",
                    body: { text: "Select a coin to withdraw:" },
                    action: {
                      button: "Select Coin",
                      sections: [{ title: "Your Coins", rows }],
                    },
                  },
                },
                phone_number_id,
              );
              return;
            }

            if (actionId.startsWith("WITHDRAW_COIN_")) {
              const coin = actionId.replace("WITHDRAW_COIN_", "");
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: { coin, step: "ENTER_AMOUNT" },
                },
              });
              await sendWhatsApp(
                from,
                `💰 Please enter the amount of *${coin}* you want to withdraw:`,
                phone_number_id,
              );
              return;
            }

            if (actionId.startsWith("WITHDRAW_BANK_")) {
              const networkId = actionId.replace("WITHDRAW_BANK_", "");
              // Retrieve bank name from session cache
              const bankName =
                session.data.withdraw.banks.find((b) => b.id === networkId)
                  ?.name || "Selected Bank";

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    networkId,
                    bankName,
                    step: "ENTER_ACCOUNT_NUMBER",
                  },
                },
              });
              await sendWhatsApp(
                from,
                `🏦 You selected *${bankName}*.\n\nPlease enter your 10-digit Account Number:`,
                phone_number_id,
              );
              return;
            }

            switch (actionId) {
              case "SEND_CRYPTO": {
                // route to buy flow
                const session = await getSession(from);

                await updateSession(from, {
                  data: {
                    ...session.data,
                    send: {
                      step: "SELECT_SEND_TYPE",
                    },
                  },
                });

                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "list",
                      body: {
                        text: "Who are you sending to? 😊",
                      },
                      action: {
                        button: "Choose recipient",
                        sections: [
                          {
                            title: "Send Options",
                            rows: [
                              {
                                id: "SEND_TYPE_P2P",
                                title: "Another Vixa user",
                                description: "Send to a phone number",
                              },
                              {
                                id: "SEND_TYPE_EXTERNAL",
                                title: "External wallet",
                                description: "Send to blockchain address",
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                  phone_number_id,
                );

                const coinsRes = await fetchSendSupportedCurrencies();

                if (!coinsRes.success) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Unable to load supported coins.",
                    phone_number_id,
                  );
                  break;
                }

                // const coins = coinsRes?.data?.data?.currencies || [];

                // // Unique by coin symbol
                // const uniqueCoins = Array.from(
                //   new Map(coins.map((c) => [c.coin, c])).values(),
                // );

                // const rows = uniqueCoins.slice(0, 10).map((coinObj) => ({
                //   id: `SEND_COIN_${coinObj.coin}`,
                //   title: coinObj.coin, // ✅ REQUIRED by WhatsApp
                //   description: `${coinObj.chains?.length || 1} network(s)`,
                // }));

                // await updateSession(from, {
                //   data: {
                //     ...session.data,
                //     send: {
                //       step: "SELECT_COIN",
                //       coins,
                //     },
                //   },
                // });

                // await sendWhatsApp(
                //   from,
                //   {
                //     type: "interactive",
                //     interactive: {
                //       type: "list",
                //       body: { text: "📤 Select coin to send" },
                //       action: {
                //         button: "Select coin",
                //         sections: [{ title: "Available Coins", rows }],
                //       },
                //     },
                //   },
                //   phone_number_id,
                // );

                break;
              }

              case "RECIEVE_CRYPTO": {
                const session = await getSession(from);
                const walletsRes = await fetchReceiveWallets();

                console.log(walletsRes, "walletsReswalletsRes");
                if (!walletsRes.success) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Unable to load receive options right now.",
                    phone_number_id,
                  );
                  break;
                }

                const wallets = walletsRes?.data?.data?.data || [];
                if (!wallets.length) {
                  await sendWhatsApp(
                    from,
                    "⚠️ No receive wallets available.",
                    phone_number_id,
                  );
                  break;
                }
                // Unique coins only
                const uniqueCoins = [...new Set(wallets.map((w) => w.coin))];

                const rows = uniqueCoins.slice(0, 10).map((coin) => ({
                  id: `RECEIVE_COIN_${coin}`,
                  title: coin,
                  description: `Receive ${coin}`,
                }));
                await updateSession(from, {
                  data: {
                    ...session.data,
                    receive: {
                      step: "SELECT_COIN",
                      wallets,
                    },
                  },
                });

                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "list",
                      body: { text: "📥 Select the coin you want to receive" },
                      action: {
                        button: "Select coin",
                        sections: [{ title: "Available Coins", rows }],
                      },
                    },
                  },
                  phone_number_id,
                );

                break;
              }

              case "DEPOSIT_CRYPTO": {
                try {
                  // 1. Get session (we need phone + pin)
                  const session = await getSession(from);
                  await updateSession(from, {
                    data: {
                      ...(session.data || {}),
                      phone_number_id,
                      pendingDeposit: true, // flag to indicate user is about to enter amount
                      depositCoin: "USDT", // default for now, can be dynamic
                      depositChain: "SOL", // default for now
                      depositCurrency: "NGN", // default for now
                    },
                  });

                  await sendWhatsApp(
                    from,
                    `💰 Please enter the amount in NGN you want to deposit for your ${
                      session.data?.depositCoin || "USDT"
                    } wallet:`,
                    phone_number_id,
                  );
                } catch (err) {
                  console.error("DEPOSIT_CRYPTO init error:", err);
                  await sendWhatsApp(
                    from,
                    "⚠️ Unable to initiate deposit. Please try again later.",
                    phone_number_id,
                  );
                }

                break;
              }

              case "WITHDRAW_CRYPTO":
                {
                  await updateSession(from, {
                    data: {
                      ...session.data,
                      withdraw: { step: "SELECT_WITHDRAW_TYPE" },
                    },
                  });
                  await sendWhatsApp(
                    from,
                    {
                      type: "interactive",
                      interactive: {
                        type: "list",
                        body: { text: "How would you like to withdraw?" },
                        action: {
                          button: "Select Option",
                          sections: [
                            {
                              title: "Withdrawal Options",
                              rows: [
                                {
                                  id: "WITHDRAW_TYPE_USDT",
                                  title: "Withdraw in USDT",
                                },
                                {
                                  id: "WITHDRAW_TYPE_OTHER",
                                  title: "Withdraw other coin",
                                },
                              ],
                            },
                          ],
                        },
                      },
                    },
                    phone_number_id,
                  );
                  break;
                }
                break;

              case "SWAP_CRYPTO": {
                const currenciesRes = await fetchSwapCurrencies();
                console.log(
                  currenciesRes?.data?.data?.currencies,
                  "currenciesRes",
                );
                if (!currenciesRes.success) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Unable to load swap currencies right now.",
                    phone_number_id,
                  );
                  break;
                }

                const allCoins = currenciesRes?.data?.data?.currencies;

                const selectedCoins = pickPreferredCoins(
                  allCoins,
                  PREFERRED_COINS,
                );

                const rows = selectedCoins.map((c) => ({
                  id: `SWAP_FROM_${c.coin}`,
                  title: c.coin,
                  description: `Min: ${c.minAmount}, Max: ${c.maxAmount}`,
                }));

                await updateSession(from, {
                  data: {
                    ...(session.data || {}),
                    swap: {
                      step: "SELECT_FROM",
                      currencies: selectedCoins,
                    },
                  },
                });
                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "list",
                      body: {
                        text: "🔄 Select the coin you want to swap *from*",
                      },
                      action: {
                        button: "Select coin",
                        sections: [{ title: "Available Coins", rows }],
                      },
                    },
                  },
                  phone_number_id,
                );

                break;
              }

              case "GET_WALLET_BALANCE": {
                try {
                  // 1. Get session (we need phone + pin)
                  const session = await getSession(from);
                  await updateSession(from, {
                    data: { ...(session.data || {}), phone_number_id },
                  });

                  // const pin = session?.data?.pin;
                  // if (!pin) {
                  //   await sendWhatsApp(
                  //     from,
                  //     "⚠️ Please log in again to view your wallet balance.",
                  //     phone_number_id
                  //   );
                  //   break;
                  // }

                  // 2. Re-login to refresh token
                  // await loginUser({
                  //   phoneNumber: from,
                  //   pin,
                  // });

                  // 3. Fetch profile + balances
                  const me = await fetchAuthMe();
                  const balances = await fetchWalletBalances();

                  // 4. Construct dynamic balance message
                  const now = new Date();
                  const formattedDate = now.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  });

                  let balanceText = `Hi ${me.firstName} 👋\n\n💼 *Your Wallet Balances*\n\n`;

                  if (!balances || balances.length === 0) {
                    balanceText += "You currently have no wallet balances.\n";
                  } else {
                    for (const bal of balances) {
                      balanceText += `• ${bal.coin}: ${bal.balance}\n`;
                    }
                  }

                  balanceText += `\n📅 Last updated: ${formattedDate}`;

                  // 5. Send message
                  await sendWhatsApp(from, balanceText, phone_number_id);

                  await sendWhatsApp(
                    from,
                    "What would you like to do next?",
                    phone_number_id,
                  );

                  await sendMainMenu(from, phone_number_id);

                  // // 5. Send message
                  // await sendWhatsApp(from, balanceText, phone_number_id);
                } catch (err) {
                  console.error("GET_WALLET_BALANCE error:", err);

                  await sendWhatsApp(
                    from,
                    "⚠️ Unable to fetch your wallet balance at the moment. Please try again shortly.",
                    phone_number_id,
                  );
                }

                break;
              }
            }

            continue;
          }

          // 2.5 BUTTON REPLIES (Used for Yes/No Confirmations)
          if (
            msg.type === "interactive" &&
            msg.interactive?.type === "button_reply"
          ) {
            const actionId = msg.interactive.button_reply.id;

            if (actionId === "WITHDRAW_CANCEL") {
              await updateSession(from, {
                data: { ...session.data, withdraw: null },
              });
              await sendWhatsApp(
                from,
                "❌ Withdrawal cancelled.",
                phone_number_id,
              );
              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (actionId === "QUOTE_CONFIRM_YES") {
              const banksRes = await fetchBanks();
              if (!banksRes.success || !banksRes.data.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to load banks right now. Please try again later.",
                  phone_number_id,
                );
                return;
              }

              // WhatsApp limits lists to 10 items. We slice the top 10 here.
              const topBanks = banksRes.data.slice(5, 15);
              const rows = topBanks.map((b) => ({
                id: `WITHDRAW_BANK_${b.id}`,
                title: b.name.substring(0, 24), // WhatsApp title limit is 24 chars
              }));

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    banks: topBanks,
                    step: "SELECT_BANK",
                  },
                },
              });

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "list",
                    body: { text: "🏦 Select your destination bank:" },
                    action: {
                      button: "Select Bank",
                      sections: [{ title: "Available Banks", rows }],
                    },
                  },
                },
                phone_number_id,
              );
              return;
            }

            if (actionId === "ACCOUNT_CONFIRM_YES") {
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    step: "ENTER_EXECUTE_PIN",
                  },
                },
              });
              await sendWhatsApp(
                from,
                "🔐 Enter your *4-digit PIN* to execute this withdrawal:",
                phone_number_id,
              );
              return;
            }
            continue;
          }

          // --- END FIX ---

          // Handle initial incoming text message to trigger the flow
          if (msg.type === "text") {
            console.log(
              `Incoming text from ${from} — sending flow trigger`,
              msg,
            );

            console.log("starts from here!!!");

            console.log(session, " store house");

            const rawText = msg.text?.body?.trim();

            // ==========================================
            // 1. THE AUTHENTICATION & ONBOARDING GATE
            // (Strictly handles first-time or returning unauthenticated users)
            // ==========================================

            // A. Is the user currently trying to log in?
            if (session.data?.awaitingPin) {
              const authResult = await handleAuthenticationGate({
                from,
                phone_number_id,
                msgText: rawText,
              });

              if (authResult.status === "SUCCESS") {
                await sendWhatsApp(
                  from,
                  `Welcome back ${authResult.me.firstName} 👋`,
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
              }
              // Stop processing. The user is either logged in now, or failed the PIN check.
              return;
            }

            // B. Does the user need to log in or register?
            if (!session.data?.authenticated) {
              console.log(`Checking registration status for ${from}...`);
              const checkData = await checkPhoneNumber(from);

              if (!checkData) {
                await sendWhatsApp(
                  from,
                  "⚠️ Service momentarily unavailable. Please try again later.",
                  phone_number_id,
                );
                return;
              }

              if (checkData.exists) {
                // User exists but isn't logged in -> Ask for PIN
                await updateSession(from, {
                  data: {
                    ...(session.data || {}),
                    awaitingPin: true,
                    pinAttempts: 0,
                  },
                });
                await sendWhatsApp(
                  from,
                  "🔐 Welcome back to VIXA!\n\nPlease enter your *4-digit PIN* to continue.",
                  phone_number_id,
                );
              } else {
                // User does not exist -> Trigger Onboarding
                await triggerFlow(from, phone_number_id);
              }
              // Stop processing. Do not pass to AI.
              return;
            }

            // ==========================================
            // 2. THE AI IN-FLOW INTERCEPTOR
            // (Only runs if session.data.authenticated === true)
            // ==========================================

            const aiAnalysis = await analyzeUserIntent(rawText, session.data);
            console.log("AI Intent:", aiAnalysis.intent);

            // A. Handle Chit-chat or Confusion
            if (aiAnalysis.intent === "CHITCHAT_OR_CLARIFY") {
              await sendWhatsApp(
                from,
                aiAnalysis.replyMessage,
                phone_number_id,
              );
              return;
            }

            // B. Handle Flow Cancellations
            if (aiAnalysis.intent === "CANCEL_FLOW") {
              await updateSession(from, {
                data: {
                  ...session.data,
                  pendingDeposit: false,
                  awaitingDepositPin: false,
                  swap: null,
                  send: null,
                  withdraw: null,
                  receive: null,
                },
              });
              await sendWhatsApp(
                from,
                "Okay, I've canceled that for you.",
                phone_number_id,
              );
              await sendMainMenu(from, phone_number_id);
              return;
            }

            // C. Handle new menu requests
            if (aiAnalysis.intent === "START_NEW_FLOW") {
              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (session.data?.pendingDeposit) {
              // Treat text as deposit amount
              const amountNgn = parseFloat(msg.text?.body?.trim());

              if (isNaN(amountNgn) || amountNgn <= 0) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid amount greater than 0.",
                  phone_number_id,
                );
                return;
              }

              const rateData = await fetchRates({
                fromCurrency: "naira",
                toCurrency: "USD",
              });

              console.log(rateData.data, "validate this");

              if (!rateData?.data?.success || !rateData.data) {
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to retrieve exchange rates at the moment. Please try again shortly.",
                  phone_number_id,
                );
                return;
              }

              const formattedUpdatedAt = rateData.data.data.updatedAt
                ? new Date(rateData.data.data.updatedAt).toLocaleString(
                    "en-NG",
                    {
                      dateStyle: "medium",
                      timeStyle: "short",
                    },
                  )
                : "Just now";

              const rateMessage = `
💱 *Current Exchange Rate*

• Currency Pair: ${rateData.data.data.fromCurrency} → ${rateData.data.data.toCurrency}
• Buy Rate: ${rateData.data.data.buyRate}
• Sell Rate: ${rateData.data.data.sellRate}
• Base Rate: ${rateData.data.data.baseRate}

🏦 Source: ${rateData.data.data.source}
🕒 Updated: ${formattedUpdatedAt}
`.trim();

              await sendWhatsApp(from, rateMessage, phone_number_id);

              await updateSession(from, {
                data: {
                  ...session.data,
                  pendingDeposit: false,
                  awaitingDepositPin: true,
                  depositAmount: amountNgn,
                },
              });

              await sendWhatsApp(
                from,
                "🔐 Please enter your *4-digit PIN* to confirm this deposit.",
                phone_number_id,
              );
              return;
            }

            if (session.data?.awaitingDepositPin) {
              const pin = msg.text?.body?.trim();

              if (!pin || pin.length !== 4) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid 4-digit PIN.",
                  phone_number_id,
                );
                return;
              }
              // Call depositCrypto
              const depositCypto = await depositCrypto({
                currency: session.data.depositCurrency,
                amountNgn: session.data.depositAmount,
                channelId: "AF944F0C-BA70-47C7-86DC-1BAD5A6AB4E4",
                coin: session.data.depositCoin,
                // chain: session.data.depositChain,
                correlationId: `CORR-${Date.now()}`,
                idempotencyKey: `IDEMPOTENCY-${Date.now()}`,
                pin,
              });

              console.log(depositCypto, "depositCryptodepositCrypto");

              if (depositCypto.success) {
                // --- NEW INTEGRATION: Format Data ---
                const depositData = depositCypto.data.data;

                // 1. Format Expiry Time (e.g., "12:14 PM")
                const expiryDate = new Date(depositData.expiresAtUtc);
                const formattedExpiry = expiryDate.toLocaleTimeString("en-NG", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: true,
                });

                // 2. Format Amount with commas (e.g., "14,000")
                const formattedAmount =
                  depositData.amountToPayNgn?.toLocaleString("en-NG");

                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "button",
                      body: {
                        text: `✅ *Deposit Initiated*

Please make a transfer using the details below:
💰 *Amount:* ₦${formattedAmount}
🏦 *Bank Name:* ${depositCypto?.data?.data?.bankName}  
👤 *Account Name:* ${depositCypto?.data?.data?.accountName}  
🔢 *Account Number:* ${depositCypto?.data?.data?.accountNumber}  
🧾 *Reference:* ${depositCypto?.data?.data?.reference}
⏳ *Expires At:* ${formattedExpiry}

Once you’ve completed the transfer, tap *Confirm Payment* below.`,
                      },
                      action: {
                        buttons: [
                          {
                            type: "reply",
                            reply: {
                              id: "CONFIRM_DEPOSIT_PAYMENT",
                              title: "Confirm Payment",
                            },
                          },
                        ],
                      },
                    },
                  },
                  phone_number_id,
                );

                await updateSession(from, {
                  data: {
                    ...session.data,
                    pendingDeposit: false,
                    awaitingDepositConfirmation: true,
                    awaitingDepositPin: false,
                    depositReference: depositCypto?.data?.data?.reference,
                    depositAmount: session.data.depositAmount,
                    depositCoin: session.data.depositCoin,
                    id: session.data.id,
                  },
                });
              }

              return; // Stop further processing
            }

            //             if (session.data?.awaitingDepositConfirmation) {
            //               const confirmDeposit = await confirmPayment({
            //                 id: session.data.id,
            //               });
            //               console.log(confirmDeposit, "confirmDeposit.data");

            //               await sendWhatsApp(
            //                 from,
            //                 `✅ Your deposit is currently being processed in the background.

            // You’ll receive a notification on WhatsApp (and email, if available) once it’s completed.

            // Thanks for using VIXA 🚀`,
            //                 phone_number_id,
            //               );

            //               await sendWhatsApp(
            //                 from,
            //                 "What would you like to do next?",
            //                 phone_number_id,
            //               );

            //               await sendMainMenu(from, phone_number_id);
            //             }

            if (session.data?.swap?.step === "ENTER_AMOUNT") {
              const amount = parseFloat(msg.text?.body?.trim());
              const { minAmount, maxAmount } = session.data.swap.fromCoinLimits;

              if (isNaN(amount)) {
                await sendWhatsApp(
                  from,
                  "⚠️ Enter a valid number.",
                  phone_number_id,
                );
                return;
              }

              if (amount < minAmount || amount > maxAmount) {
                await sendWhatsApp(
                  from,
                  `❌ Amount must be between ${minAmount} and ${maxAmount}`,
                  phone_number_id,
                );
                return;
              }

              // Fetch currencies again for TO selection
              const currenciesRes = await fetchSwapCurrencies();

              const allCoins = currenciesRes?.data?.data?.currencies;
              const fromCoin = session.data.swap.fromCoin;
              const selectedToCoins = pickPreferredToCoins(
                allCoins,
                PREFERRED_COINS,
                fromCoin,
              );
              const rows = selectedToCoins.map((c) => ({
                id: `SWAP_TO_${c.coin}`,
                title: c.coin,
                description: `Min: ${c.minAmount}, Max: ${c.maxAmount}`,
              }));

              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: {
                    ...session.data.swap,
                    step: "SELECT_TO",
                    amount,
                    currencies: selectedToCoins,
                  },
                },
              });

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "list",
                    body: { text: "➡️ Select the coin you want to receive" },
                    action: {
                      button: "Select coin",
                      sections: [{ title: "Available Coins", rows }],
                    },
                  },
                },
                phone_number_id,
              );

              return;
            }

            if (session.data?.swap?.step === "AWAITING_SWAP_PIN") {
              const pin = msg.text?.body?.trim();

              if (!pin || pin.length < 4) {
                await sendWhatsApp(
                  from,
                  "⚠️ Enter a valid PIN.",
                  phone_number_id,
                );
                return;
              }

              const { fromCoin, amount, toCoin } = session.data.swap;

              const swapResult = await executeSwap({
                fromCoin,
                fromAmount: amount,
                toCoin,
                pin,
              });

              console.log(swapResult, "swapResultswapResult");

              if (!swapResult.success) {
                await sendWhatsApp(
                  from,
                  `❌ Swap failed: ${swapResult.error?.message || "Try again."}`,
                  phone_number_id,
                );

                await sendWhatsApp(
                  from,
                  "What would you like to do next?",
                  phone_number_id,
                );

                await sendMainMenu(from, phone_number_id);
                return;
              }

              await sendWhatsApp(
                from,
                `✅ *Swap Successful!*\n\n` +
                  `${amount} ${fromCoin} → ${swapResult.data.data.toAmount} ${toCoin}\n\n` +
                  `🎉 Your wallet has been updated.`,
                phone_number_id,
              );

              // Reset swap state
              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: null,
                },
              });

              await sendWhatsApp(
                from,
                "What would you like to do next?",
                phone_number_id,
              );
              await sendMainMenu(from, phone_number_id);

              return;
            }

            if (session.data?.send?.step === "ENTER_AMOUNT") {
              console.log("amount is logged", msg.text?.body);
              const amount = parseFloat(msg.text?.body?.trim());
              const min = session.data.send.chain?.minWithdrawAmount || 0;

              if (isNaN(amount) || amount <= 0) {
                await sendWhatsApp(
                  from,
                  "⚠️ Enter a valid amount.",
                  phone_number_id,
                );
                return;
              }

              const isP2P = session.data.send.type === "P2P";

              if (!isP2P) {
                const min = session.data.send.chain?.minWithdrawAmount || 0;
                if (amount < min) {
                  await sendWhatsApp(
                    from,
                    `❌ Minimum withdraw is ${min}`,
                    phone_number_id,
                  );
                  return;
                }
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: {
                    ...session.data.send,
                    amount,
                    step: "ENTER_ADDRESS",
                  },
                },
              });

              // await sendWhatsApp(
              //   from,
              //   `📥 Enter recipient *${session.data.send.coin}* wallet address`,
              //   phone_number_id,
              // );
              if (isP2P) {
                await sendWhatsApp(
                  from,
                  "📱 Enter the recipient's **Phone Number**:\n(e.g., 08012345678)",
                  phone_number_id,
                );
              } else {
                await sendWhatsApp(
                  from,
                  `📥 Enter recipient *${session.data.send.coin}* wallet address:`,
                  phone_number_id,
                );
              }

              return;
            }

            if (session.data?.send?.step === "ENTER_ADDRESS") {
              const address = msg.text?.body?.trim();
              const isP2P = session.data.send.type === "P2P";

              if (isP2P) {
                // Simple check for phone number length
                if (address.length < 10) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Invalid phone number. Please try again.",
                    phone_number_id,
                  );
                  return;
                }
              } else {
                // Wallet address check
                if (address.length < 10) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Enter a valid wallet address.",
                    phone_number_id,
                  );
                  return;
                }
              }

              // if (!address || address.length < 10) {
              //   await sendWhatsApp(
              //     from,
              //     "⚠️ Enter a valid wallet address.",
              //     phone_number_id,
              //   );
              //   return;
              // }

              const needsTag = session.data.send.chain?.needTag;

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: {
                    ...session.data.send,
                    address,
                    step: needsTag ? "ENTER_TAG" : "ENTER_PIN",
                  },
                },
              });

              if (needsTag) {
                await sendWhatsApp(
                  from,
                  "🏷️ Enter destination tag / memo (required for this network)",
                  phone_number_id,
                );
                return;
              }

              await sendWhatsApp(
                from,
                "🔐 Enter your *PIN* to confirm this transfer",
                phone_number_id,
              );

              return;
            }

            if (session.data?.send?.step === "ENTER_TAG") {
              const tag = msg.text?.body?.trim();

              if (!tag) {
                await sendWhatsApp(
                  from,
                  "⚠️ Tag is required.",
                  phone_number_id,
                );
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: {
                    ...session.data.send,
                    tag,
                    step: "ENTER_PIN",
                  },
                },
              });

              await sendWhatsApp(
                from,
                "🔐 Enter your *PIN* to confirm this transfer",
                phone_number_id,
              );

              return;
            }

            if (session.data?.send?.step === "ENTER_PIN") {
              const pin = msg.text?.body?.trim();

              if (!pin || pin.length < 4) {
                await sendWhatsApp(
                  from,
                  "⚠️ Enter a valid PIN.",
                  phone_number_id,
                );
                return;
              }

              const { coin, amount, address, chain, type } = session.data.send;

              // WhatsApp number of sender
              const userPhone = from;

              const sendRes = await executeSendCrypto({
                type,
                coin,
                chain: chain?.chain,
                amount,
                phoneNumber: userPhone,
                externalAddress: address,
                pin,
              });

              console.log(sendRes, "checking send crypto");

              if (!sendRes.success) {
                await sendWhatsApp(
                  from,
                  `❌ Transfer failed: ${sendRes.error?.message || "Try again."}`,
                  phone_number_id,
                );
                return;
              }

              await sendWhatsApp(
                from,
                `✅ *Transfer Successful!*\n\n` +
                  `${amount} ${coin} sent\n` +
                  `To: ${address}\n\n` +
                  `🚀 Transaction submitted`,
                phone_number_id,
              );

              // Reset send state
              await updateSession(from, {
                data: {
                  ...session.data,
                  send: null,
                },
              });

              await sendWhatsApp(
                from,
                "What would you like to do next?",
                phone_number_id,
              );

              await sendMainMenu(from, phone_number_id);
              return;
            }

            // --- WITHDRAW FLOW LOGIC ---
            if (session.data?.withdraw?.step === "ENTER_AMOUNT") {
              const amount = parseFloat(msg.text?.body?.trim());
              if (isNaN(amount) || amount <= 0) {
                await sendWhatsApp(
                  from,
                  "⚠️ Enter a valid amount.",
                  phone_number_id,
                );
                return;
              }
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    amount,
                    step: "ENTER_QUOTE_PIN",
                  },
                },
              });
              await sendWhatsApp(
                from,
                "🔐 Enter your *4-digit PIN* to generate a quote:",
                phone_number_id,
              );
              return;
            }

            if (session.data?.withdraw?.step === "ENTER_QUOTE_PIN") {
              const pin = msg.text?.body?.trim();
              if (pin.length < 4) {
                await sendWhatsApp(from, "⚠️ Invalid PIN.", phone_number_id);
                return;
              }

              const { coin, amount } = session.data.withdraw;
              const channelId = "fe8f4989-3bf6-41ca-9621-ffe2bc127569";

              const quoteRes = await fetchWithdrawalQuote({
                coin,
                amount,
                channelId,
                pin,
              });

              if (!quoteRes.success) {
                await sendWhatsApp(
                  from,
                  `❌ Failed to get quote: ${quoteRes.error?.message || "Please try again."}`,
                  phone_number_id,
                );
                return;
              }

              const q = quoteRes.data;
              const msgText = `📊 *Withdrawal Quote*\n\nWithdrawing: ${q.coinAmount} ${q.coin}\nEstimated NGN: ${q.estimatedNgn} ${q.fiatCurrency}\nFees: ${q.totalFees}\n\nDo you want to proceed?`;

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    channelId,
                    step: "AWAITING_QUOTE_CONFIRM",
                  },
                },
              });

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "button",
                    body: { text: msgText },
                    action: {
                      buttons: [
                        {
                          type: "reply",
                          reply: {
                            id: "QUOTE_CONFIRM_YES",
                            title: "Yes, Proceed",
                          },
                        },
                        {
                          type: "reply",
                          reply: { id: "WITHDRAW_CANCEL", title: "Cancel" },
                        },
                      ],
                    },
                  },
                },
                phone_number_id,
              );
              return;
            }

            if (session.data?.withdraw?.step === "ENTER_ACCOUNT_NUMBER") {
              const accountNumber = msg.text?.body?.trim();
              if (accountNumber.length < 10) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid 10-digit account number.",
                  phone_number_id,
                );
                return;
              }

              const { networkId, bankName } = session.data.withdraw;

              const valRes = await validateBankAccount({
                accountNumber,
                networkId,
              });
              if (!valRes.success) {
                await sendWhatsApp(
                  from,
                  `❌ Account validation failed. Check the number and try again.`,
                  phone_number_id,
                );
                return;
              }

              const { accountName } = valRes.data;

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    accountNumber,
                    accountName,
                    step: "AWAITING_ACCOUNT_CONFIRM",
                  },
                },
              });

              const msgText = `🏦 *Confirm Bank Details*\n\nBank: ${bankName}\nAccount: ${accountNumber}\nName: ${accountName}\n\nIs this correct?`;

              await sendWhatsApp(
                from,
                {
                  type: "interactive",
                  interactive: {
                    type: "button",
                    body: { text: msgText },
                    action: {
                      buttons: [
                        {
                          type: "reply",
                          reply: {
                            id: "ACCOUNT_CONFIRM_YES",
                            title: "Yes, Withdraw",
                          },
                        },
                        {
                          type: "reply",
                          reply: { id: "WITHDRAW_CANCEL", title: "Cancel" },
                        },
                      ],
                    },
                  },
                },
                phone_number_id,
              );
              return;
            }

            if (session.data?.withdraw?.step === "ENTER_EXECUTE_PIN") {
              const pin = msg.text?.body?.trim();
              if (pin.length < 4) {
                await sendWhatsApp(from, "⚠️ Invalid PIN.", phone_number_id);
                return;
              }

              const {
                coin,
                amount,
                accountNumber,
                accountName,
                networkId,
                channelId,
              } = session.data.withdraw;

              const execRes = await executeWithdrawal({
                coin,
                amount,
                accountNumber,
                accountName,
                networkId,
                channelId,
                pin,
              });

              if (!execRes.success) {
                await sendWhatsApp(
                  from,
                  `❌ Withdrawal failed: ${execRes.error?.message || "Please try again."}`,
                  phone_number_id,
                );
                await updateSession(from, {
                  data: { ...session.data, withdraw: null },
                });
                await sendMainMenu(from, phone_number_id);
                return;
              }

              const result = execRes.data;
              await sendWhatsApp(
                from,
                `✅ *Withdrawal Successful!*\n\nAmount: ${result.amount} ${result.coin}\nTo: ${result.accountName}\nBank: ${result.bankName}\nRef: ${result.reference}\n\n🚀 Funds are on the way!`,
                phone_number_id,
              );

              // Clear state
              await updateSession(from, {
                data: { ...session.data, withdraw: null },
              });
              await sendWhatsApp(
                from,
                "What would you like to do next?",
                phone_number_id,
              );
              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (session.data?.authenticated) {
              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (session.data?.awaitingPin) {
              const authResult = await handleAuthenticationGate({
                from,
                phone_number_id,
                msgText: msg.text?.body?.trim(),
              });

              // If auth succeeded, show menu
              if (authResult.status === "SUCCESS") {
                await sendWhatsApp(
                  from,
                  `Welcome back ${authResult.me.firstName} 👋`,
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
              }
              // If wrong/invalid/requested PIN, `handleAuthenticationGate`
              // has already sent the appropriate reply message.
              return;
            }

            console.log(`Checking registration status for ${from}...`);

            const checkData = await checkPhoneNumber(from);

            // Handle API failure gracefully
            if (!checkData) {
              await sendWhatsApp(
                from,
                "⚠️ Service momentarily unavailable. Please try again later.",
                phone_number_id,
              );
              return;
            }

            if (checkData.exists) {
              // CASE A: User is Registered -> Ask for PIN
              console.log(`User ${from} exists. Requesting PIN.`);

              await updateSession(from, {
                data: {
                  ...(session.data || {}),
                  awaitingPin: true, // This flag ensures the NEXT message goes to Step 3 above
                  pinAttempts: 0,
                },
              });

              await sendWhatsApp(
                from,
                "🔐 Welcome back to VIXA!\n\nPlease enter your *4-digit PIN* to continue.",
                phone_number_id,
              );
            } else {
              // CASE B: User NOT Registered -> Trigger Onboarding Flow
              console.log(
                `User ${from} does not exist. Triggering Onboarding.`,
              );

              await triggerFlow(from, phone_number_id);
            }

            console.log(`Received non-text message from ${from} — ignoring`);

            // await triggerFlow(from, phone_number_id);
          }
        }
      }
    }
  } catch (err) {
    console.error("Error processing webhook:", err);
  }
});

/* ------------- Logic for Flow Completion (when Flow JSON uses "complete") ------------- */
async function processFlowCompletion(phone, phone_number_id, form) {
  // The 'form' object here is the content of response_json already parsed.

  // 1. Map the field values from the form object

  console.log(form, "form)form)form)");
  const firstName = form.screen_0_First_Name_0 || form.First_Name_4f74a5;
  const lastName = form.screen_0_Last_Name_1 || form.Last_Name_76477c;
  const email = form.screen_0_Email_2;
  const nin = form.screen_0_NIN_3;
  const bvn = form.screen_0_BVN_4;
  const dob = form.screen_0_Date_Of_Birth_5;
  const pin = form.screen_0_Pin_6;
  const confirmPin = form.screen_0_Confirm_Pin_7;

  console.log("Extracted Onboarding Data:", { firstName, lastName, nin });

  // Basic validation
  if (
    !firstName ||
    !lastName ||
    !nin ||
    !bvn ||
    !pin ||
    !confirmPin ||
    pin !== confirmPin
  ) {
    const message =
      pin !== confirmPin ? "Pins do not match." : "Missing required fields.";
    console.warn("Validation failed:", message);
    await sendWhatsApp(
      phone,
      `❌ Onboarding failed: ${message}`,
      phone_number_id,
    );
    return;
  }

  console.log("Starting onboarding for:", phone);

  try {
    // 1. CREATE ONBOARDING USER
    const createRes = await createUserOnboarding({
      firstName,
      lastName,
      phoneNumber: phone,
      phoneNumberId: phone_number_id,
      email,
      pin,
    });

    if (!createRes.success) {
      await sendWhatsApp(
        phone,
        "❌ Could not create your account. Try again later.",
        phone_number_id,
      );
      return;
    }

    // 2. LOG IN USER TO CACHE TOKEN (Mandatory for subsequent API calls)
    let loginToken = null;
    try {
      console.log("here here", phone, pin);

      loginToken = await loginUser({ phoneNumber: phone, pin });
      console.log(loginToken, "loginTokenloginToken");
    } catch (e) {
      console.log(
        "Auto login failed after creation. Cannot verify NIN.",
        e?.message,
      );
      await sendWhatsApp(
        phone,
        "⚠️ Account created but login failed. Try logging in later.",
        phone_number_id,
      );
      return;
    }

    const formattedDob = formatDobToISO(dob);

    // 3. VERIFY NIN (Now uses the cached token)
    const verifyRes = await verifyNIN({
      nin,
      firstName,
      lastName,
      dateOfBirth: formattedDob,
    });

    const status = verifyRes?.data?.data?.status;
    console.log("NIN Verification Result:", verifyRes, status);

    if (status === "1") {
      await sendWhatsApp(
        phone,
        "⏳ Your NIN verification is being processed. Please wait while we review your request.",
        phone_number_id,
      );
      return;
    }

    if (status === "2") {
      const verifyBvn = await verifyBVN({
        bvn,
        firstName,
        lastName,
      });

      if (verifyBvn?.success) {
        await sendWhatsApp(
          phone,
          "✅ Your BVN has been successfully verified.",
          phone_number_id,
        );
      }
      if (!verifyBvn?.success) {
        await sendWhatsApp(
          phone,
          "⏳ Your BVN verification is being processed. You can continue using VIXA.",
          phone_number_id,
        );
      }

      const me = await fetchAuthMe();
      const balances = await fetchWalletBalances();

      console.log("Verified user profile:", me);
      console.log("Wallet balances:", balances);
      // 4. Update session

      await updateSession(phone, {
        step: "COMPLETED",
        data: { me, balances },
      });

      await sendWhatsApp(
        phone,
        `Hello ${me.firstName}, welcome to VIXA! 👋

I’m VIXA, your AI-powered digital wallet assistant.

I’ll help you send, receive, convert, and manage money — including NGN and crypto (USDT, BTC, ETH) — all directly from WhatsApp.

You can also send voice notes or images, and I’ll understand them.

For your security, please ensure your WhatsApp is locked 🔒

Let’s get you started 🚀`,
        phone_number_id,
      );

      await sendWhatsApp(
        phone,
        {
          type: "interactive",
          interactive: {
            type: "list",
            body: {
              text: "Here is what you can do with VIXA 👇",
            },
            footer: {
              text: "Select an action to continue",
            },
            action: {
              button: "Open Menu",
              sections: [
                {
                  title: "Crypto Actions",
                  rows: [
                    {
                      id: "SEND_CRYPTO",
                      title: "Send Crypto",
                      description: "Send USDT, BTC, or ETH",
                    },
                    {
                      id: "RECIEVE_CRYPTO",
                      title: "Recieve Crypto",
                      description: "Recieve crypto in NGN",
                    },
                    {
                      id: "DEPOSIT_CRYPTO",
                      title: "Deposit Crypto",
                      description: "Fund your wallet",
                    },
                    {
                      id: "WITHDRAW_CRYPTO",
                      title: "Withdraw Crypto",
                      description: "Send crypto out",
                    },
                    {
                      id: "SWAP_CRYPTO",
                      title: "Swap Crypto",
                      description: "Convert between coins",
                    },
                    {
                      id: "GET_WALLET_BALANCE",
                      title: "See Wallet Balances",
                      description: "check wallet balances",
                    },
                  ],
                },
              ],
            },
          },
        },
        phone_number_id,
      );

      return;
    }

    if (status === "3") {
      await sendWhatsApp(
        phone,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: {
              text: "⚠️ Your NIN verification was rejected. Please review your details and try again. Would you like to try again?",
            },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: {
                    id: "NIN_RETRY",
                    title: "Try Again",
                  },
                },
              ],
            },
          },
        },
        phone_number_id,
      );
      return;
    }

    if (status === "4") {
      await sendWhatsApp(
        phone,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: {
              text: "⚠️ NIN verification failed. We were unable to verify your NIN due to a technical issue, please try again.",
            },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: {
                    id: "NIN_RETRY",
                    title: "Try Again",
                  },
                },
              ],
            },
          },
        },
        phone_number_id,
      );
      return;
    }

    if (status === "6") {
      await sendWhatsApp(
        phone,
        "⏳ Your NIN verification is under review by our team. An administrator will review your request and notify you once it’s updated",
        phone_number_id,
      );
      return;
    }

    await sendWhatsApp(
      phone,
      "⚠️ Verification failed due to an unexpected error. Please try again later.",
      phone_number_id,
    );

    // if (!verifyRes.success) {
    //   await sendWhatsApp(
    //     phone,
    //     "⚠️ Account created, but we couldn't verify your NIN. Please try again.",
    //     phone_number_id
    //   );
    //   // NOTE: You might need to add logic here to clean up the partially created user.
    //   return;
    // }

    // --- SUCCESS PATH ---

    // 4. Update session
    // await updateSession(phone, {
    //   step: "COMPLETED",
    //   data: {
    //     firstName,
    //     lastName,
    //     kyc: verifyRes.data,
    //     onboarding: createRes.data,
    //   },
    // });

    // 5. Send confirmation message
    // await sendWhatsApp(
    //   phone,
    //   "✅ Your account has been created and verified. Type *menu* to continue.",
    //   phone_number_id
    // );

    // console.log("User Onboarding and Verification Successful:", phone);
  } catch (err) {
    console.error("Onboarding service error:", err);
    await sendWhatsApp(
      phone,
      "🛑 A server error occurred during verification. Please try again.",
      phone_number_id,
    );
  }
}

/* ------------- dedicated endpoint for Flow Health Check & Data Exchange ------------- */
router.post("/flow/callback", async (req, res) => {
  try {
    // 1. DECRYPT THE INCOMING REQUEST
    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(
      req.body,
    );

    const { action, flow_token } = decryptedBody;
    let responsePayload = {}; // Must be defined for encryption

    // --- FIX: A. HEALTH CHECK LOGIC (Mandatory for successful setup) ---
    if (action === "ping") {
      console.log("HEALTH CHECK PING RECEIVED.");
      responsePayload = {
        data: {
          status: "active", // Required successful response
        },
      };
    }
    // --- B. DATA EXCHANGE LOGIC (For future real-time validation) ---
    else if (action === "data_exchange") {
      console.log("Data exchange request received. Returning failure screen.");
      responsePayload = {
        screen: "FAILURE",
        data: { message: "Data Exchange not implemented." },
      };
    }

    // 2. ENCRYPT THE RESPONSE
    const encryptedResponse = encryptResponse(
      responsePayload,
      aesKeyBuffer,
      initialVectorBuffer,
    );

    // 3. SEND RESPONSE (Must be 'text/plain')
    res.set("Content-Type", "text/plain");
    return res.send(encryptedResponse);
  } catch (err) {
    // 4. ERROR HANDLING
    if (err.status === 421) {
      // Must return HTTP 421 if decryption fails
      return res.status(421).send("Decryption Failed");
    }
    console.error("Flow callback processing error:", err);
    // General server error
    return res.status(500).send("Server Error");
  }
});

async function handleAuthenticationGate({ from, phone_number_id, msgText }) {
  const session = await getSession(from);

  // Already authenticated → continue normally
  // if (session?.data?.authenticated) {
  //   return { status: "AUTHENTICATED" };
  // }

  // Ask for PIN
  if (!session?.data?.awaitingPin) {
    await updateSession(from, {
      data: {
        ...(session.data || {}),
        awaitingPin: true,
        pinAttempts: 0,
      },
    });

    await sendWhatsApp(
      from,
      "🔐 Please enter your *4-digit PIN* to continue.",
      phone_number_id,
    );

    return { status: "PIN_REQUESTED" };
  }

  // User is replying with PIN
  const pin = msgText?.trim();

  if (!pin || pin.length < 4) {
    await sendWhatsApp(from, "⚠️ Please enter a valid PIN.", phone_number_id);
    return { status: "INVALID_PIN" };
  }

  try {
    // Attempt login
    await loginUser({ phoneNumber: from, pin });

    // Try fetching profile
    const me = await fetchAuthMe();

    if (!me) {
      throw new Error("ME_NOT_FOUND");
    }

    // Success 🎉
    await updateSession(from, {
      data: {
        ...(session.data || {}),
        awaitingPin: false,
        authenticated: true,
        pinAttempts: 0,
      },
    });

    return { status: "SUCCESS", me };
  } catch (err) {
    const message = err?.message?.toLowerCase() || "";

    // User not found → onboarding
    if (
      message.includes("not found") ||
      message.includes("user") ||
      message === "me_not_found"
    ) {
      await updateSession(from, {
        data: {
          ...(session.data || {}),
          awaitingPin: false,
          authenticated: false,
        },
      });

      return { status: "ONBOARDING_REQUIRED" };
    }

    // Wrong PIN
    const attempts = (session.data?.pinAttempts || 0) + 1;

    await updateSession(from, {
      data: {
        ...(session.data || {}),
        pinAttempts: attempts,
      },
    });

    await sendWhatsApp(
      from,
      "❌ Incorrect PIN. Please try again.",
      phone_number_id,
    );

    return { status: "WRONG_PIN" };
  }
}

async function sendMainMenu(to, phone_number_id) {
  await sendWhatsApp(
    to,
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: {
          text: "Here is what you can do with VIXA 👇",
        },
        footer: {
          text: "Select an action to continue",
        },
        action: {
          button: "Open Menu",
          sections: [
            {
              title: "Crypto Actions",
              rows: [
                {
                  id: "SEND_CRYPTO",
                  title: "Send Crypto",
                  description: "Send USDT, BTC, or ETH",
                },
                {
                  id: "RECIEVE_CRYPTO",
                  title: "Recieve Crypto",
                  description: "Recieve crypto in NGN",
                },
                {
                  id: "DEPOSIT_CRYPTO",
                  title: "Deposit Crypto",
                  description: "Fund your wallet",
                },
                {
                  id: "WITHDRAW_CRYPTO",
                  title: "Withdraw Crypto",
                  description: "Send crypto out",
                },
                {
                  id: "SWAP_CRYPTO",
                  title: "Swap Crypto",
                  description: "Convert between coins",
                },
                {
                  id: "GET_WALLET_BALANCE",
                  title: "See Wallet Balances",
                  description: "Check wallet balances",
                },
              ],
            },
          ],
        },
      },
    },
    phone_number_id,
  );
}

/* ------------- helper to trigger the Flow ------------- */
async function triggerFlow(toPhone, phone_number_id) {
  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log(
      "[MOCK send] to:",
      toPhone,
      "phone_number_id:",
      phone_number_id,
    );
    return;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: {
        text: "👋 Welcome to VIXA. Tap below to continue onboarding.",
      },
      action: {
        name: "flow",
        parameters: {
          flow_id: FLOW_ID,
          flow_token: toPhone, // Passing phone number as session token
          flow_cta: "Get Started",
          flow_message_version: "3",
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const debug = await res.text();
    console.error("triggerFlow failed:", res.status, debug);
    throw new Error("triggerFlow failed; check token/phone_number_id");
  }

  console.log("triggerFlow sent to", toPhone);
}

/* ------------- WA send helper (text + interactive) ------------- */
async function sendWhatsApp(to, message, phone_number_id) {
  console.log(
    "got here but could not send message becacuse whatsapp token is missing",
  );
  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log(
      "[MOCK send] to:",
      to,
      message,
      "phone_number_id:",
      phone_number_id,
    );
    return;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;

  const body =
    typeof message === "string"
      ? {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: message },
        }
      : { messaging_product: "whatsapp", to, ...message };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const debugBody = await res.text();
    console.error("sendWhatsApp failed:", res.status, debugBody);
    throw new Error("sendWhatsApp failed");
  }
}

export default router;
