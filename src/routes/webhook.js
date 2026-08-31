import express from "express";
import { getSession, updateSession } from "../services/session.service.js";
import {
  createUserOnboarding,
  notifyOnboardingStageStarted,
} from "../services/onboarding.service.js";
import { verifyNIN } from "../services/kyc.service.js";
import { verifyBVN } from "../services/bvn.service.js";
import {
  loginUser,
  checkPhoneNumber,
  restoreCachedToken,
  refreshAccessToken,
  isSessionTokenValid,
} from "../services/auth.service.js";
import { fetchAuthMe } from "../services/user.service.js";
import { depositCrypto } from "../services/deposit.service.js";
import { fetchWalletBalances } from "../services/wallet.service.js";
import { fetchReceiveWallets } from "../services/recieve.service.js";
import { humanizeError } from "../services/ai.service.js";
import { resolveIntent } from "../ai/intentRouter.js";
import {
  describeFlowState,
  clearedFlowState,
  voiceAllowed,
} from "../ai/flowState.js";
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
  fetchSupportedCountries,
  fetchPaymentChannels,
} from "../services/withdrawal.service.js";
import { confirmPayment } from "../services/confirmPayment.service.js";
import {
  fetchSendSupportedCurrencies,
  executeSendCrypto,
} from "../services/send.service.js";

import { fetchRates } from "../services/rates.service.js";
import {
  requestChangePinOtp,
  changePinRequest,
  lockWallet,
  unlockWallet,
} from "../services/changePin.service.js";
import logger from "../lib/logger.js";

import { decryptRequest, encryptResponse } from "../utils/decrypt.js";

import {
  resolveCurrencies,
  readCoin,
  normalizeCoins,
} from "../utils/apiShape.js";
import { verifyMetaSignature } from "../utils/verifySignature.js";
import { markMessageSeen } from "../utils/messageDedup.js";
import {
  downloadWhatsAppMedia,
  SLOW_TRANSCRIBE_BYTES,
} from "../utils/whatsappMedia.js";
import { transcribeAudio } from "../services/transcription.service.js";
import { normalizeSpokenText } from "../utils/spokenNumbers.js";

const router = express.Router();

// Environment configuration (Replace with environment variables in production)
// const WHATSAPP_TOKEN =
//   "EAAj9wlKZBT6ABR0ZA7xB1T7Y4ZCi81c6ZCfu0v9KKngj3rixlkkq2JLtZCIYCprLk0nnJ1tsq02sRSbSZAzZBWVEPF7ueXzZAALOKTnNB6VqOr1TAp3sKvxq14FLRSlG2kaKQpM1poznqrOnxn3blZCq7bBZBOivfN0bLXFRwnGBZBHRcOf2ltnG8oBCbNN4vjQAh8MkcGZC2ZBRLVrp2OwKJ4BBCbGDrdAf6NvNMz5DJMr4WZAfX3ZC892ZAbFr9hZCMTaSmJvCDpn1kGWBkdfwQpZCXa3ZBxM0gZDZD";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
// const FLOW_ID = "1554499149728842";
// const PIN_FLOW_ID = "1571906007827358";
// const NIN_FLOW_ID = "1520332329637155";
// const BVN_FLOW_ID = "1638175827290848";
const WHATSAPP_API_VERSION = "v25.0";

const FLOW_ID = process.env.FLOW_ID;
const PIN_FLOW_ID = process.env.PIN_FLOW_ID;
const NIN_FLOW_ID = process.env.NIN_FLOW_ID;
const BVN_FLOW_ID = process.env.BVN_FLOW_ID;
const BANK_SELECTION_FLOW_ID = process.env.BANK_SELECTION_FLOW_ID;
const COUNTRY_SELECTION_FLOW_ID = process.env.COUNTRY_SELECTION_FLOW_ID;
const ITEM_SELECTION_FLOW_ID = process.env.ITEM_SELECTION_FLOW_ID;

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
  "BTC",
  "ETH",
  "USDT",
  "USDC",
  "BNB",
  "XRP",
  "SOL",
  "TRX",
  "DOGE",
  "ADA",
  "AVAX",
  "DOT",
  "LINK",
  "TON",
  "NEAR",
  "SUI",
  "MATIC",
  "LTC",
  "BCH",
  "UNI",
];

// NOTE: these used to assume `allCurrencies` was always an array, and that
// every item keyed its ticker as `coin`. When either assumption failed,
// `.find()` threw a TypeError that only the route's outermost catch saw — so
// the user got "Sure, let me take you there!" and then nothing at all.
// readCoin() tolerates the field-name variation; the callers resolve the list
// itself via resolveCurrencies() so the real shape gets logged.
function pickPreferredCoins(allCurrencies, preferredList) {
  if (!Array.isArray(allCurrencies)) return [];
  return preferredList
    .map((symbol) => allCurrencies.find((c) => readCoin(c) === symbol))
    .filter(Boolean); // pagination handles the 10-item limit now
}

function pickPreferredToCoins(allCurrencies, preferredList, fromCoin) {
  if (!Array.isArray(allCurrencies)) return [];
  return preferredList
    .filter((symbol) => symbol !== fromCoin)
    .map((symbol) => allCurrencies.find((c) => readCoin(c) === symbol))
    .filter(Boolean); // pagination handles the 10-item limit now
}

/**
 * Shared entry for every swap-currency lookup. There are three call sites
 * (main menu, routeToFlow, and the to-coin step) that had drifted into
 * near-duplicates with different guards; this keeps them honest.
 *
 * @returns {{ coins: any[], error: string|null }}
 */
async function loadSwapCoins(fromCoin) {
  const res = await fetchSwapCurrencies();

  if (!res.success) {
    console.error(
      "loadSwapCoins: API call failed —",
      JSON.stringify(res.error)?.slice(0, 300),
    );
    return {
      coins: [],
      error:
        "⚠️ Unable to load swap currencies right now. Please try again in a moment.",
    };
  }

  const { list, reason } = resolveCurrencies(res.data, "swap/currencies");

  if (reason) {
    return {
      coins: [],
      error: "⚠️ Swap isn't available right now. Please try again shortly.",
    };
  }

  // Normalise before filtering so downstream `c.coin` reads always work.
  const normalized = normalizeCoins(list);

  const coins = fromCoin
    ? pickPreferredToCoins(normalized, PREFERRED_COINS, fromCoin)
    : pickPreferredCoins(normalized, PREFERRED_COINS);

  if (!coins.length) {
    console.error(
      `loadSwapCoins: ${list.length} currencies returned but none matched PREFERRED_COINS.`,
      "available =",
      list.map(readCoin).filter(Boolean).slice(0, 30).join(", "),
      "| preferred =",
      PREFERRED_COINS.join(", "),
    );
    return {
      coins: [],
      error: "⚠️ Swap isn't available right now. Please try again shortly.",
    };
  }

  return { coins, error: null };
}

// function isFreeText(msg, session) {
//   if (msg.type !== "text") return false;
//   if (session.data?.expectedInput) return false;
//   return true;
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
  // Reject anything Meta did not sign, BEFORE acknowledging or processing.
  // No-op until WHATSAPP_APP_SECRET is configured — see verifySignature.js.
  const signature = verifyMetaSignature(req);
  if (!signature.ok) {
    console.error(
      `Rejected unsigned webhook: ${signature.reason} (from ${req.ip})`,
    );
    logger.warn("webhook.rejected", { reason: signature.reason, ip: req.ip });
    return res.sendStatus(403);
  }

  console.log("webhook hit successfully");
  logger.info("Webhook hit");
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
          logger.debug("Status update received, ignoring");
          continue;
        }

        const messages = value.messages || [];
        for (const msg of messages) {
          const rawFrom = msg.from;
          if (!rawFrom) continue;

          const from = normalizePhone(rawFrom);
          if (!from) continue;

          // Meta redelivers webhooks it did not get a prompt 200 for — which
          // is every message that arrived while the container was down. Without
          // this, each redelivery replays the whole handler and the user gets
          // the same replies over and over, unprompted.
          if (!markMessageSeen(msg.id)) {
            console.log(`Duplicate message ${msg.id} from ${from} — skipping`);
            logger.info("webhook.duplicate", { messageId: msg.id });
            continue;
          }

          // Store phone_number_id in session for later replies
          let session = await getSession(from);
          await updateSession(from, {
            data: { ...(session.data || {}), phone_number_id },
          });

          restoreCachedToken(session.data);
          session = await getSession(from);

          // ── VOICE NOTES ────────────────────────────────────────────
          // Transcribe and rewrite into a text message so the entire
          // state machine below runs unchanged.
          if (msg.type === "audio" || msg.type === "voice") {
            if (!session.data?.authenticated) {
              await sendWhatsApp(
                from,
                "👋 Please sign in first — send me a text message to get started.",
                phone_number_id,
              );
              continue;
            }

            const preState = describeFlowState(session.data);

            if (process.env.VIXA_VOICE_ENABLED === "false") {
              await sendWhatsApp(
                from,
                "🎤 Voice notes aren't available right now — please type your message.",
                phone_number_id,
              );
              continue;
            }

            // STATE CHECK FIRST — before any bytes leave this process. A
            // user who speaks their PIN must not have it uploaded for
            // transcription.
            if (!voiceAllowed(preState)) {
              await sendWhatsApp(
                from,
                preState.sealed
                  ? "🔒 For your security I can't accept voice notes here — please type it in."
                  : "🔒 This one needs to be typed so we get it exactly right.",
                phone_number_id,
              );
              await rePromptCurrentStep(from, phone_number_id, preState);
              // logger.info("voice.refused", {
              //   messageId: msg.id,
              //   flow: preState.flow,
              //   step: preState.step,
              //   sealed: preState.sealed,
              // });
              continue;
            }

            const mediaId = msg.audio?.id || msg.voice?.id;
            const media = await downloadWhatsAppMedia(mediaId);

            if (!media) {
              await sendWhatsApp(
                from,
                "⚠️ I couldn't open that voice note. Please try again, or type your message.",
                phone_number_id,
              );
              continue;
            }

            // duration isn't in Meta's payload; file size is the proxy.
            if (media.fileSize > SLOW_TRANSCRIBE_BYTES) {
              await sendWhatsApp(
                from,
                "🎧 One sec, listening...",
                phone_number_id,
              );
            }

            const t = await transcribeAudio(media);

            if (!t.success) {
              await sendWhatsApp(
                from,
                "🎧 Sorry, I couldn't make that out. Please try again, or type it.",
                phone_number_id,
              );
              logger.warn?.("voice.failed", {
                messageId: msg.id,
                reason: t.reason,
              });
              continue;
            }

            const spoken = normalizeSpokenText(t.text);
            console.log(`[voice] ${from}: "${t.text}" → "${spoken}"`);
            logger.info("voice.transcribed", {
              messageId: msg.id,
              flow: preState.flow,
              step: preState.step,
              chars: spoken.length,
            });

            // Rewrite. Everything downstream is untouched.
            msg.type = "text";
            msg.text = { body: spoken };
            msg._fromVoice = true;
          }

          const isFlowReply =
            msg.type === "interactive" && msg.interactive?.type === "nfm_reply";

          const isInteractiveReply =
            msg.type === "interactive" &&
            (msg.interactive?.type === "button_reply" ||
              msg.interactive?.type === "list_reply");

          if (
            !isFlowReply &&
            !isInteractiveReply &&
            session.data?.authenticated &&
            !isSessionTokenValid(session.data)
          ) {
            if (!session.data?.awaitingPin) {
              console.log(
                `Token expired for ${from}. Attempting silent refresh...`,
              );

              const refreshTokenStillValid = session.data?.refreshTokenExpiresAt
                ? Date.now() < session.data.refreshTokenExpiresAt
                : !!session.data?.refreshToken;

              if (session.data?.refreshToken && refreshTokenStillValid) {
                const refreshResult = await refreshAccessToken({
                  phoneNumber: from,
                  refreshToken: session.data.refreshToken,
                });

                if (refreshResult.success) {
                  console.log(
                    `Silent refresh succeeded for ${from}. Continuing.`,
                  );
                  session = await getSession(from);
                  restoreCachedToken(session.data);
                  // fall through to normal message processing
                } else {
                  console.log(
                    `Silent refresh failed for ${from}. Requesting PIN.`,
                  );
                  await updateSession(from, {
                    data: {
                      ...session.data,
                      authenticated: false,
                      awaitingPin: true,
                      pinAttempts: 0,
                      pendingDeposit: false,
                      awaitingDepositConfirmation: false,
                      awaitingDepositPin: false,
                      swap: null,
                      send: null,
                      withdraw: null,
                      receive: null,
                    },
                  });
                  await triggerPinFlow(from, phone_number_id, "LOGIN");
                  continue;
                }
              } else {
                console.log(
                  `No valid refresh token for ${from}. Requesting PIN.`,
                );
                await updateSession(from, {
                  data: {
                    ...session.data,
                    authenticated: false,
                    awaitingPin: true,
                    pinAttempts: 0,
                    pendingDeposit: false,
                    awaitingDepositConfirmation: false,
                    awaitingDepositPin: false,
                    swap: null,
                    send: null,
                    withdraw: null,
                    receive: null,
                  },
                });
                await triggerPinFlow(from, phone_number_id, "LOGIN");
                continue;
              }
            }
          }

          // --- FIX: Detect and process Flow Submission (nfm_reply) ---
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

            // SWAP FROM pagination
            if (actionId.startsWith("SWAP_FROM_PAGE_")) {
              const nextPage = parseInt(
                actionId.replace("SWAP_FROM_PAGE_", ""),
                10,
              );
              const coinsList = session.data?.swap?.allCoins || [];

              if (!coinsList.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ Session expired. Please start over.",
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: { ...session.data.swap, currentFromPage: nextPage },
                },
              });

              await sendPaginatedSwapCoinsMenu(
                from,
                phone_number_id,
                coinsList,
                nextPage,
                "FROM",
              );
              return;
            }

            // SWAP TO pagination
            if (actionId.startsWith("SWAP_TO_PAGE_")) {
              const nextPage = parseInt(
                actionId.replace("SWAP_TO_PAGE_", ""),
                10,
              );
              const toCoins = session.data?.swap?.toCoins || [];

              if (!toCoins.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ Session expired. Please start over.",
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: { ...session.data.swap, currentToPage: nextPage },
                },
              });

              await sendPaginatedSwapCoinsMenu(
                from,
                phone_number_id,
                toCoins,
                nextPage,
                "TO",
              );
              return;
            }

            if (actionId.startsWith("SWAP_FROM_")) {
              const coin = actionId.replace("SWAP_FROM_", "");
              const selected = session.data.swap.allCoins.find(
                (c) => c.coin === coin,
              );

              if (!selected) {
                await sendWhatsApp(
                  from,
                  "⚠️ Coin not found. Please start over.",
                  phone_number_id,
                );
                return;
              }

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
              const toLimits = session.data.swap.toCoins.find(
                (c) => c.coin === toCoin,
              );
              const { amount } = session.data.swap;

              // // 🔴 CRITICAL RULE
              // if (amount < toLimits.minAmount || amount > toLimits.maxAmount) {
              //   await sendWhatsApp(
              //     from,
              //     `❌ Amount not supported for ${toCoin}. Range: ${toLimits.minAmount} - ${toLimits.maxAmount}`,
              //     phone_number_id,
              //   );
              //   return;
              // }

              const quote = await fetchSwapQuote({
                fromCoin: session.data.swap.fromCoin,
                toCoin,
                fromAmount: amount,
              });

              console.log(quote, "qouteres");

              if (!quote.success) {
                const rawError = quote.error?.message || "Unknown server error";
                const friendlyMessage = await humanizeError(
                  rawError,
                  "get a swap quote",
                );
                await sendWhatsApp(from, friendlyMessage, phone_number_id);
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
              await triggerPinFlow(from, phone_number_id, "SWAP");
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

            // 🆕 PAGINATION INTERCEPTOR: Catch "See More" clicks first
            if (actionId === "WITHDRAW_COUNTRY_NEXT_PAGE") {
              // 1. Calculate the next page number
              const nextPage = (session.data.withdraw?.currentPage || 0) + 1;
              const fullList = session.data.withdraw?.countriesList || [];

              if (fullList.length === 0) {
                await sendWhatsApp(
                  from,
                  "⚠️ Session expired. Please start over.",
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
                return;
              }

              // 2. Update the page number in session
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: { ...session.data.withdraw, currentPage: nextPage },
                },
              });

              // 3. Send the next chunk
              await sendPaginatedCountriesMenu(
                from,
                phone_number_id,
                fullList,
                nextPage,
              );
              return;
            }

            // 🆕 SPECIFIC COUNTRY SELECTION HANDLER
            if (actionId.startsWith("WITHDRAW_COUNTRY_")) {
              const countryCode = actionId.replace("WITHDRAW_COUNTRY_", "");

              // await sendWhatsApp(
              //   from,
              //   "⏳ Loading payment channels...",
              //   phone_number_id,
              // );

              // 1. Fetch channels dynamically for selected country
              const channelsRes = await fetchPaymentChannels(
                countryCode,
                "withdraw",
              );
              console.log(countryCode, channelsRes, "channelsRes");
              if (!channelsRes.success || !channelsRes.data?.items?.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ No payment channels available for this country currently.",
                  phone_number_id,
                );
                return;
              }

              // 2. Grab the first channel ID
              const items = channelsRes.data.items;
              const momoChannel = items.find(
                (c) => c.channelType?.toLowerCase() === "momo",
              );
              const selectedChannel = momoChannel || items[0];

              console.log(
                `Selected channel for ${countryCode}:`,
                selectedChannel.id,
                selectedChannel.channelType,
              );

              // 3. Save both to session
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    countryCode,
                    channelId: selectedChannel.id,
                    step: "SELECT_WITHDRAW_TYPE",
                  },
                },
              });

              await sendWithdrawTypeMenu(from, phone_number_id);
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
                // The reason was previously swallowed — log it so the next
                // occurrence is diagnosable from Seq rather than a screenshot.
                console.error(
                  "SEND: /crypto/supported-currencies failed —",
                  JSON.stringify(coinsRes.error)?.slice(0, 400),
                );
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to load supported coins right now. Please try again shortly.",
                  phone_number_id,
                );
                return;
              }

              const { list: rawCoins, reason: coinsReason } = resolveCurrencies(
                coinsRes.data,
                "crypto/supported-currencies",
              );

              const coins = normalizeCoins(rawCoins);

              if (coinsReason || !coins.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ No coins are available to send right now. Please try again shortly.",
                  phone_number_id,
                );
                return;
              }

              const uniqueCoins = Array.from(
                new Map(coins.map((c) => [c.coin, c])).values(),
              );

              await updateSession(from, {
                data: {
                  ...session.data,
                  send: { step: "SELECT_COIN", type, coins },
                },
              });

              await triggerItemSelectionFlow(from, phone_number_id, {
                context: "SEND_COIN",
                items: uniqueCoins.map((c) => ({
                  id: c.coin,
                  title: c.coin,
                  description:
                    type === "P2P"
                      ? "Send to Vixa user"
                      : `${c.chains?.length || 1} network(s)`,
                })),
                bodyText: "📤 Select the coin you want to send",
                heading: "Select coin to send",
                label: "Coin",
                cta: "Select Coin",
              });

              return;
            }
            // --- WITHDRAWAL: TYPE & COIN & BANK SELECTION ---
            if (actionId === "WITHDRAW_TYPE_USDT") {
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    coin: "USDT",
                    step: "ENTER_AMOUNT",
                  },
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

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: { ...session.data.withdraw, step: "SELECT_COIN" },
                },
              });

              await triggerItemSelectionFlow(from, phone_number_id, {
                context: "WITHDRAW_COIN",
                items: balances.map((b) => ({
                  id: b.coin,
                  title: b.coin,
                  description: `Bal: ${b.balance}`,
                })),
                bodyText: "Select the coin you want to withdraw",
                heading: "Select a coin to withdraw",
                label: "Coin",
                cta: "Select Coin",
              });
              return;
            }

            if (actionId.startsWith("WITHDRAW_COIN_")) {
              const coin = actionId.replace("WITHDRAW_COIN_", "");
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    coin,
                    step: "ENTER_AMOUNT",
                  },
                },
              });
              await sendWhatsApp(
                from,
                `💰 Please enter the amount of *${coin}* you want to withdraw:`,
                phone_number_id,
              );
              return;
            }

            // BANK pagination
            if (actionId === "WITHDRAW_BANK_NEXT_PAGE") {
              const nextPage =
                (session.data.withdraw?.currentBankPage || 0) + 1;
              const fullList = session.data.withdraw?.banks || [];

              if (!fullList.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ Session expired. Please start over.",
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    currentBankPage: nextPage,
                  },
                },
              });

              await sendPaginatedBanksMenu(
                from,
                phone_number_id,
                fullList,
                nextPage,
              );
              return;
            }

            if (actionId === "LOCK_WALLET") {
              await updateSession(from, {
                data: {
                  ...session.data,
                  lockWallet: { step: "ENTER_REASON" },
                },
              });
              await sendWhatsApp(
                from,
                "🔒 *Lock Wallet*\n\nPlease tell us the reason you want to lock your wallet:\n\n(e.g. Lost phone, Suspicious activity, Going on vacation)",
                phone_number_id,
              );
              return;
            }

            if (actionId === "UNLOCK_WALLET") {
              // Immediately request OTP before asking anything
              const otpRes = await requestChangePinOtp("UnlockWallet");

              if (!otpRes.success) {
                const friendly = await humanizeError(
                  otpRes.error?.message || "Unknown error",
                  "request an OTP to unlock wallet",
                );
                await sendWhatsApp(from, friendly, phone_number_id);
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  unlockWallet: { step: "ENTER_OTP" },
                },
              });

              await sendWhatsApp(
                from,
                "🔓 *Unlock Wallet*\n\nAn OTP has been sent to your Email Address.\n\nPlease type the OTP here to continue:",
                phone_number_id,
              );
              return;
            }

            if (actionId === "CHANGE_PIN") {
              await updateSession(from, {
                data: {
                  ...session.data,
                  changePin: { step: "ENTER_CURRENT_PIN" },
                },
              });
              await triggerPinFlow(
                from,
                phone_number_id,
                "CHANGE_PIN_CURRENT",
                "🔐 Enter your *current PIN* to begin the change:",
              );
              return;
            }

            if (actionId.startsWith("WITHDRAW_BANK_")) {
              const networkId = actionId.replace("WITHDRAW_BANK_", "");
              // Retrieve bank name from session cache
              const bankName =
                session.data.withdraw.banks.find((b) => b.id === networkId)
                  ?.name || "Selected Bank";

              const isNigeria = session.data.withdraw?.countryCode === "NG";

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    networkId,
                    bankName,
                    step: isNigeria
                      ? "ENTER_ACCOUNT_NUMBER"
                      : "ENTER_ACCOUNT_NUMBER_OTHER",
                  },
                },
              });
              // await sendWhatsApp(
              //   from,
              //   `🏦 You selected *${bankName}*.\n\nPlease enter your 10-digit Account Number:`,
              //   phone_number_id,
              // );
              if (isNigeria) {
                await sendWhatsApp(
                  from,
                  `🏦 You selected *${bankName}*.\n\nPlease enter your 10-digit Account Number:`,
                  phone_number_id,
                );
              } else {
                await sendWhatsApp(
                  from,
                  `🏦 You selected *${bankName}*.\n\nPlease enter your *Account Number*:`,
                  phone_number_id,
                );
              }
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

                // NOTE: the coin lookup that used to live here was dead — every
                // line that consumed it is commented out below, and the coins
                // are actually loaded by the SEND_TYPE_P2P / SEND_TYPE_EXTERNAL
                // handler once the user picks a recipient type. All it did was
                // fire a pointless request and, when that request failed, emit
                // a spurious "Unable to load supported coins" right after the
                // recipient menu had rendered fine.

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

                const uniqueCoins = [...new Set(wallets.map((w) => w.coin))];

                await updateSession(from, {
                  data: {
                    ...session.data,
                    receive: { step: "SELECT_COIN", wallets },
                  },
                });

                await triggerItemSelectionFlow(from, phone_number_id, {
                  context: "RECEIVE_COIN",
                  items: uniqueCoins.map((coin) => ({
                    id: coin,
                    title: coin,
                    description: `Receive ${coin}`,
                  })),
                  bodyText: "📥 Select the coin you want to receive",
                  heading: "Select coin to receive",
                  label: "Coin",
                  cta: "Select Coin",
                });

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
                  // Initialize the withdraw object
                  await updateSession(from, {
                    data: {
                      ...session.data,
                      withdraw: { step: "SELECT_WITHDRAW_REGION" },
                    },
                  });

                  await sendWhatsApp(
                    from,
                    {
                      type: "interactive",
                      interactive: {
                        type: "button",
                        body: { text: "📍 Where are you withdrawing to?" },
                        action: {
                          buttons: [
                            {
                              type: "reply",
                              reply: {
                                id: "WITHDRAW_REGION_NG",
                                title: "🇳🇬 Nigeria",
                              },
                            },
                            {
                              type: "reply",
                              reply: {
                                id: "WITHDRAW_REGION_OTHER",
                                title: "🌍 Other Countries",
                              },
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
                // This path previously had no empty-list guard, so a failed
                // lookup sent an item-selection flow with zero rows — the
                // blank "Coin" picker.
                const { coins: selectedCoins, error: swapErr } =
                  await loadSwapCoins();

                if (swapErr) {
                  await sendWhatsApp(from, swapErr, phone_number_id);
                  break;
                }

                await updateSession(from, {
                  data: {
                    ...(session.data || {}),
                    swap: {
                      step: "SELECT_FROM",
                      allCoins: selectedCoins,
                    },
                  },
                });

                await triggerItemSelectionFlow(from, phone_number_id, {
                  context: "SWAP_FROM",
                  items: selectedCoins.map((c) => ({
                    id: c.coin,
                    title: c.coin,
                    description: `Min: ${c.minAmount}, Max: ${c.maxAmount}`,
                  })),
                  bodyText: "🔄 Select the coin you want to swap from",
                  heading: "Select the coin you want to swap from",
                  label: "Coin",
                  cta: "Select Coin",
                });
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
              case "CONTACT_SUPPORT": {
                await sendWhatsApp(
                  from,
                  `🛟 *VIXA Support*\n\nNeed help? Reach us via:\n\n📧 *Email:* usevixa@gmail.com\n\nPlease include your registered phone number when contacting support.\n\nWhat else can I help you with?`,
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
                break;
              }
              case "SETTINGS": {
                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "list",
                      body: {
                        text: "⚙️ *Settings*\n\nWhat would you like to do?",
                      },
                      action: {
                        button: "Select Option",
                        sections: [
                          {
                            title: "Account Settings",
                            rows: [
                              {
                                id: "CHANGE_PIN",
                                title: "Change PIN",
                                description: "Update your 4-digit PIN",
                              },
                              {
                                id: "LOCK_WALLET",
                                title: "Lock Wallet",
                                description: "Lock your wallet access",
                              },
                              {
                                id: "UNLOCK_WALLET",
                                title: "Unlock Wallet",
                                description: "Restore your wallet access",
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
            }

            continue;
          }

          // 2.5 BUTTON REPLIES (Used for Yes/No Confirmations)
          if (
            msg.type === "interactive" &&
            msg.interactive?.type === "button_reply"
          ) {
            const actionId = msg.interactive.button_reply.id;

            // "Have Paid" is sent as an interactive *button* (see the DEPOSIT
            // PIN handler), so it arrives here — it used to be handled only in
            // the list_reply block above, where it could never match, and the
            // tap did nothing at all.
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

            // The "Try Again" button on a rejected/failed NIN had no handler,
            // so it was inert — re-open the NIN flow.
            if (actionId === "NIN_RETRY") {
              await triggerNINFlow(from, phone_number_id);
              return;
            }

            // 🆕 REGION BUTTON REPLIES
            if (actionId === "WITHDRAW_REGION_NG") {
              // await sendWhatsApp(
              //   from,
              //   "⏳ Loading payment channels...",
              //   phone_number_id,
              // );

              // 1. Fetch channels dynamically for NG
              const channelsRes = await fetchPaymentChannels("NG", "withdraw");
              console.log(channelsRes);
              if (!channelsRes.success || !channelsRes.data?.items?.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ No payment channels available for Nigeria currently.",
                  phone_number_id,
                );
                return;
              }

              // 2. Grab the first channel ID
              const firstChannel = channelsRes.data.items[0];

              // 3. Save both to session
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    countryCode: "NG",
                    channelId: firstChannel.id,
                    step: "SELECT_WITHDRAW_TYPE",
                  },
                },
              });
              await sendWithdrawTypeMenu(from, phone_number_id);
              return;
            }

            if (actionId === "WITHDRAW_REGION_OTHER") {
              const countriesRes = await fetchSupportedCountries("africa");

              if (!countriesRes.success || !countriesRes.data.length) {
                const rawError =
                  countriesRes.error?.message || "Unknown server error";
                const friendlyMessage = await humanizeError(
                  rawError,
                  "load supported countries",
                );
                await sendWhatsApp(from, friendlyMessage, phone_number_id);
                return;
              }

              // countriesList feeds the WITHDRAW_COUNTRY_* handler; currentPage
              // drives the "See More" pages of sendPaginatedCountriesMenu.
              // countriesList feeds the ::COUNTRY_SELECT handler in
              // processFlowCompletion once the Flow comes back.
              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    step: "SELECT_COUNTRY",
                    countriesList: countriesRes.data,
                    currentPage: 0,
                  },
                },
              });

              // The Flow gives one scrollable dropdown instead of nine rows
              // at a time. It previously failed with #131009 because the Flow
              // behind COUNTRY_SELECTION_FLOW_ID was still Meta's default
              // WELCOME_SCREEN template — if that recurs, the send returns
              // false and we fall back to the list rather than sending
              // nothing at all.
              const countryFlowSent = await triggerCountrySelectionFlow(
                from,
                phone_number_id,
                countriesRes.data,
              );

              if (!countryFlowSent) {
                await sendPaginatedCountriesMenu(
                  from,
                  phone_number_id,
                  countriesRes.data,
                  0,
                );
              }
              return;
            }

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

            // if (actionId === "QUOTE_CONFIRM_YES") {
            //   const countryCode = session.data.withdraw?.countryCode || "ng";
            //   const channelId = session.data.withdraw?.channelId;
            //   const banksRes = await fetchBanks(countryCode, channelId);
            //   if (!banksRes.success || !banksRes.data.length) {
            //     await sendWhatsApp(
            //       from,
            //       "⚠️ Unable to load banks right now. Please try again later.",
            //       phone_number_id,
            //     );
            //     return;
            //   }

            //   const allBanks = banksRes.data;

            //   await updateSession(from, {
            //     data: {
            //       ...session.data,
            //       withdraw: {
            //         ...session.data.withdraw,
            //         banks: allBanks, // full list saved to session
            //         currentBankPage: 0, // start on page 0
            //         step: "SELECT_BANK",
            //       },
            //     },
            //   });

            //   await sendPaginatedBanksMenu(from, phone_number_id, allBanks, 0);
            //   return;
            // }

            if (actionId === "QUOTE_CONFIRM_YES") {
              const countryCode = session.data.withdraw?.countryCode || "ng";
              const channelId = session.data.withdraw?.channelId;
              const banksRes = await fetchBanks(countryCode, channelId);
              if (!banksRes.success || !banksRes.data.length) {
                await sendWhatsApp(
                  from,
                  "⚠️ Unable to load banks right now. Please try again later.",
                  phone_number_id,
                );
                return;
              }

              const allBanks = banksRes.data;

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    banks: allBanks,
                    currentBankPage: 0,
                    step: "SELECT_BANK",
                  },
                },
              });

              const bankFlowSent = await triggerBankSelectionFlow(
                from,
                phone_number_id,
                allBanks,
              );

              // If Meta rejects the Flow send — the failure mode that took the
              // country picker down — fall back to the list menu rather than
              // leaving the user with no reply.
              if (!bankFlowSent) {
                await sendPaginatedBanksMenu(
                  from,
                  phone_number_id,
                  allBanks,
                  0,
                );
              }
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
              // await sendWhatsApp(
              //   from,
              //   "🔐 Enter your *4-digit PIN* to execute this withdrawal:",
              //   phone_number_id,
              // );
              await triggerPinFlow(from, phone_number_id, "WITHDRAW_EXECUTE");
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

            let rawText = msg.text?.body?.trim();

            // ==========================================
            // 1. THE AUTHENTICATION & ONBOARDING GATE
            // (Strictly handles first-time or returning unauthenticated users)
            // ==========================================

            // A. Is the user currently trying to log in?
            //
            // A typed PIN is never accepted — not here, not anywhere. This
            // used to hand rawText straight to handleAuthenticationGate,
            // which called loginUser() with it, so the login PIN was the one
            // PIN in the app that still worked in plaintext. The real login
            // happens in handlePinFlowSubmission's LOGIN case, after the
            // Flow comes back. Re-open that Flow instead.
            if (session.data?.awaitingPin) {
              const loginState = describeFlowState(session.data);

              await sendWhatsApp(
                from,
                /^\d{4,8}$/.test(rawText || "")
                  ? "🔒 For your security, please use the *Enter PIN* button rather than typing it here.\n\nI'd also delete that message from this chat."
                  : "🔐 Please use the *Enter PIN* button below to sign in.",
                phone_number_id,
              );
              await rePromptCurrentStep(from, phone_number_id, loginState);
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
                // await sendWhatsApp(
                //   from,
                //   "🔐 Welcome back to VIXA!\n\nPlease enter your *4-digit PIN* to continue.",
                //   phone_number_id,
                // );
                await triggerPinFlow(from, phone_number_id, "LOGIN");
              } else {
                // User does not exist -> Trigger Onboarding
                notifyOnboardingStageStarted(from, phone_number_id);
                await triggerFlow(from, phone_number_id);
              }
              // Stop processing. Do not pass to AI.
              return;
            }

            // ==========================================
            // 2. THE AI IN-FLOW INTERCEPTOR
            // (Only runs if session.data.authenticated === true)
            // ==========================================

            // const aiAnalysis = await analyzeUserIntent(rawText, session.data);
            // console.log("AI Intent:", aiAnalysis.intent);

            // // A. Handle Chit-chat or Confusion
            // if (aiAnalysis.intent === "CHITCHAT_OR_CLARIFY") {
            //   await sendWhatsApp(
            //     from,
            //     aiAnalysis.replyMessage,
            //     phone_number_id,
            //   );
            //   return;
            // }

            // // B. Handle Flow Cancellations
            // if (aiAnalysis.intent === "CANCEL_FLOW") {
            //   await updateSession(from, {
            //     data: {
            //       ...session.data,
            //       pendingDeposit: false,
            //       awaitingDepositPin: false,
            //       swap: null,
            //       send: null,
            //       withdraw: null,
            //       receive: null,
            //     },
            //   });
            //   await sendWhatsApp(
            //     from,
            //     "Okay, I've canceled that for you.",
            //     phone_number_id,
            //   );
            //   await sendMainMenu(from, phone_number_id);
            //   return;
            // }

            // // C. Handle new menu requests
            // if (aiAnalysis.intent === "START_NEW_FLOW") {
            //   await sendMainMenu(from, phone_number_id);
            //   return;
            // }

            // ═══════════════════════════════════════════════════════════
            // UNIFIED INTENT ROUTER
            //
            // Every text message from an authenticated user passes through
            // here exactly once — mid-flow or not. See src/ai/intentRouter.js
            // for the pipeline. Only PROVIDE_INPUT falls through to the state
            // machine below; everything else is answered and returns.
            // ═══════════════════════════════════════════════════════════
            const flowState = describeFlowState(session.data);
            const isInActiveFlow = flowState.active;

            // ── A pending "abandon this transaction?" question wins ──
            if (session.data?.pendingSwitch) {
              const pending = session.data.pendingSwitch;
              const answer = (rawText || "").toLowerCase();

              await updateSession(from, {
                data: { ...session.data, pendingSwitch: null },
              });
              session = await getSession(from);

              if (
                /^(y|yes|yeah|yea|yep|ok|okay|sure|go ahead|proceed|do it)$/.test(
                  answer,
                )
              ) {
                await startFlow(pending.flow, from, phone_number_id, {
                  ack: `👍 Cancelled. Taking you to ${humanFlowName(pending.flow)} 👇`,
                });
                return;
              }

              if (/^(n|no|nope|nah|stay|keep going)$/.test(answer)) {
                await sendWhatsApp(
                  from,
                  "👍 No problem — let's finish what you started.",
                  phone_number_id,
                );
                await rePromptCurrentStep(from, phone_number_id, flowState);
                return;
              }
              // Anything else: don't trap them in a yes/no loop — fall
              // through and interpret the message normally.
            }

            // ── Confirming an amount we heard in a voice note ──
            if (session.data?.pendingVoiceAmount) {
              const pending = session.data.pendingVoiceAmount;
              const answer = (rawText || "").toLowerCase();

              await updateSession(from, {
                data: { ...session.data, pendingVoiceAmount: null },
              });
              session = await getSession(from);

              if (
                /^(y|yes|yeah|yea|yep|ok|okay|sure|correct|that's right|go ahead)$/.test(
                  answer,
                )
              ) {
                // Fall through with the confirmed value. rawText must move
                // too, or resolveIntent below still classifies "yes".
                msg.text.body = pending.value;
                rawText = pending.value;
                // Already confirmed — must not re-enter the echo gate.
                msg._fromVoice = false;
              } else if (/^(n|no|nope|nah|wrong|not right)$/.test(answer)) {
                await sendWhatsApp(
                  from,
                  "👍 No problem — please type the amount instead.",
                  phone_number_id,
                );
                await rePromptCurrentStep(from, phone_number_id, flowState);
                return;
              }
              // Anything else: not a yes/no — interpret it normally.
            }

            const decision = await resolveIntent({
              text: rawText,
              sessionData: session.data,
              profile: { firstName: session.data?.firstName },
            });

            // ── Language: detect ONCE, then leave it alone ──────────
            //
            // Set on the first substantive message and never re-detected.
            // Users code-switch constantly, so per-message detection would
            // flip the bot's language halfway through a withdrawal.
            //
            // Deliberately NOT added to clearedFlowState — a language is a
            // preference, not flow state, and must survive a cancel.
            //
            // INSTRUMENTATION ONLY for now: nothing reads session.data.lang
            // to choose copy yet. It's here so the logs tell us which
            // languages are worth translating for.
            const LANG_CONFIDENCE_FLOOR = 0.8;

            if (
              !session.data?.lang &&
              decision.language &&
              decision.language !== "en" &&
              decision.languageConfidence >= LANG_CONFIDENCE_FLOOR
            ) {
              await updateSession(from, {
                data: { ...session.data, lang: decision.language },
              });
              session = await getSession(from);
              logger.info("language.detected", {
                lang: decision.language,
                confidence: decision.languageConfidence,
              });
            }

            console.log(
              `[intent] "${rawText}" → ${decision.type}` +
                `${decision.flow ? `/${decision.flow}` : ""}` +
                ` (via ${decision.source}, conf ${decision.confidence})` +
                ` | state: ${flowState.flow || "NONE"}/${flowState.step || "-"}`,
            );

            // Structured so intent quality is measurable in Seq rather than
            // something we only discover from screenshots. Message text is
            // deliberately omitted when the step is sealed.
            logger.info("intent.resolved", {
              decisionType: decision.type,
              decisionFlow: decision.flow,
              source: decision.source,
              confidence: decision.confidence,
              currentFlow: flowState.flow,
              currentStep: flowState.step,
              sealed: flowState.sealed,
              sessionLang: session.data?.lang || "en",
              detectedLang: decision.language,
              detectedLangConfidence: decision.languageConfidence,
              text: flowState.sealed ? "[redacted]" : rawText,
            });

            if (decision.type === "ANSWER" || decision.type === "CLARIFY") {
              await sendWhatsApp(
                from,
                decision.reply ||
                  "I'm here to help with your VIXA wallet — what would you like to do?",
                phone_number_id,
              );

              // A CLARIFY tied to a flow is a yes/no question — remember it.
              if (decision.type === "CLARIFY" && decision.flow) {
                await updateSession(from, {
                  data: {
                    ...session.data,
                    pendingSwitch: { flow: decision.flow },
                  },
                });
                return;
              }

              // Answering a question must never cost the user their place.
              if (isInActiveFlow) {
                await rePromptCurrentStep(from, phone_number_id, flowState);
              } else {
                await sendMainMenu(from, phone_number_id);
              }
              return;
            }

            if (decision.type === "MENU") {
              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (decision.type === "CANCEL") {
              if (!isInActiveFlow) {
                await sendWhatsApp(
                  from,
                  "👍 There's nothing running right now.",
                  phone_number_id,
                );
                await sendMainMenu(from, phone_number_id);
                return;
              }

              await updateSession(from, {
                data: clearedFlowState(session.data),
              });
              await sendWhatsApp(
                from,
                "Okay, I've cancelled that for you. 👍",
                phone_number_id,
              );
              await sendMainMenu(from, phone_number_id);
              return;
            }

            if (decision.type === "SWITCH_FLOW") {
              if (!decision.flow) {
                await sendMainMenu(from, phone_number_id);
                return;
              }

              // Already in the flow they're asking for — re-show the step
              // instead of restarting and losing their progress.
              if (isInActiveFlow && flowState.flow === decision.flow) {
                if (flowState.rePrompt) {
                  await rePromptCurrentStep(from, phone_number_id, flowState);
                } else {
                  await sendWhatsApp(
                    from,
                    "You're already on it — please continue above 👆",
                    phone_number_id,
                  );
                }
                return;
              }

              // Money is one confirmation away. Never bin that silently.
              if (isInActiveFlow && flowState.committed) {
                await updateSession(from, {
                  data: {
                    ...session.data,
                    pendingSwitch: { flow: decision.flow },
                  },
                });
                await sendWhatsApp(
                  from,
                  `⚠️ You have a ${humanFlowName(flowState.flow)} waiting to be completed.\n\n` +
                    `Cancel it and start a ${humanFlowName(decision.flow)} instead? Reply *yes* or *no*.`,
                  phone_number_id,
                );
                return;
              }

              await startFlow(decision.flow, from, phone_number_id, {
                ack: isInActiveFlow
                  ? `Sure — cancelling that. Taking you to ${humanFlowName(decision.flow)} 👇`
                  : null,
              });
              return;
            }

            // PROVIDE_INPUT falls through to the state machine below. Use the
            // router's normalised value so "5k" and "₦20,000" reach the same
            // parseFloat() calls as "5000" and "20000".
            if (
              decision.type === "PROVIDE_INPUT" &&
              decision.value &&
              msg.text
            ) {
              // A misheard amount is silent and expensive — "fifty" heard as
              // "fifteen" on a withdrawal. Confirm before acting.
              if (msg._fromVoice && flowState.expecting === "amount") {
                await updateSession(from, {
                  data: {
                    ...session.data,
                    pendingVoiceAmount: { value: decision.value },
                  },
                });
                await sendWhatsApp(
                  from,
                  `I heard: *${Number(decision.value).toLocaleString("en-NG")}*.\n\nReply *yes* to continue, or *no* to type it again.`,
                  phone_number_id,
                );
                return;
              }
              msg.text.body = decision.value;
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

              const MIN_DEPOSIT_NGN = 500;
              const MAX_DEPOSIT_NGN = 30_000_000;
              if (amountNgn < MIN_DEPOSIT_NGN || amountNgn > MAX_DEPOSIT_NGN) {
                await sendWhatsApp(
                  from,
                  `⚠️ Deposit must be between ₦${MIN_DEPOSIT_NGN.toLocaleString()} and ₦${MAX_DEPOSIT_NGN.toLocaleString()}. Please enter a new amount.`,
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
                      timeZone: "Africa/Lagos",
                    },
                  )
                : "Just now";

              const rateMessage = `
💱 *Current Exchange Rate*

• Currency Pair: ${rateData.data.data.fromCurrency} → ${rateData.data.data.toCurrency}
• Buy Rate: ${rateData.data.data.buyRate}
• Sell Rate: ${rateData.data.data.sellRate}
• Base Rate: ${rateData.data.data.baseRate}

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

              await triggerPinFlow(from, phone_number_id, "DEPOSIT");
              return;
            }

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

              const fromCoin = session.data.swap.fromCoin;
              // This site had no success check at all: a failed lookup left
              // toCoins empty and shipped an item picker with zero rows.
              const { coins: toCoins, error: toErr } =
                await loadSwapCoins(fromCoin);

              if (toErr) {
                await sendWhatsApp(from, toErr, phone_number_id);
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  swap: {
                    ...session.data.swap,
                    step: "SELECT_TO",
                    amount,
                    toCoins,
                  },
                },
              });

              await triggerItemSelectionFlow(from, phone_number_id, {
                context: "SWAP_TO",
                items: toCoins.map((c) => ({
                  id: c.coin,
                  title: c.coin,
                  description: `Min: ${c.minAmount}, Max: ${c.maxAmount}`,
                })),
                bodyText: "➡️ Select the coin you want to receive",
                heading: "Select the coin you want to receive",
                label: "Coin",
                cta: "Select Coin",
              });
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

              // await sendWhatsApp(
              //   from,
              //   "🔐 Enter your *PIN* to confirm this transfer",
              //   phone_number_id,
              // );
              await triggerPinFlow(from, phone_number_id, "SEND");

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

              // await sendWhatsApp(
              //   from,
              //   "🔐 Enter your *PIN* to confirm this transfer",
              //   phone_number_id,
              // );
              await triggerPinFlow(from, phone_number_id, "SEND");

              return;
            }

            // if (session.data?.send?.step === "ENTER_PIN") {
            //   const pin = msg.text?.body?.trim();

            //   if (!pin || pin.length < 4) {
            //     await sendWhatsApp(
            //       from,
            //       "⚠️ Enter a valid PIN.",
            //       phone_number_id,
            //     );
            //     return;
            //   }

            //   const { coin, amount, address, chain, type } = session.data.send;

            //   // WhatsApp number of sender
            //   const userPhone = from;

            //   const sendRes = await executeSendCrypto({
            //     type,
            //     coin,
            //     chain: chain?.chain,
            //     amount,
            //     phoneNumber: userPhone,
            //     externalAddress: address,
            //     pin,
            //   });

            //   console.log(sendRes, "checking send crypto");

            //   if (!sendRes.success) {
            //     const rawError =
            //       sendRes.error?.message || "Unknown server error";
            //     const friendlyMessage = await humanizeError(
            //       rawError,
            //       "send crypto to an external address",
            //     );

            //     await sendWhatsApp(from, friendlyMessage, phone_number_id);
            //     return;
            //   }

            //   await sendWhatsApp(
            //     from,
            //     `✅ *Transfer Successful!*\n\n` +
            //       `${amount} ${coin} sent\n` +
            //       `To: ${address}\n\n` +
            //       `🚀 Transaction submitted`,
            //     phone_number_id,
            //   );

            //   // Reset send state
            //   await updateSession(from, {
            //     data: {
            //       ...session.data,
            //       send: null,
            //     },
            //   });

            //   await sendWhatsApp(
            //     from,
            //     "What would you like to do next?",
            //     phone_number_id,
            //   );

            //   await sendMainMenu(from, phone_number_id);
            //   return;
            // }

            // --- LOCK WALLET FLOW ---
            if (session.data?.lockWallet?.step === "ENTER_REASON") {
              const reason = rawText;

              if (!reason || reason.length < 3) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please provide a reason (at least 3 characters).",
                  phone_number_id,
                );
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  lockWallet: {
                    ...session.data.lockWallet,
                    reason,
                    step: "ENTER_PIN",
                  },
                },
              });

              await triggerPinFlow(
                from,
                phone_number_id,
                "LOCK_WALLET",
                "🔒 Enter your *PIN* to confirm locking your wallet:",
              );
              return;
            }

            // --- UNLOCK WALLET FLOW ---
            if (session.data?.unlockWallet?.step === "ENTER_OTP") {
              const otpCode = rawText;

              if (!otpCode || otpCode.length < 4) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid OTP.",
                  phone_number_id,
                );
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  unlockWallet: {
                    ...session.data.unlockWallet,
                    otpCode,
                    step: "ENTER_PIN",
                  },
                },
              });

              await triggerPinFlow(
                from,
                phone_number_id,
                "UNLOCK_WALLET",
                "🔓 Enter your *PIN* to confirm unlocking your wallet:",
              );
              return;
            }

            if (session.data?.changePin?.step === "ENTER_OTP") {
              const otpCode = rawText;

              if (otpCode?.toLowerCase() === "resend") {
                const otpRes = await requestChangePinOtp();
                if (!otpRes.success) {
                  const friendly = await humanizeError(
                    otpRes.error?.message || "Unknown error",
                    "resend OTP",
                  );
                  await sendWhatsApp(from, friendly, phone_number_id);
                } else {
                  await sendWhatsApp(
                    from,
                    "✅ A new OTP has been sent to your Email Address.\n\nPlease type it here:",
                    phone_number_id,
                  );
                }
                return;
              }

              if (!otpCode || otpCode.length < 4) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid OTP.",
                  phone_number_id,
                );
                return;
              }

              const { currentPin, newPin, confirmPin } = session.data.changePin;

              const changeRes = await changePinRequest({
                currentPin,
                newPin,
                confirmPin,
                otpCode,
              });

              if (!changeRes.success) {
                const errorMsg = changeRes.error?.message || "";
                const errorLower = errorMsg.toLowerCase();

                // Wrong OTP — let them try again without restarting
                if (
                  errorLower.includes("otp") ||
                  errorLower.includes("invalid code") ||
                  errorLower.includes("expired")
                ) {
                  await sendWhatsApp(
                    from,
                    "❌ The OTP you entered is invalid or has expired.\n\nPlease enter the OTP again, or type *resend* to request a new one.",
                    phone_number_id,
                  );
                  return; // Stay in ENTER_OTP step — don't clear changePin
                }

                // Wrong current PIN — restart from current PIN
                if (
                  errorLower.includes("incorrect") ||
                  errorLower.includes("current pin") ||
                  errorLower.includes("wrong pin")
                ) {
                  await sendWhatsApp(
                    from,
                    "❌ Your current PIN is incorrect. Let's start over.",
                    phone_number_id,
                  );
                  await updateSession(from, {
                    data: { ...session.data, changePin: null },
                  });
                  await triggerPinFlow(
                    from,
                    phone_number_id,
                    "CHANGE_PIN_CURRENT",
                    "🔐 Enter your *current PIN* to begin the change:",
                  );
                  return;
                }

                // Generic error — show friendly message and go back to menu
                const friendly = await humanizeError(
                  errorMsg,
                  "change your PIN",
                );
                await sendWhatsApp(from, friendly, phone_number_id);
                await updateSession(from, {
                  data: { ...session.data, changePin: null },
                });
                await sendMainMenu(from, phone_number_id);
                return;
              }

              await sendWhatsApp(
                from,
                "✅ *PIN Changed Successfully!*\n\nYour PIN has been updated. Please use your new PIN next time you log in.",
                phone_number_id,
              );

              await updateSession(from, {
                data: { ...session.data, changePin: null },
              });

              await sendMainMenu(from, phone_number_id);
              return;
            }

            // --- WITHDRAW FLOW LOGIC ---
            // if (session.data?.withdraw?.step === "ENTER_AMOUNT") {
            //   const amount = parseFloat(msg.text?.body?.trim());
            //   if (isNaN(amount) || amount <= 0) {
            //     await sendWhatsApp(
            //       from,
            //       "⚠️ Enter a valid amount.",
            //       phone_number_id,
            //     );
            //     return;
            //   }
            //   await updateSession(from, {
            //     data: {
            //       ...session.data,
            //       withdraw: {
            //         ...session.data.withdraw,
            //         amount,
            //         step: "ENTER_QUOTE_PIN",
            //       },
            //     },
            //   });
            //   await triggerPinFlow(from, phone_number_id, "WITHDRAW_QUOTE");
            //   return;
            // }

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

              const { coin, channelId } = session.data.withdraw;

              const quoteRes = await fetchWithdrawalQuote({
                coin,
                amount,
                channelId,
              });

              if (!quoteRes.success) {
                const rawError =
                  quoteRes.error?.message || "Unknown server error";
                const friendly = await humanizeError(
                  rawError,
                  "get a withdrawal quote",
                );
                await sendWhatsApp(from, friendly, phone_number_id);
                await updateSession(from, {
                  data: { ...session.data, withdraw: null },
                });
                await sendMainMenu(from, phone_number_id);
                return;
              }

              const q = quoteRes.data;
              const msgText = `📊 *Withdrawal Quote*\n\nWithdrawing: ${q.coinAmount} ${q.coin}\nEstimated ${q.fiatCurrency}: ${q.estimatedFiat} ${q.fiatCurrency}\nFees: ${q.totalFees}\n\nDo you want to proceed?`;

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    amount,
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

            if (session.data?.withdraw?.step === "ENTER_ACCOUNT_NAME") {
              const accountName = msg.text?.body?.trim();

              if (!accountName || accountName.length < 2) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid account name.",
                  phone_number_id,
                );
                return;
              }

              const { coin, amount, accountNumber, networkId, channelId, pin } =
                session.data.withdraw;

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
                const rawError =
                  execRes.error?.message || "Unknown server error";
                const friendlyMessage = await humanizeError(
                  rawError,
                  "execute a bank withdrawal",
                );
                await sendWhatsApp(from, friendlyMessage, phone_number_id);
                await updateSession(from, {
                  data: { ...session.data, withdraw: null },
                });
                await sendMainMenu(from, phone_number_id);
                return;
              }

              const result = execRes.data;
              await sendWhatsApp(
                from,
                `✅ *Withdrawal Successful!*\n\nAmount: ${result.amount} ${result.coin}\nTo: ${accountName}\nAccount: ${accountNumber}\nRef: ${result.reference}\n\n🚀 Funds are on the way!`,
                phone_number_id,
              );

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

            // if (session.data?.withdraw?.step === "ENTER_ACCOUNT_NUMBER_OTHER") {
            //   const accountNumber = msg.text?.body?.trim();

            //   if (!accountNumber || accountNumber.length < 4) {
            //     await sendWhatsApp(
            //       from,
            //       "⚠️ Please enter a valid account number.",
            //       phone_number_id,
            //     );
            //     return;
            //   }

            //   const { coin, amount, accountName, networkId, channelId } =
            //     session.data.withdraw;

            //   const execRes = await executeWithdrawal({
            //     coin,
            //     amount,
            //     accountNumber,
            //     accountName,
            //     networkId,
            //     channelId,
            //     pin: session.data.withdraw.pin,
            //   });

            //   if (!execRes.success) {
            //     const rawError =
            //       execRes.error?.message || "Unknown server error";
            //     const friendlyMessage = await humanizeError(
            //       rawError,
            //       "execute a bank withdrawal",
            //     );
            //     await sendWhatsApp(from, friendlyMessage, phone_number_id);
            //     await updateSession(from, {
            //       data: { ...session.data, withdraw: null },
            //     });
            //     await sendMainMenu(from, phone_number_id);
            //     return;
            //   }

            //   const result = execRes.data;
            //   await sendWhatsApp(
            //     from,
            //     `✅ *Withdrawal Successful!*\n\nAmount: ${result.amount} ${result.coin}\nTo: ${accountName}\nAccount: ${accountNumber}\nRef: ${result.reference}\n\n🚀 Funds are on the way!`,
            //     phone_number_id,
            //   );

            //   await updateSession(from, {
            //     data: { ...session.data, withdraw: null },
            //   });
            //   await sendWhatsApp(
            //     from,
            //     "What would you like to do next?",
            //     phone_number_id,
            //   );
            //   await sendMainMenu(from, phone_number_id);
            //   return;
            // }
            if (session.data?.withdraw?.step === "ENTER_ACCOUNT_NUMBER_OTHER") {
              const accountNumber = msg.text?.body?.trim();

              if (!accountNumber || accountNumber.length < 4) {
                await sendWhatsApp(
                  from,
                  "⚠️ Please enter a valid account number.",
                  phone_number_id,
                );
                return;
              }

              await updateSession(from, {
                data: {
                  ...session.data,
                  withdraw: {
                    ...session.data.withdraw,
                    accountNumber,
                    step: "ENTER_ACCOUNT_NAME",
                  },
                },
              });

              await sendWhatsApp(
                from,
                "👤 Please enter your *Account Name*:",
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
                const rawError =
                  valRes.error?.message || "Account validation failed";
                const friendlyMessage = await humanizeError(
                  rawError,
                  "validate bank account details",
                );
                await sendWhatsApp(from, friendlyMessage, phone_number_id);
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

            // if (session.data?.withdraw?.step === "ENTER_EXECUTE_PIN") {
            //   const pin = msg.text?.body?.trim();
            //   if (pin.length < 4) {
            //     await sendWhatsApp(from, "⚠️ Invalid PIN.", phone_number_id);
            //     return;
            //   }

            //   const {
            //     coin,
            //     amount,
            //     accountNumber,
            //     accountName,
            //     networkId,
            //     channelId,
            //   } = session.data.withdraw;

            //   const execRes = await executeWithdrawal({
            //     coin,
            //     amount,
            //     accountNumber,
            //     accountName,
            //     networkId,
            //     channelId,
            //     pin,
            //   });

            //   if (!execRes.success) {
            //     const rawError =
            //       execRes.error?.message || "Unknown server error";
            //     const friendlyMessage = await humanizeError(
            //       rawError,
            //       "execute a bank withdrawal",
            //     );
            //     await sendWhatsApp(from, friendlyMessage, phone_number_id);
            //     await updateSession(from, {
            //       data: { ...session.data, withdraw: null },
            //     });
            //     await sendMainMenu(from, phone_number_id);
            //     return;
            //   }

            //   const result = execRes.data;
            //   await sendWhatsApp(
            //     from,
            //     `✅ *Withdrawal Successful!*\n\nAmount: ${result.amount} ${result.coin}\nTo: ${result.accountName}\nBank: ${result.bankName}\nRef: ${result.reference}\n\n🚀 Funds are on the way!`,
            //     phone_number_id,
            //   );

            //   // Clear state
            //   await updateSession(from, {
            //     data: { ...session.data, withdraw: null },
            //   });
            //   await sendWhatsApp(
            //     from,
            //     "What would you like to do next?",
            //     phone_number_id,
            //   );
            //   await sendMainMenu(from, phone_number_id);
            //   return;
            // }

            // if (session.data?.authenticated) {
            //   await sendMainMenu(from, phone_number_id);
            //   return;
            // }
            // Nothing in the state machine above claimed this message.
            if (session.data?.authenticated) {
              if (isInActiveFlow) {
                // Previously this fell through to the registration check,
                // which flipped `awaitingPin` on and effectively logged the
                // user out for typing during a selection step. Re-prompt in
                // place instead.
                await sendWhatsApp(
                  from,
                  "🤔 I didn't quite get that.",
                  phone_number_id,
                );
                await rePromptCurrentStep(from, phone_number_id, flowState);
              } else {
                await sendMainMenu(from, phone_number_id);
              }
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

              // await sendWhatsApp(
              //   from,
              //   "🔐 Welcome back to VIXA!\n\nPlease enter your *4-digit PIN* to continue.",
              //   phone_number_id,
              // );
              await triggerPinFlow(from, phone_number_id, "LOGIN");
            } else {
              // CASE B: User NOT Registered -> Trigger Onboarding Flow
              console.log(
                `User ${from} does not exist. Triggering Onboarding.`,
              );
              notifyOnboardingStageStarted(from, phone_number_id);
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

  const pin = form.screen_0_pin_0;

  if (pin) {
    // Decode the context from flow_token (set in triggerPinFlow)
    // flow_token arrives in form as form.flow_token (WhatsApp includes it)
    const flowToken = form.flow_token || "";
    const pinContext = flowToken.includes("::")
      ? flowToken.split("::")[1]
      : null;

    console.log("PIN flow submission. Context:", pinContext, "Phone:", phone);

    await handlePinFlowSubmission({ phone, phone_number_id, pin, pinContext });
    return; // stop — do not fall through to onboarding logic
  }

  // ── NIN / BVN FLOW SUBMISSIONS ──────────────────────────────
  const flowToken = form.flow_token || "";

  if (flowToken.includes("::NIN_VERIFY")) {
    const nin = form.screen_0_NIN_0;
    const rawDob = form.screen_0_Date_of_Birth_1;

    try {
      if (nin) {
        const me = await fetchAuthMe();
        const formattedDob = formatDobToISO(rawDob);
        const verifyRes = await verifyNIN({
          nin,
          firstName: me?.firstName || "",
          lastName: me?.lastName || "",
          dateOfBirth: formattedDob,
        });
        console.log("NIN verify result:", verifyRes);

        const bvnStatus = verifyRes?.data?.data?.bvnStatus;

        if (bvnStatus === "NotStarted") {
          await sendWhatsApp(
            phone,
            "✅ Your NIN has been submitted. To complete your account setup, please also verify your BVN.",
            phone_number_id,
          );
          await triggerBVNFlow(phone, phone_number_id);
          return;
        }
      }
    } catch (err) {
      console.error("NIN verification error (non-blocking):", err.message);
    }

    await sendWhatsApp(
      phone,
      "✅ Your NIN has been submitted successfully. You can continue using VIXA.",
      phone_number_id,
    );
    await sendMainMenu(phone, phone_number_id);
    return;
  }

  if (flowToken.includes("::BVN_VERIFY")) {
    const bvn = form.screen_0_BVN_0;

    try {
      if (bvn) {
        const me = await fetchAuthMe(); // ← same fix
        const verifyRes = await verifyBVN({
          bvn,
          firstName: me?.firstName || "",
          lastName: me?.lastName || "",
        });
        console.log("BVN verify result:", verifyRes);
      }
    } catch (err) {
      console.error("BVN verification error (non-blocking):", err.message);
    }

    await sendWhatsApp(
      phone,
      "✅ Your BVN has been submitted successfully. You can continue using VIXA.",
      phone_number_id,
    );
    await sendMainMenu(phone, phone_number_id);
    return;
  }

  if (flowToken.includes("::BANK_SELECT")) {
    const bankId = form.selected_bank_id;
    const bankSession = await getSession(phone);

    const bankName =
      bankSession.data.withdraw.banks.find((b) => b.id === bankId)?.name ||
      "Selected Bank";
    const isNigeria = bankSession.data.withdraw?.countryCode === "NG";

    await updateSession(phone, {
      data: {
        ...bankSession.data,
        withdraw: {
          ...bankSession.data.withdraw,
          networkId: bankId,
          bankName: bankName,
          step: isNigeria
            ? "ENTER_ACCOUNT_NUMBER"
            : "ENTER_ACCOUNT_NUMBER_OTHER",
        },
      },
    });

    if (isNigeria) {
      await sendWhatsApp(
        phone,
        `🏦 You selected *${bankName}*.\n\nPlease enter your 10-digit Account Number:`,
        phone_number_id,
      );
    } else {
      await sendWhatsApp(
        phone,
        `🏦 You selected *${bankName}*.\n\nPlease enter your *Account Number*:`,
        phone_number_id,
      );
    }
    return;
  }

  if (flowToken.includes("::COUNTRY_SELECT")) {
    const countryCode = form.selected_country_id;
    const countrySession = await getSession(phone);

    // 1. Fetch payment channels for the selected country
    const channelsRes = await fetchPaymentChannels(countryCode, "withdraw");
    console.log(countryCode, channelsRes, "channelsRes from country flow");

    if (!channelsRes.success || !channelsRes.data?.items?.length) {
      await sendWhatsApp(
        phone,
        "⚠️ No payment channels available for this country currently.",
        phone_number_id,
      );
      return;
    }

    // 2. Prefer momo channel, otherwise first available
    const items = channelsRes.data.items;
    const momoChannel = items.find(
      (c) => c.channelType?.toLowerCase() === "momo",
    );
    const selectedChannel = momoChannel || items[0];

    console.log(
      `Selected channel for ${countryCode}:`,
      selectedChannel.id,
      selectedChannel.channelType,
    );

    // 3. Save to session and advance the withdraw flow
    await updateSession(phone, {
      data: {
        ...countrySession.data,
        withdraw: {
          ...countrySession.data.withdraw,
          countryCode,
          channelId: selectedChannel.id,
          step: "SELECT_WITHDRAW_TYPE",
        },
      },
    });

    await sendWithdrawTypeMenu(phone, phone_number_id);
    return;
  }

  if (flowToken.includes("::ITEM_SELECT")) {
    const selectedId = form.selected_item_id;
    const itemContext = flowToken.split("::")[2] || null;

    console.log(
      "Item flow submission. Context:",
      itemContext,
      "Id:",
      selectedId,
    );

    await handleItemSelection({
      phone,
      phone_number_id,
      selectedId,
      itemContext,
    });
    return;
  }

  const firstName = form.screen_0_First_Name_0 || form.First_Name_4f74a5;
  const lastName = form.screen_0_Last_Name_1 || form.Last_Name_76477c;
  const email = form.screen_0_Email_2;
  const nin = form.screen_0_NIN_3;
  const bvn = form.screen_0_BVN_4;
  const dob = form.screen_0_Date_Of_Birth_5;
  const onboardingPin = form.screen_0_Pin_6;
  const confirmPin = form.screen_0_Confirm_Pin_7;

  console.log("Extracted Onboarding Data:", { firstName, lastName, nin });

  if (
    !firstName ||
    !lastName ||
    !nin ||
    !bvn ||
    !onboardingPin ||
    !confirmPin ||
    onboardingPin !== confirmPin
  ) {
    const message =
      onboardingPin !== confirmPin
        ? "Pins do not match."
        : "Missing required fields.";
    console.warn("Validation failed:", message);
    await sendWhatsApp(
      phone,
      `❌ Onboarding failed: ${message}\n\nTap below to fill the form again 👇`,
      phone_number_id,
    );
    await triggerFlow(phone, phone_number_id);
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
      pin: onboardingPin,
    });

    if (!createRes.success) {
      await sendWhatsApp(
        phone,
        "❌ We couldn't create your account. Let's try that again 👇",
        phone_number_id,
      );
      await triggerFlow(phone, phone_number_id);
      return;
    }

    // 2. LOG IN USER TO CACHE TOKEN (Mandatory for subsequent API calls)
    let loginToken = null;
    try {
      console.log("here here", phone, pin);

      const { token: loginToken } = await loginUser({
        phoneNumber: phone,
        pin: onboardingPin,
      });
      console.log(loginToken, "loginTokenloginToken");
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
                    {
                      id: "CONTACT_SUPPORT",
                      title: "Contact Support",
                      description: "Get help from VIXA team",
                    },
                    {
                      id: "SETTINGS",
                      title: "Settings",
                      description: "Manage your account",
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
    } else if (action === "data_exchange") {
      const screen = decryptedBody.screen;
      const data = decryptedBody.data;

      if (screen === "SELECT_BANK") {
        // Echo the banks back — they were passed in via flow_action_payload
        responsePayload = {
          screen: "SELECT_BANK",
          data: {
            banks: data.banks || [],
          },
        };
      } else if (screen === "SELECT_COUNTRY") {
        responsePayload = {
          screen: "SELECT_COUNTRY",
          data: { countries: data.countries || [] },
        };
      } else if (screen === "SELECT_ITEM") {
        responsePayload = {
          screen: "SELECT_ITEM",
          data: {
            heading: data.heading || "Select an option",
            label: data.label || "Option",
            items: data.items || [],
          },
        };
      } else {
        responsePayload = {
          screen: "FAILURE",
          data: { message: "Data Exchange not implemented." },
        };
      }
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

async function handlePinFlowSubmission({
  phone,
  phone_number_id,
  pin,
  pinContext,
}) {
  const session = await getSession(phone);

  if (!pin || pin.length < 4) {
    await sendWhatsApp(
      phone,
      "⚠️ That PIN didn't look right. Please try again.",
      phone_number_id,
    );
    // Never leave a PIN retry as plain text — reopen the same Flow, in
    // whatever context the user was already in.
    try {
      await triggerPinFlow(
        phone,
        phone_number_id,
        pinContext || "LOGIN",
        "🔐 Please enter your PIN again:",
      );
    } catch (err) {
      console.error("PIN re-prompt failed:", err?.message || err);
      await sendWhatsApp(
        phone,
        "⚠️ I couldn't open the PIN screen. Please type *menu* and try again.",
        phone_number_id,
      );
    }
    return;
  }

  switch (pinContext) {
    // ─────────────────────────────────────────────
    // LOGIN / SESSION RE-AUTH
    // ─────────────────────────────────────────────
    case "LOGIN": {
      try {
        const loginResult = await loginUser({ phoneNumber: phone, pin });

        // loginResult now has { token, isFullyOnboarded, onboardingStage }
        const { isFullyOnboarded, onboardingStage } = loginResult;
        const me = await fetchAuthMe();
        if (!me) throw new Error("ME_NOT_FOUND");

        // Re-read session so we get the tokenExpiresAt that loginUser() just wrote
        const freshSession = await getSession(phone);
        await updateSession(phone, {
          data: {
            ...freshSession.data,
            awaitingPin: false,
            authenticated: true,
            pinAttempts: 0,
          },
        });
        // ── ONBOARDING STAGE CHECK ──────────────────────────

        console.log(
          "Login success. isFullyOnboarded:",
          isFullyOnboarded,
          "stage:",
          onboardingStage,
        );

        if (!isFullyOnboarded) {
          if (onboardingStage === "BasicInfoCompleted") {
            await sendWhatsApp(
              phone,
              `👋 Welcome back ${me.firstName}!\n\nWe noticed your NIN verification is still pending. Please complete it to fully activate your account.`,
              phone_number_id,
            );
            await triggerNINFlow(phone, phone_number_id);
            return;
          }

          if (
            onboardingStage === "NinSubmitted" ||
            onboardingStage === "NinVerified"
          ) {
            await sendWhatsApp(
              phone,
              `👋 Welcome back ${me.firstName}!\n\nYour NIN has been received. Please complete your BVN verification to fully activate your account.`,
              phone_number_id,
            );
            await triggerBVNFlow(phone, phone_number_id);
            return;
          }

          if (onboardingStage === "BvnVerified") {
            await sendWhatsApp(
              phone,
              `👋 Welcome back ${me.firstName}!\n\nYour BVN has been verified. Your wallet is currently being set up — this usually takes just a moment.\n\nYou can go ahead and explore VIXA in the meantime 👇`,
              phone_number_id,
            );
            await sendMainMenu(phone, phone_number_id);
            return;
          }
        }

        await sendWhatsApp(
          phone,
          `Welcome back ${me.firstName} 👋`,
          phone_number_id,
        );
        await sendMainMenu(phone, phone_number_id);
      } catch (err) {
        const attempts = (session.data?.pinAttempts || 0) + 1;
        await updateSession(phone, {
          data: {
            ...session.data,
            pinAttempts: attempts,
            awaitingPin: true,
            authenticated: false,
          },
        });
        await sendWhatsApp(
          phone,
          "❌ Incorrect PIN. Please try again.",
          phone_number_id,
        );
        await triggerPinFlow(phone, phone_number_id, "LOGIN");
      }
      break;
    }

    // ─────────────────────────────────────────────
    // DEPOSIT — PIN to confirm deposit amount
    // ─────────────────────────────────────────────
    case "DEPOSIT": {
      console.log(
        session.data.depositCurrency,
        session.data.depositAmount,
        "AF944F0C-BA70-47C7-86DC-1BAD5A6AB4E4",
        session.data.depositCoin,
        "CORR-${Date.now()",
        "IDEMPOTENCY-${Date.now()",
      );
      const depositResult = await depositCrypto({
        currency: session.data.depositCurrency,
        amountLocal: session.data.depositAmount,
        channelId: "AF944F0C-BA70-47C7-86DC-1BAD5A6AB4E4",
        coin: session.data.depositCoin,
        correlationId: `CORR-${Date.now()}`,
        idempotencyKey: `IDEMPOTENCY-${Date.now()}`,
        pin,
      });

      console.log(depositResult, "depositResult from PIN flow");

      if (!depositResult.success) {
        const rawError = depositResult.error?.message || "Unknown server error";
        const friendly = await humanizeError(rawError, "confirm deposit");
        await sendWhatsApp(phone, friendly, phone_number_id);

        await updateSession(phone, {
          data: {
            ...session.data,
            awaitingDepositPin: false,
            pendingDeposit: true,
          },
        });
        await sendWhatsApp(
          phone,
          "💰 Please enter the amount in NGN you'd like to deposit:",
          phone_number_id,
        );
        return;
      }

      const depositData = depositResult.data.data;
      const expiryDate = new Date(depositData.expiresAtUtc);
      const formattedExpiry = expiryDate.toLocaleTimeString("en-NG", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "Africa/Lagos",
      });
      const formattedAmount =
        depositData.amountToPayLocal?.toLocaleString("en-NG");
      const accNo = depositData.accountNumber;

      await sendWhatsApp(
        phone,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: {
              text: `✅ *Deposit Initiated*\n\nPlease make a transfer using the details below:\n💰 *Amount:* ₦${formattedAmount}\n🏦 *Bank Name:* ${depositData.bankName}\n👤 *Account Name:* ${depositData.accountName}\n🔢 *Account Number:* \`${accNo}\`\n🧾 *Reference:* ${depositData.reference}\n⏳ *Expires At:* ${formattedExpiry}\n\nOnce you've completed the transfer, tap *Confirm Payment* below.`,
            },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: {
                    id: "CONFIRM_DEPOSIT_PAYMENT",
                    title: "Have Paid",
                  },
                },
              ],
            },
          },
        },
        phone_number_id,
      );

      await updateSession(phone, {
        data: {
          ...session.data,
          pendingDeposit: false,
          awaitingDepositPin: false,
          awaitingDepositConfirmation: true,
          depositReference: depositData.reference,
          id: session.data.id,
        },
      });
      break;
    }

    // ─────────────────────────────────────────────
    // SWAP QUOTE — PIN to get quote
    // ─────────────────────────────────────────────
    case "SWAP_QUOTE": {
      // This context isn't used currently (swap uses PIN at execution, not quote).
      // Reserved for future use.
      break;
    }

    // ─────────────────────────────────────────────
    // SWAP EXECUTE — PIN to authorize swap
    // ─────────────────────────────────────────────
    case "SWAP": {
      const { fromCoin, amount, toCoin } = session.data.swap;

      const swapResult = await executeSwap({
        fromCoin,
        fromAmount: amount,
        toCoin,
        pin,
      });

      if (!swapResult.success) {
        const rawError = swapResult.error?.message || "Unknown server error";
        const friendly = await humanizeError(rawError, "execute a crypto swap");
        await sendWhatsApp(phone, friendly, phone_number_id);
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      await sendWhatsApp(
        phone,
        `✅ *Swap Successful!*\n\n${amount} ${fromCoin} → ${swapResult.data.data.toAmount} ${toCoin}\n\n🎉 Your wallet has been updated.`,
        phone_number_id,
      );
      await updateSession(phone, { data: { ...session.data, swap: null } });
      await sendWhatsApp(
        phone,
        "What would you like to do next?",
        phone_number_id,
      );
      await sendMainMenu(phone, phone_number_id);
      break;
    }

    // ─────────────────────────────────────────────
    // SEND CRYPTO — PIN to authorize send
    // ─────────────────────────────────────────────
    case "SEND": {
      const { coin, amount, address, chain, type } = session.data.send;

      const sendRes = await executeSendCrypto({
        type,
        coin,
        chain: chain?.chain,
        amount,
        phoneNumber: phone,
        externalAddress: address,
        pin,
      });

      if (!sendRes.success) {
        const rawError = sendRes.error?.message || "Unknown server error";
        const friendly = await humanizeError(rawError, "send crypto");
        await sendWhatsApp(phone, friendly, phone_number_id);
        return;
      }

      await sendWhatsApp(
        phone,
        `✅ *Transfer Successful!*\n\n${amount} ${coin} sent\nTo: ${address}\n\n🚀 Transaction submitted`,
        phone_number_id,
      );
      await updateSession(phone, { data: { ...session.data, send: null } });
      await sendWhatsApp(
        phone,
        "What would you like to do next?",
        phone_number_id,
      );
      await sendMainMenu(phone, phone_number_id);
      break;
    }

    // ─────────────────────────────────────────────
    // WITHDRAW QUOTE — PIN to generate quote
    // ─────────────────────────────────────────────
    case "WITHDRAW_QUOTE": {
      const { coin, amount, channelId } = session.data.withdraw;

      const quoteRes = await fetchWithdrawalQuote({
        coin,
        amount,
        channelId,
      });

      if (!quoteRes.success) {
        const rawError = quoteRes.error?.message || "Unknown server error";
        const friendly = await humanizeError(
          rawError,
          "get a withdrawal quote",
        );
        await sendWhatsApp(phone, friendly, phone_number_id);
        await updateSession(phone, {
          data: { ...session.data, withdraw: null },
        });
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      const q = quoteRes.data;
      const msgText = `📊 *Withdrawal Quote*\n\nWithdrawing: ${q.coinAmount} ${q.coin}\nEstimated ${q.fiatCurrency}: ${q.estimatedFiat} ${q.fiatCurrency}\nFees: ${q.totalFees}\n\nDo you want to proceed?`;

      await updateSession(phone, {
        data: {
          ...session.data,
          withdraw: {
            ...session.data.withdraw,
            step: "AWAITING_QUOTE_CONFIRM",
          },
        },
      });

      await sendWhatsApp(
        phone,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: msgText },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: { id: "QUOTE_CONFIRM_YES", title: "Yes, Proceed" },
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
      break;
    }

    // ─────────────────────────────────────────────
    // WITHDRAW EXECUTE — PIN to finalize withdrawal
    // ─────────────────────────────────────────────
    case "WITHDRAW_EXECUTE": {
      const { coin, amount, accountNumber, accountName, networkId, channelId } =
        session.data.withdraw;

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
        const rawError = execRes.error?.message || "Unknown server error";
        const friendly = await humanizeError(
          rawError,
          "execute a bank withdrawal",
        );
        await sendWhatsApp(phone, friendly, phone_number_id);
        await updateSession(phone, {
          data: { ...session.data, withdraw: null },
        });
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      const result = execRes.data;
      await sendWhatsApp(
        phone,
        `✅ *Withdrawal Successful!*\n\nAmount: ${result.amount} ${result.coin}\nTo: ${result.accountName}\nBank: ${result.bankName}\nRef: ${result.reference}\n\n🚀 Funds are on the way!`,
        phone_number_id,
      );
      await updateSession(phone, { data: { ...session.data, withdraw: null } });
      await sendWhatsApp(
        phone,
        "What would you like to do next?",
        phone_number_id,
      );
      await sendMainMenu(phone, phone_number_id);
      break;
    }

    case "CHANGE_PIN_CURRENT": {
      await updateSession(phone, {
        data: {
          ...session.data,
          changePin: {
            ...session.data.changePin,
            currentPin: pin,
            step: "ENTER_NEW_PIN",
          },
        },
      });
      await triggerPinFlow(
        phone,
        phone_number_id,
        "CHANGE_PIN_NEW",
        "🔑 Enter your *new PIN*:",
      );
      break;
    }

    case "CHANGE_PIN_NEW": {
      await updateSession(phone, {
        data: {
          ...session.data,
          changePin: {
            ...session.data.changePin,
            newPin: pin,
            step: "ENTER_CONFIRM_PIN",
          },
        },
      });
      await triggerPinFlow(
        phone,
        phone_number_id,
        "CHANGE_PIN_CONFIRM",
        "✅ Confirm your *new PIN* one more time:",
      );
      break;
    }

    case "CHANGE_PIN_CONFIRM": {
      const { currentPin, newPin } = session.data.changePin;

      // Check if new PIN and confirm PIN match
      if (pin !== newPin) {
        await sendWhatsApp(
          phone,
          "❌ Your PINs do not match. Let's try again from the new PIN step.",
          phone_number_id,
        );
        // Keep currentPin, reset new and confirm, go back to new PIN step
        await updateSession(phone, {
          data: {
            ...session.data,
            changePin: {
              currentPin,
              step: "ENTER_NEW_PIN",
            },
          },
        });
        await triggerPinFlow(
          phone,
          phone_number_id,
          "CHANGE_PIN_NEW",
          "🔑 Enter your *new PIN* again:",
        );
        return;
      }

      // Check if new PIN is same as current PIN
      if (pin === currentPin) {
        await sendWhatsApp(
          phone,
          "❌ Your new PIN cannot be the same as your current PIN. Please choose a different PIN.",
          phone_number_id,
        );
        await updateSession(phone, {
          data: {
            ...session.data,
            changePin: {
              currentPin,
              step: "ENTER_NEW_PIN",
            },
          },
        });
        await triggerPinFlow(
          phone,
          phone_number_id,
          "CHANGE_PIN_NEW",
          "🔑 Enter a *different new PIN*:",
        );
        return;
      }

      // Request OTP — backend sends it to user's WhatsApp
      const otpRes = await requestChangePinOtp("ChangePIN");

      if (!otpRes.success) {
        const friendly = await humanizeError(
          otpRes.error?.message || "Unknown error",
          "request a PIN change OTP",
        );
        await sendWhatsApp(phone, friendly, phone_number_id);
        await updateSession(phone, {
          data: { ...session.data, changePin: null },
        });
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      // Save confirmPin and move to OTP step
      await updateSession(phone, {
        data: {
          ...session.data,
          changePin: {
            ...session.data.changePin,
            confirmPin: pin,
            step: "ENTER_OTP",
          },
        },
      });

      await sendWhatsApp(
        phone,
        "✅ An OTP has been sent to your Email Address.\n\nPlease type it here to complete your PIN change:",
        phone_number_id,
      );
      break;
    }

    case "LOCK_WALLET": {
      const { reason } = session.data.lockWallet;

      const lockRes = await lockWallet({ pin, reason });

      if (!lockRes.success) {
        const rawError = lockRes.error?.message || "Unknown error";
        const friendly = await humanizeError(rawError, "lock your wallet");
        await sendWhatsApp(phone, friendly, phone_number_id);
        await updateSession(phone, {
          data: { ...session.data, lockWallet: null },
        });
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      await sendWhatsApp(
        phone,
        "🔒 *Wallet Locked Successfully!*\n\nYour wallet has been locked. To unlock it, go to Settings → Unlock Wallet.",
        phone_number_id,
      );
      await updateSession(phone, {
        data: { ...session.data, lockWallet: null },
      });
      await sendMainMenu(phone, phone_number_id);
      break;
    }

    case "UNLOCK_WALLET": {
      const { otpCode } = session.data.unlockWallet;

      const unlockRes = await unlockWallet({ pin, otpCode });

      console.log(unlockRes, "unlockresponse");
      console.log(otpCode, pin, "response from unlocking");

      if (!unlockRes.success) {
        const rawError = unlockRes.error?.message || "Unknown error";
        const errorLower = rawError.toLowerCase();

        if (
          errorLower.includes("otp") ||
          errorLower.includes("invalid code") ||
          errorLower.includes("expired")
        ) {
          await sendWhatsApp(
            phone,
            "❌ The OTP is invalid or has expired. Please request a new OTP by going to Settings → Unlock Wallet again.",
            phone_number_id,
          );
          await updateSession(phone, {
            data: { ...session.data, unlockWallet: null },
          });
          await sendMainMenu(phone, phone_number_id);
          return;
        }

        const friendly = await humanizeError(rawError, "unlock your wallet");
        await sendWhatsApp(phone, friendly, phone_number_id);
        await updateSession(phone, {
          data: { ...session.data, unlockWallet: null },
        });
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      await sendWhatsApp(
        phone,
        "🔓 *Wallet Unlocked Successfully!*\n\nYour wallet is now active. You can continue using VIXA normally.",
        phone_number_id,
      );
      await updateSession(phone, {
        data: { ...session.data, unlockWallet: null },
      });
      await sendMainMenu(phone, phone_number_id);
      break;
    }

    default: {
      console.warn("Unknown pinContext:", pinContext);
      await sendWhatsApp(
        phone,
        "⚠️ Something went wrong with PIN context. Please start over.",
        phone_number_id,
      );
      await sendMainMenu(phone, phone_number_id);
    }
  }
}

async function handleItemSelection({
  phone,
  phone_number_id,
  selectedId,
  itemContext,
}) {
  const session = await getSession(phone);

  if (!selectedId) {
    await sendWhatsApp(phone, "⚠️ Nothing was selected.", phone_number_id);
    return;
  }

  switch (itemContext) {
    // ── SWAP: from-coin ──────────────────────────────
    case "SWAP_FROM": {
      const selected = session.data?.swap?.allCoins?.find(
        (c) => c.coin === selectedId,
      );

      if (!selected) {
        await sendWhatsApp(
          phone,
          "⚠️ Coin not found. Please start over.",
          phone_number_id,
        );
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      await updateSession(phone, {
        data: {
          ...session.data,
          swap: {
            ...session.data.swap,
            step: "ENTER_AMOUNT",
            fromCoin: selectedId,
            fromCoinLimits: selected,
          },
        },
      });

      await sendWhatsApp(
        phone,
        `💰 Enter amount of *${selectedId}* to swap\n\nMin: ${selected.minAmount}\nMax: ${selected.maxAmount}`,
        phone_number_id,
      );
      return;
    }

    // ── SWAP: to-coin ────────────────────────────────
    case "SWAP_TO": {
      const toCoin = selectedId;
      const { amount, fromCoin } = session.data?.swap || {};

      const quote = await fetchSwapQuote({
        fromCoin,
        toCoin,
        fromAmount: amount,
      });

      if (!quote.success) {
        const rawError = quote.error?.message || "Unknown server error";
        const friendly = await humanizeError(rawError, "get a swap quote");
        await sendWhatsApp(phone, friendly, phone_number_id);
        return;
      }

      await updateSession(phone, {
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
        phone,
        `🔄 *Swap Ready*\n\n` +
          `From: ${amount} ${fromCoin}\n` +
          `To: ${quote.data.data.toAmount} ${toCoin}\n` +
          `Fee: ${quote.data.data.fee}\n\n` +
          `🔐 Please enter your *PIN* to authorize this swap.`,
        phone_number_id,
      );
      await triggerPinFlow(phone, phone_number_id, "SWAP");
      return;
    }

    // ── SEND: coin ───────────────────────────────────
    case "SEND_COIN": {
      const coin = selectedId;
      const selectedCoin = session.data?.send?.coins?.find(
        (c) => c.coin === coin,
      );

      if (!selectedCoin) {
        await sendWhatsApp(phone, "⚠️ Coin not found.", phone_number_id);
        return;
      }

      // P2P → no chain needed
      if (session.data.send.type === "P2P") {
        await updateSession(phone, {
          data: {
            ...session.data,
            send: {
              ...session.data.send,
              coin,
              chain: null,
              step: "ENTER_AMOUNT",
            },
          },
        });
        await sendWhatsApp(
          phone,
          `💸 Enter amount of *${coin}* to send:`,
          phone_number_id,
        );
        return;
      }

      const chains = selectedCoin.chains || [];

      // Single chain → auto-select
      if (chains.length === 1) {
        await updateSession(phone, {
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
          phone,
          `💸 Enter amount of *${coin}* to send\nMin: ${chains[0].minWithdrawAmount}`,
          phone_number_id,
        );
        return;
      }

      // Multi-chain → second selection flow
      await updateSession(phone, {
        data: {
          ...session.data,
          send: { ...session.data.send, coin, chains, step: "SELECT_CHAIN" },
        },
      });

      await triggerItemSelectionFlow(phone, phone_number_id, {
        context: "SEND_CHAIN",
        items: chains.map((ch) => ({
          id: ch.chain,
          title: ch.chain,
          description: `Min: ${ch.minWithdrawAmount}`,
        })),
        bodyText: `📤 Select the ${coin} network`,
        heading: `Select ${coin} network`,
        label: "Network",
        cta: "Select Network",
      });
      return;
    }

    // ── SEND: chain ──────────────────────────────────
    case "SEND_CHAIN": {
      const chain = session.data?.send?.chains?.find(
        (c) => c.chain === selectedId,
      );

      if (!chain) {
        await sendWhatsApp(phone, "⚠️ Network not found.", phone_number_id);
        return;
      }

      await updateSession(phone, {
        data: {
          ...session.data,
          send: { ...session.data.send, chain, step: "ENTER_AMOUNT" },
        },
      });

      await sendWhatsApp(
        phone,
        `💸 Enter amount of *${session.data.send.coin}* to send\nMin: ${chain.minWithdrawAmount}`,
        phone_number_id,
      );
      return;
    }

    // ── RECEIVE: coin ────────────────────────────────
    case "RECEIVE_COIN": {
      const coin = selectedId;
      const walletsRes = await fetchReceiveWallets({ coin });

      if (!walletsRes.success) {
        await sendWhatsApp(
          phone,
          "⚠️ Unable to load receive wallets.",
          phone_number_id,
        );
        return;
      }

      const wallets = walletsRes?.data?.data?.data || [];

      if (!wallets.length) {
        await sendWhatsApp(
          phone,
          `⚠️ No receive wallets available for ${coin}.`,
          phone_number_id,
        );
        return;
      }

      // Single wallet → show address directly
      if (wallets.length === 1) {
        const w = wallets[0];
        await sendWhatsApp(
          phone,
          `📥 *${w.coin} Receive Address*\n\n` +
            `Network: ${w.network}\n` +
            `Chain: ${w.chain}\n\n` +
            `📌 *Tap & hold to copy address:*\n` +
            `\`\`\`\n${w.address}\n\`\`\``,
          phone_number_id,
        );
        await updateSession(phone, {
          data: { ...session.data, receive: null },
        });
        await sendMainMenu(phone, phone_number_id);
        return;
      }

      await updateSession(phone, {
        data: {
          ...session.data,
          receive: { step: "SELECT_CHAIN", wallets, selectedCoin: coin },
        },
      });

      await triggerItemSelectionFlow(phone, phone_number_id, {
        context: "RECEIVE_WALLET",
        items: wallets.map((w) => ({
          id: w.id,
          title: w.chain,
          description: w.network,
        })),
        bodyText: `📥 Select the ${coin} network`,
        heading: `Select ${coin} network`,
        label: "Network",
        cta: "Select Network",
      });
      return;
    }

    // ── RECEIVE: wallet / chain ──────────────────────
    case "RECEIVE_WALLET": {
      const wallet = session.data?.receive?.wallets?.find(
        (w) => String(w.id) === String(selectedId),
      );

      if (!wallet) {
        await sendWhatsApp(phone, "⚠️ Wallet not found.", phone_number_id);
        return;
      }

      await sendWhatsApp(
        phone,
        `📥 *${wallet.coin} Receive Address*\n\n` +
          `Network: ${wallet.network}\n` +
          `Chain: ${wallet.chain}\n\n` +
          `📌 *Tap & hold to copy address:*\n` +
          `\`\`\`\n${wallet.address}\n\`\`\``,
        phone_number_id,
      );

      await updateSession(phone, {
        data: { ...session.data, receive: null },
      });
      await sendMainMenu(phone, phone_number_id);
      return;
    }

    // ── WITHDRAW: coin ───────────────────────────────
    case "WITHDRAW_COIN": {
      await updateSession(phone, {
        data: {
          ...session.data,
          withdraw: {
            ...session.data.withdraw,
            coin: selectedId,
            step: "ENTER_AMOUNT",
          },
        },
      });

      await sendWhatsApp(
        phone,
        `💰 Please enter the amount of *${selectedId}* you want to withdraw:`,
        phone_number_id,
      );
      return;
    }

    default: {
      console.warn("Unknown itemContext:", itemContext);
      await sendWhatsApp(
        phone,
        "⚠️ Something went wrong with that selection. Please start over.",
        phone_number_id,
      );
      await sendMainMenu(phone, phone_number_id);
    }
  }
}

async function sendPaginatedSwapCoinsMenu(
  to,
  phone_number_id,
  coinsList,
  page = 0,
  direction = "FROM",
) {
  const itemsPerPage = 9;
  const startIndex = page * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;

  const currentChunk = coinsList.slice(startIndex, endIndex);

  const rows = currentChunk.map((c) => ({
    id: `SWAP_${direction}_${c.coin}`,
    title: c.coin,
    description: `Min: ${c.minAmount}, Max: ${c.maxAmount}`,
  }));

  if (endIndex < coinsList.length) {
    rows.push({
      id: `SWAP_${direction}_PAGE_${page + 1}`,
      title: "➡️ See More Coins",
      description: "Tap to load more options",
    });
  }

  const bodyText =
    direction === "FROM"
      ? `🔄 Select the coin you want to swap *from* (Page ${page + 1}):`
      : `➡️ Select the coin you want to receive (Page ${page + 1}):`;

  await sendWhatsApp(
    to,
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: "Select coin",
          sections: [{ title: "Available Coins", rows }],
        },
      },
    },
    phone_number_id,
  );
}

async function sendPaginatedBanksMenu(
  to,
  phone_number_id,
  banksList,
  page = 0,
) {
  const itemsPerPage = 9;
  const startIndex = page * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;

  const currentChunk = banksList.slice(startIndex, endIndex);

  const rows = currentChunk.map((b) => ({
    id: `WITHDRAW_BANK_${b.id}`,
    title: b.name.substring(0, 24),
  }));

  if (endIndex < banksList.length) {
    rows.push({
      id: `WITHDRAW_BANK_NEXT_PAGE`,
      title: "➡️ See More Banks",
      description: "Tap to load more options",
    });
  }

  await sendWhatsApp(
    to,
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: `🏦 Select your destination bank (Page ${page + 1}):` },
        action: {
          button: "Select Bank",
          sections: [{ title: "Available Banks", rows }],
        },
      },
    },
    phone_number_id,
  );
}

// 🆕 HELPER: Send Paginated Countries List
async function sendPaginatedCountriesMenu(
  to,
  phone_number_id,
  countriesList,
  page = 0,
) {
  const itemsPerPage = 9; // Leave 1 slot for the "See More" button
  const startIndex = page * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;

  // Slice exactly 9 items for the current page
  const currentChunk = countriesList.slice(startIndex, endIndex);

  const rows = currentChunk.map((c) => ({
    id: `WITHDRAW_COUNTRY_${c.countryCode}`,
    title: `${c.flag} ${c.countryName}`.substring(0, 24),
  }));

  // If there are more items left in the full array, add a 10th "Next" button
  if (endIndex < countriesList.length) {
    rows.push({
      id: `WITHDRAW_COUNTRY_NEXT_PAGE`,
      title: "➡️ See More Countries",
      description: "Tap to load more options",
    });
  }

  await sendWhatsApp(
    to,
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: `🌍 Select your withdrawal country (Page ${page + 1}):` },
        action: {
          button: "Select Country",
          sections: [{ title: "Supported Countries", rows }],
        },
      },
    },
    phone_number_id,
  );
}

async function sendWithdrawTypeMenu(to, phone_number_id) {
  await sendWhatsApp(
    to,
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
                { id: "WITHDRAW_TYPE_USDT", title: "Withdraw in USDT" },
                { id: "WITHDRAW_TYPE_OTHER", title: "Withdraw other coin" },
              ],
            },
          ],
        },
      },
    },
    phone_number_id,
  );
}

/** Flow ids rendered for humans, for confirmations and acknowledgements. */
const FLOW_LABELS = {
  DEPOSIT: "deposit",
  WITHDRAW: "withdrawal",
  SWAP: "swap",
  SEND: "transfer",
  RECEIVE: "receive",
  BALANCE: "balance check",
  SUPPORT: "support",
  CHANGE_PIN: "PIN change",
  LOCK_WALLET: "wallet lock",
  UNLOCK_WALLET: "wallet unlock",
  SETTINGS: "settings",
  LOGIN: "sign-in",
};

function humanFlowName(flow) {
  return FLOW_LABELS[flow] || String(flow || "action").toLowerCase();
}

/**
 * Re-show whatever the current step is waiting for.
 *
 * PIN steps are NOT typed in VIXA — they come back through the PIN Flow, and
 * there is no text handler for them. Sending the rePrompt string alone paints
 * an instruction with no Flow button, so the user types their PIN into the
 * chat, nothing claims it, and they loop on "I didn't quite get that".
 */
async function rePromptCurrentStep(from, phone_number_id, flowState) {
  if (!flowState?.active) return;

  if (flowState.expecting === "pin" && flowState.pinContext) {
    try {
      await triggerPinFlow(
        from,
        phone_number_id,
        flowState.pinContext,
        flowState.rePrompt,
      );
      return;
    } catch (err) {
      // triggerPinFlow throws where sendWhatsApp doesn't. Don't leave the
      // user staring at silence.
      console.error(
        "rePromptCurrentStep: triggerPinFlow failed:",
        err?.message || err,
      );
      await sendWhatsApp(
        from,
        "⚠️ I couldn't open the PIN screen. Please type *menu* and try again.",
        phone_number_id,
      );
      return;
    }
  }

  if (flowState.rePrompt) {
    await sendWhatsApp(from, flowState.rePrompt, phone_number_id);
  }
}

/**
 * Clear any in-progress flow, acknowledge, and enter `flow`.
 *
 * Everything that starts a flow goes through here so that a failure inside
 * routeToFlow can never leave the user staring at an unanswered message.
 */
async function startFlow(flow, from, phone_number_id, { ack } = {}) {
  const current = await getSession(from);
  await updateSession(from, { data: clearedFlowState(current.data) });
  const fresh = await getSession(from);

  if (ack) await sendWhatsApp(from, ack, phone_number_id);

  await safeRouteToFlow(flow, from, phone_number_id, fresh.data);
}

/**
 * routeToFlow, but a thrown error becomes a message the user can act on
 * rather than silence. This is the guard that was missing when the swap
 * currency lookup blew up mid-route.
 */
async function safeRouteToFlow(flow, from, phone_number_id, sessionData) {
  try {
    await routeToFlow(flow, from, phone_number_id, sessionData);
  } catch (err) {
    console.error(`routeToFlow(${flow}) failed:`, err);
    logger.error?.("routeToFlow failed", { flow, error: err?.message });

    // Don't strand the user inside a half-entered flow.
    try {
      const current = await getSession(from);
      await updateSession(from, { data: clearedFlowState(current.data) });
    } catch (cleanupErr) {
      console.error("state cleanup failed:", cleanupErr);
    }

    await sendWhatsApp(
      from,
      `⚠️ Sorry, I couldn't open ${humanFlowName(flow)} just now. Please try again in a moment.`,
      phone_number_id,
    );
    await sendMainMenu(from, phone_number_id);
  }
}

async function routeToFlow(flow, from, phone_number_id, sessionData) {
  switch (flow) {
    case "DEPOSIT": {
      await updateSession(from, {
        data: {
          ...sessionData,
          pendingDeposit: true,
          depositCoin: "USDT",
          depositChain: "SOL",
          depositCurrency: "NGN",
        },
      });
      await sendWhatsApp(
        from,
        "💰 Please enter the amount in NGN you want to deposit for your USDT wallet:",
        phone_number_id,
      );
      break;
    }
    case "WITHDRAW": {
      await updateSession(from, {
        data: { ...sessionData, withdraw: { step: "SELECT_WITHDRAW_REGION" } },
      });
      await sendWhatsApp(
        from,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: "📍 Where are you withdrawing to?" },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: { id: "WITHDRAW_REGION_NG", title: "🇳🇬 Nigeria" },
                },
                {
                  type: "reply",
                  reply: {
                    id: "WITHDRAW_REGION_OTHER",
                    title: "🌍 Other Countries",
                  },
                },
              ],
            },
          },
        },
        phone_number_id,
      );
      break;
    }
    case "SEND": {
      await updateSession(from, {
        data: { ...sessionData, send: { step: "SELECT_SEND_TYPE" } },
      });
      await sendWhatsApp(
        from,
        {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: "Who are you sending to? 😊" },
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
      break;
    }
    case "RECEIVE": {
      const walletsRes = await fetchReceiveWallets();
      if (!walletsRes.success) {
        await sendWhatsApp(
          from,
          "⚠️ Unable to load receive options right now.",
          phone_number_id,
        );
        return;
      }
      const wallets = walletsRes?.data?.data?.data || [];
      if (!wallets.length) {
        await sendWhatsApp(
          from,
          "⚠️ No receive wallets available.",
          phone_number_id,
        );
        return;
      }
      const uniqueCoins = [...new Set(wallets.map((w) => w.coin))];

      await updateSession(from, {
        data: { ...sessionData, receive: { step: "SELECT_COIN", wallets } },
      });

      await triggerItemSelectionFlow(from, phone_number_id, {
        context: "RECEIVE_COIN",
        items: uniqueCoins.map((coin) => ({
          id: coin,
          title: coin,
          description: `Receive ${coin}`,
        })),
        bodyText: "📥 Select the coin you want to receive",
        heading: "Select coin to receive",
        label: "Coin",
        cta: "Select Coin",
      });
      break;
    }
    case "SWAP": {
      const { coins: selectedCoins, error: swapErr } = await loadSwapCoins();

      if (swapErr) {
        await sendWhatsApp(from, swapErr, phone_number_id);
        return;
      }

      await updateSession(from, {
        data: {
          ...sessionData,
          swap: {
            step: "SELECT_FROM",
            allCoins: selectedCoins,
          },
        },
      });

      await triggerItemSelectionFlow(from, phone_number_id, {
        context: "SWAP_FROM",
        items: selectedCoins.map((c) => ({
          id: c.coin,
          title: c.coin,
          description: `Min: ${c.minAmount}, Max: ${c.maxAmount}`,
        })),
        bodyText: "🔄 Select the coin you want to swap from",
        heading: "Select the coin you want to swap from",
        label: "Coin",
        cta: "Select Coin",
      });
      break;
    }
    case "BALANCE": {
      const me = await fetchAuthMe();
      const balances = await fetchWalletBalances();
      const now = new Date();
      const formattedDate = now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      let balanceText = `Hi ${me.firstName} 👋\n\n💼 *Your Wallet Balances*\n\n`;
      balanceText += balances?.length
        ? balances.map((b) => `• ${b.coin}: ${b.balance}`).join("\n")
        : "You currently have no wallet balances.";
      balanceText += `\n\n📅 Last updated: ${formattedDate}`;
      await sendWhatsApp(from, balanceText, phone_number_id);
      await sendMainMenu(from, phone_number_id);
      break;
    }
    case "SUPPORT": {
      await sendWhatsApp(
        from,
        `🛟 *VIXA Support*\n\nNeed help? Reach us via:\n\n📧 *Email:* usevixa@gmail.com\n\nPlease include your registered phone number when contacting support.`,
        phone_number_id,
      );
      await sendMainMenu(from, phone_number_id);
      break;
    }
    case "CHANGE_PIN": {
      await updateSession(from, {
        data: { ...sessionData, changePin: { step: "ENTER_CURRENT_PIN" } },
      });
      await triggerPinFlow(
        from,
        phone_number_id,
        "CHANGE_PIN_CURRENT",
        "🔐 Enter your *current PIN* to begin the change:",
      );
      break;
    }

    case "LOCK_WALLET": {
      await updateSession(from, {
        data: { ...sessionData, lockWallet: { step: "ENTER_REASON" } },
      });
      await sendWhatsApp(
        from,
        "🔒 *Lock Wallet*\n\nPlease tell us the reason you want to lock your wallet:\n\n(e.g. Lost phone, Suspicious activity, Going on vacation)",
        phone_number_id,
      );
      break;
    }

    case "UNLOCK_WALLET": {
      const otpRes = await requestChangePinOtp("UnlockWallet");
      if (!otpRes.success) {
        const friendly = await humanizeError(
          otpRes.error?.message || "Unknown error",
          "request an OTP to unlock wallet",
        );
        await sendWhatsApp(from, friendly, phone_number_id);
        return;
      }
      await updateSession(from, {
        data: { ...sessionData, unlockWallet: { step: "ENTER_OTP" } },
      });
      await sendWhatsApp(
        from,
        "🔓 *Unlock Wallet*\n\nAn OTP has been sent to your Email Address.\n\nPlease type the OTP here to continue:",
        phone_number_id,
      );
      break;
    }

    case "SETTINGS": {
      await sendWhatsApp(
        from,
        {
          type: "interactive",
          interactive: {
            type: "list",
            body: { text: "⚙️ *Settings*\n\nWhat would you like to do?" },
            action: {
              button: "Select Option",
              sections: [
                {
                  title: "Account Settings",
                  rows: [
                    {
                      id: "CHANGE_PIN",
                      title: "Change PIN",
                      description: "Update your 4-digit PIN",
                    },
                    {
                      id: "LOCK_WALLET",
                      title: "Lock Wallet",
                      description: "Lock your wallet access",
                    },
                    {
                      id: "UNLOCK_WALLET",
                      title: "Unlock Wallet",
                      description: "Restore your wallet access",
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

    default: {
      await sendMainMenu(from, phone_number_id);
    }
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
                {
                  id: "CONTACT_SUPPORT",
                  title: "Contact Support",
                  description: "Get help from VIXA team",
                },
                {
                  id: "SETTINGS",
                  title: "Settings",
                  description: "Manage your account",
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
        text:
          "Welcome to VIXA 👋\n\n" +
          "Your money can now move from WhatsApp.\n\n" +
          "Buy, sell & swap crypto. Convert USDT to local currency at great rates. Send money across 19 African countries.\n\n" +
          "No extra app to learn — just tell VIXA what you want to do.\n\n" +
          "Ready to unlock VIXA?",
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

  console.log(res, "send message res");

  if (!res.ok) {
    const debug = await res.text();
    console.error("triggerFlow failed:", res.status, debug);
    throw new Error("triggerFlow failed; check token/phone_number_id");
  }

  console.log("triggerFlow sent to", toPhone);
}

async function triggerPinFlow(
  toPhone,
  phone_number_id,
  pinContext,
  customMessage,
) {
  // pinContext is a string like "DEPOSIT", "SWAP", "WITHDRAW", "EXECUTE_WITHDRAW", "SWAP_QUOTE", "SEND"
  // We store it in session BEFORE calling this, so the nfm_reply handler knows what pin was for.

  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log("[MOCK PIN FLOW] to:", toPhone, "context:", pinContext);
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
        text: customMessage || "🔐 Please enter your PIN to continue.",
      },
      action: {
        name: "flow",
        parameters: {
          flow_id: PIN_FLOW_ID,
          flow_token: `${toPhone}::${pinContext}`, // encode context in token
          flow_cta: "Enter PIN",
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
    console.error("triggerPinFlow failed:", res.status, debug);
    throw new Error("triggerPinFlow failed");
  }

  console.log("triggerPinFlow sent to", toPhone, "context:", pinContext);
}

async function triggerNINFlow(toPhone, phone_number_id) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: "📋 Please complete your NIN verification to continue." },
      action: {
        name: "flow",
        parameters: {
          flow_id: NIN_FLOW_ID,
          flow_token: `${toPhone}::NIN_VERIFY`,
          flow_cta: "Verify NIN",
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
    console.error("triggerNINFlow failed:", res.status, debug);
  }
  console.log("triggerNINFlow sent to", toPhone);
}

async function triggerBVNFlow(toPhone, phone_number_id) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: "📋 Please complete your BVN verification to continue." },
      action: {
        name: "flow",
        parameters: {
          flow_id: BVN_FLOW_ID,
          flow_token: `${toPhone}::BVN_VERIFY`,
          flow_cta: "Verify BVN",
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
    console.error("triggerBVNFlow failed:", res.status, debug);
  }
  console.log("triggerBVNFlow sent to", toPhone);
}

async function triggerBankSelectionFlow(toPhone, phone_number_id, banks) {
  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log("[MOCK BANK FLOW] to:", toPhone);
    return false;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;

  const bankOptions = banks.map((b) => ({
    id: b.id,
    title: b.name.substring(0, 30),
  }));

  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: "🏦 Please select your destination bank" },
      action: {
        name: "flow",
        parameters: {
          flow_id: BANK_SELECTION_FLOW_ID,
          flow_token: `${toPhone}::BANK_SELECT`,
          flow_cta: "Select Bank",
          flow_message_version: "3",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "SELECT_BANK",
            data: { banks: bankOptions },
          },
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
    console.error("triggerBankSelectionFlow failed:", res.status, debug);
    logger.error?.("flow send rejected", {
      flow: "BANK_SELECT",
      status: res.status,
      debug,
    });
    return false;
  }
  console.log("triggerBankSelectionFlow sent to", toPhone);
  return true;
}

async function triggerCountrySelectionFlow(
  toPhone,
  phone_number_id,
  countries,
) {
  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log("[MOCK COUNTRY FLOW] to:", toPhone);
    return false;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;

  const countryOptions = countries.map((c) => ({
    id: c.countryCode,
    title: `${c.flag} ${c.countryName}`.substring(0, 30),
  }));

  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: "🌍 Please select your withdrawal country" },
      action: {
        name: "flow",
        parameters: {
          flow_id: COUNTRY_SELECTION_FLOW_ID,
          flow_token: `${toPhone}::COUNTRY_SELECT`,
          flow_cta: "Select Country",
          flow_message_version: "3",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "SELECT_COUNTRY",
            data: { countries: countryOptions },
          },
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
    console.error("triggerCountrySelectionFlow failed:", res.status, debug);
    logger.error?.("flow send rejected", {
      flow: "COUNTRY_SELECT",
      status: res.status,
      debug,
    });
    return false;
  }
  console.log("triggerCountrySelectionFlow sent to", toPhone);
  return true;
}

/**
 * Generic single-select flow.
 * context: SWAP_FROM | SWAP_TO | SEND_COIN | SEND_CHAIN | RECEIVE_COIN | RECEIVE_WALLET | WITHDRAW_COIN
 * items: [{ id, title, description }]
 */
async function triggerItemSelectionFlow(
  toPhone,
  phone_number_id,
  { context, items, bodyText, heading, label, cta },
) {
  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log("[MOCK ITEM FLOW] to:", toPhone, "context:", context);
    return false;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;

  // Every item MUST have all three keys or the dropdown renders blank
  const safeItems = items.map((i) => ({
    id: String(i.id),
    title: String(i.title).substring(0, 30),
    description: String(i.description ?? "—").substring(0, 60),
  }));

  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: bodyText },
      action: {
        name: "flow",
        parameters: {
          flow_id: ITEM_SELECTION_FLOW_ID,
          flow_token: `${toPhone}::ITEM_SELECT::${context}`,
          flow_cta: cta || "Select",
          flow_message_version: "3",
          flow_action: "navigate",
          flow_action_payload: {
            screen: "SELECT_ITEM",
            data: { heading, label, items: safeItems },
          },
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
    console.error("triggerItemSelectionFlow failed:", res.status, debug);
    logger.error?.("flow send rejected", {
      flow: "ITEM_SELECT",
      context,
      status: res.status,
      debug,
    });
    return false;
  }
  console.log("triggerItemSelectionFlow sent to", toPhone, "context:", context);
  return true;
}

/* ------------- WA send helper (text + interactive) ------------- */
async function sendWhatsApp(to, message, phone_number_id) {
  // An empty/undefined body is a 400 from Meta and, before this guard, an
  // exception that aborted the rest of the handler. Fail loudly in the log,
  // quietly to the user.
  if (message == null || (typeof message === "string" && !message.trim())) {
    console.error("sendWhatsApp: refusing to send an empty message to", to);
    return false;
  }

  if (!WHATSAPP_TOKEN || !phone_number_id) {
    console.log(
      "[MOCK send] to:",
      to,
      message,
      "phone_number_id:",
      phone_number_id,
    );
    return false;
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

  try {
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
      logger.error?.("sendWhatsApp failed", { status: res.status, debugBody });
      // Deliberately does NOT throw. One failed send used to abort every
      // remaining step in the handler, which is how users ended up with a
      // dangling "Sure, let me take you there!" and no follow-up.
      return false;
    }

    return true;
  } catch (err) {
    console.error("sendWhatsApp threw:", err?.message || err);
    return false;
  }
}

export default router;
