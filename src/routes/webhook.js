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
  runWithUserContext,
} from "../services/auth.service.js";
import { fetchAuthMe } from "../services/user.service.js";
import { depositCrypto } from "../services/deposit.service.js";
import { randomUUID } from "node:crypto";
import { fetchWalletBalances } from "../services/wallet.service.js";
import { fetchReceiveWallets } from "../services/recieve.service.js";
import {
  getSupportedCoins,
  TRANSACTION_TYPES,
} from "../services/supportedCurrencies.service.js";
import { humanizeError } from "../services/ai.service.js";
import { resolveIntent } from "../ai/intentRouter.js";
import {
  describeFlowState,
  clearedFlowState,
  voiceAllowed,
} from "../ai/flowState.js";
import {
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
  fetchSendQuote,
  executeSendCrypto,
} from "../services/send.service.js";

import { convertRate } from "../services/rates.service.js";
import {
  requestChangePinOtp,
  changePinRequest,
  lockWallet,
  unlockWallet,
} from "../services/changePin.service.js";
import logger from "../lib/logger.js";

import { decryptRequest, encryptResponse } from "../utils/decrypt.js";

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
const KYC_FLOW_ID = process.env.KYC_FLOW_ID;

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

/**
 * Shared entry for every swap-currency lookup (main menu, routeToFlow, and the
 * to-coin step). The backend decides which coins can be swapped, so there is
 * no local whitelist. Swap takes no chain, so each coin appears once.
 *
 * @returns {{ coins: any[], error: string|null }}
 */
async function loadSwapCoins(fromCoin) {
  const res = await getSupportedCoins(TRANSACTION_TYPES.SWAP);

  if (!res.success) {
    return {
      coins: [],
      error:
        "⚠️ Unable to load swap currencies right now. Please try again in a moment.",
    };
  }

  const coins = res.coins
    .filter((c) => !fromCoin || c.coin !== fromCoin)
    .map((c) => ({
      ...c,
      chain:
        c.chains.length === 1 ? c.chains[0].chain : `${c.chains.length} networks`,
    }));

  if (!coins.length) {
    return {
      coins: [],
      error: "⚠️ Swap isn't available right now. Please try again shortly.",
    };
  }

  return { coins, error: null };
}

/** "\nMin: x" for a send amount prompt, or nothing when there's no minimum. */
const minLine = (min) => (Number(min) > 0 ? `\nMin: ${min}` : "");

/* ------------- RECEIVE: coin -> network -> address ------------- */

/** Coin list for Receive, from /supported-currencies?transactionType=Receive. */
async function startReceive(to, phone_number_id) {
  const res = await getSupportedCoins(TRANSACTION_TYPES.RECEIVE);

  if (!res.success) {
    await sendWhatsApp(
      to,
      "⚠️ Unable to load receive options right now.",
      phone_number_id,
    );
    return;
  }
  if (!res.coins.length) {
    await sendWhatsApp(to, "⚠️ No coins are available to receive.", phone_number_id);
    return;
  }

  const session = await getSession(to);
  await updateSession(to, {
    data: { ...session.data, receive: { step: "SELECT_COIN", coins: res.coins } },
  });

  await triggerItemSelectionFlow(to, phone_number_id, {
    context: "RECEIVE_COIN",
    items: res.coins.map((c) => ({
      id: c.coin,
      title: c.coin,
      description:
        c.chains.length === 1 ? c.chains[0].chain : `${c.chains.length} networks`,
    })),
    bodyText: "📥 Select the coin you want to receive",
    heading: "Select coin to receive",
    label: "Coin",
    cta: "Select Coin",
  });
}

/** One network → show the address; several → ask which network. */
async function receiveCoinPicked(to, phone_number_id, coin) {
  const session = await getSession(to);
  let coins = session.data?.receive?.coins;

  // An old picker tapped after the session moved on — reload the list.
  if (!coins?.length) {
    const res = await getSupportedCoins(TRANSACTION_TYPES.RECEIVE);
    coins = res.coins;
  }

  const selected = coins?.find((c) => c.coin === coin);
  if (!selected) {
    await sendWhatsApp(to, `⚠️ ${coin} can't be received right now.`, phone_number_id);
    await sendMainMenu(to, phone_number_id);
    return;
  }

  if (selected.chains.length === 1) {
    await showReceiveAddress(to, phone_number_id, coin, selected.chains[0].chain);
    return;
  }

  await updateSession(to, {
    data: {
      ...session.data,
      receive: { step: "SELECT_CHAIN", coins, selectedCoin: coin },
    },
  });

  const items = selected.chains.map((ch) => ({
    id: ch.chain,
    title: ch.chain,
    description: coin,
  }));

  // A Flow dropdown takes every network (USDT has 11); a list message caps at 10.
  const sent = await triggerItemSelectionFlow(to, phone_number_id, {
    context: "RECEIVE_WALLET",
    items,
    bodyText: `📥 Select the ${coin} network`,
    heading: `Select ${coin} network`,
    label: "Network",
    cta: "Select Network",
  });

  if (!sent) {
    await sendWhatsApp(
      to,
      {
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: `📥 Select ${coin} network` },
          action: {
            button: "Select network",
            sections: [
              {
                title: "Available Networks",
                rows: items.slice(0, 10).map((i) => ({
                  id: `RECEIVE_WALLET_${i.id}`,
                  title: i.title.substring(0, 24),
                  description: i.description,
                })),
              },
            ],
          },
        },
      },
      phone_number_id,
    );
  }
}

async function receiveNetworkPicked(to, phone_number_id, network) {
  const session = await getSession(to);
  const coin = session.data?.receive?.selectedCoin;

  if (!coin) {
    await sendWhatsApp(
      to,
      "⚠️ That selection has expired. Please start Receive again.",
      phone_number_id,
    );
    await sendMainMenu(to, phone_number_id);
    return;
  }

  await showReceiveAddress(to, phone_number_id, coin, network);
}

/** GET /crypto/receive?coin=&network= and show the address. */
async function showReceiveAddress(to, phone_number_id, coin, network) {
  const walletsRes = await fetchReceiveWallets({ coin, network });
  const wallets = walletsRes.success ? walletsRes.wallets || [] : [];
  const wallet =
    wallets.find(
      (w) => String(w.network).toLowerCase() === String(network).toLowerCase(),
    ) || wallets[0];

  if (!wallet) {
    await sendWhatsApp(
      to,
      `⚠️ Unable to load your ${coin} address on ${network} right now. Please try again shortly.`,
      phone_number_id,
    );
  } else {
    await sendWhatsApp(to, buildReceiveAddressText(wallet), phone_number_id);
  }

  const session = await getSession(to);
  await updateSession(to, { data: { ...session.data, receive: null } });
  await sendMainMenu(to, phone_number_id);
}

/**
 * Start a send at the coin step. `type` is "EXTERNAL" (on-chain) or "P2P".
 *
 * P2P (send to another Vixa user) is switched off by product decision —
 * every transfer now goes on-chain — so all callers pass "EXTERNAL". The
 * P2P path (phone number step, p2p payload) is still in place below.
 */
async function startSend(to, phone_number_id, type = "EXTERNAL") {
  const coinsRes = await getSupportedCoins(
    type === "P2P"
      ? TRANSACTION_TYPES.SEND_INTERNAL
      : TRANSACTION_TYPES.SEND_EXTERNAL,
  );

  if (!coinsRes.success) {
    await sendWhatsApp(
      to,
      "⚠️ Unable to load supported coins right now. Please try again shortly.",
      phone_number_id,
    );
    return;
  }

  const coins = coinsRes.coins;
  if (!coins.length) {
    await sendWhatsApp(
      to,
      "⚠️ No coins are available to send right now. Please try again shortly.",
      phone_number_id,
    );
    return;
  }

  const uniqueCoins = Array.from(
    new Map(coins.map((c) => [c.coin, c])).values(),
  );

  const session = await getSession(to);
  await updateSession(to, {
    data: {
      ...session.data,
      send: { step: "SELECT_COIN", type, coins },
    },
  });

  await triggerItemSelectionFlow(to, phone_number_id, {
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
}

/**
 * The "Who are you sending to?" menu. Unused while P2P is switched off —
 * kept so P2P can come back: uncomment the P2P row and call this from
 * SEND_CRYPTO and routeToFlow("SEND") instead of startSend().
 */
// eslint-disable-next-line no-unused-vars
async function sendRecipientTypeMenu(to, phone_number_id) {
  const session = await getSession(to);
  await updateSession(to, {
    data: { ...session.data, send: { step: "SELECT_SEND_TYPE" } },
  });
  await sendWhatsApp(
    to,
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
                // P2P switched off — every transfer goes on-chain now.
                // {
                //   id: "SEND_TYPE_P2P",
                //   title: "Another Vixa user",
                //   description: "Send to a phone number",
                // },
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

          // Each message gets its own token store — see runWithUserContext
          // in auth.service.js. `return` below ends this message only.
          await runWithUserContext(from, async () => {
            // Meta redelivers webhooks it did not get a prompt 200 for — which
            // is every message that arrived while the container was down. Without
            // this, each redelivery replays the whole handler and the user gets
            // the same replies over and over, unprompted.
            if (!markMessageSeen(msg.id)) {
              console.log(`Duplicate message ${msg.id} from ${from} — skipping`);
              logger.info("webhook.duplicate", { messageId: msg.id });
              return;
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
                return;
              }

              const preState = describeFlowState(session.data);

              if (process.env.VIXA_VOICE_ENABLED === "false") {
                await sendWhatsApp(
                  from,
                  "🎤 Voice notes aren't available right now — please type your message.",
                  phone_number_id,
                );
                return;
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
                logger.info("voice.refused", {
                  messageId: msg.id,
                  flow: preState.flow,
                  step: preState.step,
                  sealed: preState.sealed,
                });
                return;
              }

              const mediaId = msg.audio?.id || msg.voice?.id;
              const media = await downloadWhatsAppMedia(mediaId);

              if (!media) {
                await sendWhatsApp(
                  from,
                  "⚠️ I couldn't open that voice note. Please try again, or type your message.",
                  phone_number_id,
                );
                return;
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
                return;
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
                    return;
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
                  return;
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
              return;
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
                  `💰 Enter amount of *${coin}* to swap`,
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
                      step: "AWAITING_SWAP_CONFIRM",
                      toCoin,
                      quote: quote.data.data,
                      quoteId: quote.data.data?.quoteId ?? null,
                    },
                  },
                });

                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "button",
                      body: {
                        text: buildSwapQuoteText(quote.data.data, { amount, fromCoin: session.data.swap.fromCoin, toCoin }),
                      },
                      action: {
                        buttons: [
                          { type: "reply", reply: { id: "SWAP_CONFIRM_YES", title: "Yes, Swap" } },
                          { type: "reply", reply: { id: "SWAP_CANCEL", title: "Cancel" } },
                        ],
                      },
                    },
                  },
                  phone_number_id,
                );
                return;
              }

              if (actionId.startsWith("RECEIVE_COIN_")) {
                await receiveCoinPicked(
                  from,
                  phone_number_id,
                  actionId.replace("RECEIVE_COIN_", ""),
                );
                return;
              }

              if (actionId.startsWith("RECEIVE_WALLET_")) {
                await receiveNetworkPicked(
                  from,
                  phone_number_id,
                  actionId.replace("RECEIVE_WALLET_", ""),
                );
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
                    `💸 Enter amount of *${coin}* to send${minLine(chains[0].minWithdrawAmount)}`,
                    phone_number_id,
                  );

                  return;
                }

                // Multi-chain → list selection
                const rows = chains.slice(0, 10).map((ch) => ({
                  id: `SEND_CHAIN_${ch.chain}`,
                  title: ch.chain,
                  description: Number(ch.minWithdrawAmount) > 0 ? `Min: ${ch.minWithdrawAmount}` : "No minimum",
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
                  `💸 Enter amount of *${session.data.send.coin}* to send${minLine(chain.minWithdrawAmount)}`,
                  phone_number_id,
                );

                return;
              }

              // Old "Who are you sending to?" menus are still in users' chats.
              // P2P is switched off, so a P2P tap goes to the external flow.
              if (
                actionId === "SEND_TYPE_P2P" ||
                actionId === "SEND_TYPE_EXTERNAL"
              ) {
                if (actionId === "SEND_TYPE_P2P") {
                  await sendWhatsApp(
                    from,
                    "Sending to another Vixa user isn't available right now. You can send to an external wallet instead 👇",
                    phone_number_id,
                  );
                }
                await startSend(from, phone_number_id, "EXTERNAL");
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
                  // P2P is switched off, so there's no recipient-type question:
                  // go straight to the external coin list. To bring P2P back,
                  // call sendRecipientTypeMenu() here instead.
                  await startSend(from, phone_number_id, "EXTERNAL");

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
                  await startReceive(from, phone_number_id);
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
                      description: c.chain || "Swap",
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

              return;
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
                const depositId = session.data?.depositId ?? null;

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

                // Only "Completed" is confirmed from the API so far. Anything
                // else that isn't a known failure is treated as still in
                // progress, which is what users were always told before.
                const depositStatus = String(
                  confirmDeposit.data?.data?.status || "",
                ).toLowerCase();
                const usdtEstimate = confirmDeposit.data?.data?.usdtEstimate;
                const depositCoin = session.data?.depositCoin || "USDT";

                let confirmText;
                if (confirmDeposit.success && depositStatus === "completed") {
                  confirmText =
                    `✅ *Deposit Completed!*\n\n` +
                    (usdtEstimate != null
                      ? `About *${usdtEstimate} ${depositCoin}* has been added to your wallet.\n\n`
                      : `Your wallet has been credited.\n\n`) +
                    `🧾 Ref: ${confirmDeposit.data?.data?.reference || session.data?.depositReference || "-"}\n\nThanks for using VIXA 🚀`;
                } else if (
                  confirmDeposit.success &&
                  ["failed", "expired", "cancelled", "canceled", "rejected"].includes(depositStatus)
                ) {
                  confirmText =
                    `❌ This deposit was not completed (status: ${confirmDeposit.data.data.status}).\n\n` +
                    `If money left your account, contact support with ref ${confirmDeposit.data?.data?.reference || session.data?.depositReference || "-"}.`;
                } else {
                  confirmText = `✅ Your deposit is currently being processed in the background.\n\nYou’ll receive a notification on WhatsApp (and email, if available) once it’s completed.\n\nThanks for using VIXA 🚀`;
                }

                await sendWhatsApp(from, confirmText, phone_number_id);

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
              // Old "Try Again" buttons from the NIN-only flow still sit in
              // users' chats — send them to the combined KYC form instead.
              if (actionId === "NIN_RETRY" || actionId === "KYC_RETRY") {
                await triggerKYCFlow(from, phone_number_id);
                return;
              }

              // BVN reminder CTA sent as an interactive button (inside the
              // 24-hour window). Template buttons are handled in Edit 3.
              if (actionId === "VERIFY_BVN") {
                await openBvnVerification(from, phone_number_id);
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

              if (actionId === "SEND_CONFIRM_YES") {
                if (!session.data?.send?.quoteId) {
                  await sendWhatsApp(
                    from,
                    "⚠️ That quote is no longer available. Please start the send again.",
                    phone_number_id,
                  );
                  await sendMainMenu(from, phone_number_id);
                  return;
                }
                await updateSession(from, {
                  data: {
                    ...session.data,
                    send: { ...session.data.send, step: "ENTER_PIN" },
                  },
                });
                await triggerPinFlow(from, phone_number_id, "SEND");
                return;
              }

              if (actionId === "SEND_CANCEL") {
                await updateSession(from, {
                  data: { ...session.data, send: null },
                });
                await sendWhatsApp(from, "❌ Send cancelled.", phone_number_id);
                await sendMainMenu(from, phone_number_id);
                return;
              }

              if (actionId === "SWAP_CONFIRM_YES") {
                if (!session.data?.swap?.quote) {
                  await sendWhatsApp(
                    from,
                    "⚠️ That quote is no longer available. Please start the swap again.",
                    phone_number_id,
                  );
                  await sendMainMenu(from, phone_number_id);
                  return;
                }
                await updateSession(from, {
                  data: {
                    ...session.data,
                    swap: { ...session.data.swap, step: "AWAITING_SWAP_PIN" },
                  },
                });
                await triggerPinFlow(from, phone_number_id, "SWAP");
                return;
              }

              if (actionId === "SWAP_CANCEL") {
                await updateSession(from, {
                  data: { ...session.data, swap: null },
                });
                await sendWhatsApp(from, "❌ Swap cancelled.", phone_number_id);
                await sendMainMenu(from, phone_number_id);
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
              return;
            }

            // --- END FIX ---

            // Template quick-reply buttons (reminders sent by the other server,
            // e.g. "Activate My VIXA", "Finish Setup", "Verify BVN") arrive as
            // type "button", NOT as an interactive button_reply. Every tap MUST
            // get a reply — an unrecognised one is treated like the user saying hi.
            if (msg.type === "button") {
              // If the sender set no payload, WhatsApp uses the button label.
              // Normalise both so "Finish Setup", "finish-setup" and
              // "FINISH_SETUP" all match the same key.
              const norm = (s) =>
                String(s || "")
                  .trim()
                  .toUpperCase()
                  .replace(/[^A-Z0-9]+/g, "_")
                  .replace(/^_|_$/g, "");
              const keys = [norm(msg.button?.payload), norm(msg.button?.text)];

              console.log(`Template button from ${from}:`, keys.join(" | "));
              logger.info("template.button", { keys });

              if (keys.includes("VERIFY_BVN")) {
                await openBvnVerification(from, phone_number_id);
              } else if (keys.includes("VERIFY_KYC")) {
                await openKycVerification(from, phone_number_id);
              } else {
                // ACTIVATE_MY_VIXA, FINISH_SETUP, or anything unrecognised.
                await resumeSetup(from, phone_number_id, session);
              }
              return;
            }

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

                const rateRes = await convertRate({
                  fromCurrency: session.data.depositCurrency || "NGN",
                  toCurrency: session.data.depositCoin || "USDT",
                  amount: amountNgn,
                  direction: 0,
                });

                if (!rateRes.success || !rateRes.data?.success || !rateRes.data?.data) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Unable to retrieve exchange rates at the moment. Please try again shortly.",
                    phone_number_id,
                  );
                  return;
                }

                await sendWhatsApp(
                  from,
                  buildDepositEstimateText(rateRes.data.data, amountNgn),
                  phone_number_id,
                );

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

                // No min/max: the swap provider sets none (the API sends 0/0).
                // Anything else the backend rejects comes back from the quote.
                if (isNaN(amount) || amount <= 0) {
                  await sendWhatsApp(
                    from,
                    "⚠️ Enter a valid amount greater than 0.",
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
                    description: c.chain || "Swap",
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

                // P2P: unchanged — straight to PIN.
                if (isP2P) {
                  await updateSession(from, {
                    data: {
                      ...session.data,
                      send: { ...session.data.send, address, step: "ENTER_PIN" },
                    },
                  });
                  await triggerPinFlow(from, phone_number_id, "SEND");
                  return;
                }

                // External: quote first, then confirm, then PIN.
                const { coin, amount, chain } = session.data.send;
                const quoteRes = await fetchSendQuote({
                  coin,
                  chain: chain?.chain,
                  amount,
                  externalAddress: address,
                });

                if (!quoteRes.success || !quoteRes.data?.data?.quoteId) {
                  const rawError =
                    quoteRes.error?.message || "Unknown server error";
                  const friendly = await humanizeError(
                    rawError,
                    "get a send quote",
                  );
                  await sendWhatsApp(from, friendly, phone_number_id);
                  await updateSession(from, {
                    data: { ...session.data, send: null },
                  });
                  await sendMainMenu(from, phone_number_id);
                  return;
                }

                const q = quoteRes.data.data;
                await updateSession(from, {
                  data: {
                    ...session.data,
                    send: {
                      ...session.data.send,
                      address,
                      quote: q,
                      quoteId: q.quoteId,
                      // Made once per quote so a retried execute is the same send.
                      idempotencyKey: `SEND-${randomUUID()}`,
                      step: "AWAITING_SEND_CONFIRM",
                    },
                  },
                });

                await sendWhatsApp(
                  from,
                  {
                    type: "interactive",
                    interactive: {
                      type: "button",
                      body: { text: buildSendQuoteText(q, address) },
                      action: {
                        buttons: [
                          {
                            type: "reply",
                            reply: { id: "SEND_CONFIRM_YES", title: "Yes, Send" },
                          },
                          {
                            type: "reply",
                            reply: { id: "SEND_CANCEL", title: "Cancel" },
                          },
                        ],
                      },
                    },
                  },
                  phone_number_id,
                );
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
                const msgText = buildWithdrawalQuoteText(q);

                await updateSession(from, {
                  data: {
                    ...session.data,
                    withdraw: {
                      ...session.data.withdraw,
                      amount,
                      // Execute needs both. The key is made once per quote so a
                      // retried or double-tapped execute is the same withdrawal.
                      quoteId: q.quoteId ?? null,
                      idempotencyKey: `WITHDRAW-${randomUUID()}`,
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

                // Don't execute here — there's no PIN yet. Confirm the
                // details, then ACCOUNT_CONFIRM_YES asks for the PIN and
                // WITHDRAW_EXECUTE sends it, same as the Nigeria path.
                const { accountNumber, bankName } = session.data.withdraw;

                await updateSession(from, {
                  data: {
                    ...session.data,
                    withdraw: {
                      ...session.data.withdraw,
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
          });
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

  // Never log PIN / NIN / BVN / DOB in plain text.
  const SENSITIVE_FIELDS = /pin|nin|bvn|birth|dob/i;
  console.log(
    "Flow submission fields:",
    Object.fromEntries(
      Object.entries(form || {}).map(([k, v]) => [
        k,
        SENSITIVE_FIELDS.test(k) ? "[redacted]" : v,
      ]),
    ),
  );

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
  // ── NIN / BVN FLOW SUBMISSIONS ──────────────────────────────
  const flowToken = form.flow_token || "";

  // Combined KYC form (NIN + BVN + DOB). NIN first; BVN only if NIN passes.
  if (flowToken.includes("::KYC_VERIFY")) {
    await handleKycSubmission(phone, phone_number_id, form);
    return;
  }

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
    // `bvn` if the Flow is ever rebuilt; current field name as fallback.
    const bvn = String(form.bvn || form.screen_0_BVN_0 || "").trim();

    if (!/^\d{11}$/.test(bvn)) {
      await sendWhatsApp(
        phone,
        "⚠️ Your BVN must be 11 digits. Please try again 👇",
        phone_number_id,
      );
      await triggerBVNFlow(phone, phone_number_id);
      return;
    }

    const live = await ensureLiveToken(
      phone,
      phone_number_id,
      "🔐 Your session expired before we could verify your BVN. Please sign in — we'll bring the BVN form straight back.",
    );
    if (!live) return;

    let bvnOk = false;
    try {
      const me = await fetchAuthMe();
      const verifyRes = await verifyBVN({
        bvn,
        firstName: me?.firstName || "",
        lastName: me?.lastName || "",
      });
      bvnOk = !!verifyRes?.success;
      // Log the outcome only — the response may echo identity data.
      console.log("BVN-only verify success:", bvnOk, "for", phone);
    } catch (err) {
      console.error("BVN verification error:", err?.message);
    }

    // Pass or fail, the user continues. On fail, the backend reminds again.
    await sendWhatsApp(
      phone,
      bvnOk
        ? "✅ Your BVN has been verified — your identity verification is complete!"
        : "⏳ We're still confirming your BVN. If we need anything else from you, we'll message you here.",
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

  // ── ONBOARDING: personal details + PIN only ─────────────────
  // NIN / BVN / DOB are collected separately by the KYC form
  // (see handleKycSubmission). New Flow keys first; old keys as fallback
  // so onboarding forms already sitting in chats still work.
  const firstName =
    form.first_name || form.screen_0_First_Name_0 || form.First_Name_4f74a5;
  const lastName =
    form.last_name || form.screen_0_Last_Name_1 || form.Last_Name_76477c;
  const email = form.email || form.screen_0_Email_2;
  const onboardingPin = form.pin || form.screen_0_Pin_6;
  const confirmPin = form.confirm_pin || form.screen_0_Confirm_Pin_7;

  let validationError = null;
  if (!firstName || !lastName || !email || !onboardingPin || !confirmPin) {
    validationError = "Missing required fields.";
  } else if (!/^\d{4}$/.test(String(onboardingPin))) {
    validationError = "Your PIN must be exactly 4 digits.";
  } else if (onboardingPin !== confirmPin) {
    validationError = "PINs do not match.";
  }

  if (validationError) {
    console.warn("Onboarding validation failed:", validationError);
    await sendWhatsApp(
      phone,
      `❌ Onboarding failed: ${validationError}\n\nTap below to fill the form again 👇`,
      phone_number_id,
    );
    await triggerFlow(phone, phone_number_id);
    return;
  }

  console.log("Starting onboarding for:", phone);

  try {
    // 1. CREATE ACCOUNT
    //    firstName / lastName / email / pin → from the form
    //    phoneNumber  → `phone`, from the incoming WhatsApp message (msg.from)
    //    phoneNumberId → `phone_number_id`, from the webhook metadata
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

    // 2. LOG IN IMMEDIATELY — the NIN / BVN endpoints need this token
    try {
      await loginUser({ phoneNumber: phone, pin: onboardingPin });
    } catch (e) {
      console.error("Auto-login after onboarding failed:", e?.message);
      // Next message → PIN login → the BasicInfoCompleted stage check
      // opens the KYC form, so nothing is lost.
      await sendWhatsApp(
        phone,
        "✅ Your VIXA account has been created!\n\nWe couldn't sign you in automatically — send any message to sign in with your new PIN and we'll continue your verification from there.",
        phone_number_id,
      );
      return;
    }

    // 3. MARK SIGNED IN — keep the token loginUser() just wrote
    const fresh = await getSession(phone);
    await updateSession(phone, {
      data: {
        ...fresh.data,
        authenticated: true,
        awaitingPin: false,
        pinAttempts: 0,
        firstName,
      },
    });

    // 4. WELCOME + WHY KYC MATTERS
    await sendWhatsApp(
      phone,
      `🎉 Welcome to VIXA, ${firstName}!\n\n` +
        `Your account is ready and your PIN is set.\n\n` +
        `*One last step: verify your identity (KYC)*\n\n` +
        `Before you can deposit, withdraw, send or swap, we need to confirm your NIN, BVN and date of birth. ` +
        `This is required by Nigerian financial regulations, and it protects your wallet from anyone trying to use your identity.\n\n` +
        `It takes less than 2 minutes 👇`,
      phone_number_id,
    );

    // 5. OPEN THE KYC FORM
    const kycSent = await triggerKYCFlow(phone, phone_number_id);
    if (!kycSent) {
      await sendMainMenu(phone, phone_number_id);
    }
  } catch (err) {
    console.error("Onboarding service error:", err);
    await sendWhatsApp(
      phone,
      "🛑 Something went wrong while creating your account. Please try again.",
      phone_number_id,
    );
  }
}

/**
 * Flow submissions skip the webhook's token check, and a reminder CTA can be
 * tapped hours later. Refresh silently if possible; otherwise ask for the
 * PIN. After login, the onboardingStage check re-opens the right form
 * (BasicInfoCompleted → KYC, NinVerified → BVN).
 */
async function ensureLiveToken(phone, phone_number_id, expiredMessage) {
  let session = await getSession(phone);
  restoreCachedToken(session.data);

  if (isSessionTokenValid(session.data)) return true;

  const refreshStillValid = session.data?.refreshTokenExpiresAt
    ? Date.now() < session.data.refreshTokenExpiresAt
    : !!session.data?.refreshToken;

  if (session.data?.refreshToken && refreshStillValid) {
    const r = await refreshAccessToken({
      phoneNumber: phone,
      refreshToken: session.data.refreshToken,
    });
    if (r?.success) {
      session = await getSession(phone);
      restoreCachedToken(session.data);
      return true;
    }
  }

  await updateSession(phone, {
    data: {
      ...session.data,
      authenticated: false,
      awaitingPin: true,
      pinAttempts: 0,
    },
  });
  await sendWhatsApp(phone, expiredMessage, phone_number_id);
  await triggerPinFlow(phone, phone_number_id, "LOGIN");
  return false;
}

/** Entry point for the backend's BVN reminder CTA (payload VERIFY_BVN). */
async function openBvnVerification(phone, phone_number_id) {
  const live = await ensureLiveToken(
    phone,
    phone_number_id,
    "🔐 Please sign in first — your BVN form will open right after.",
  );
  if (!live) return;
  await triggerBVNFlow(phone, phone_number_id);
}

/** Entry point for a "Verify identity" reminder CTA (payload VERIFY_KYC). */
async function openKycVerification(phone, phone_number_id) {
  const live = await ensureLiveToken(
    phone,
    phone_number_id,
    "🔐 Please sign in first — your verification form will open right after.",
  );
  if (!live) return;
  await triggerKYCFlow(phone, phone_number_id);
}

/**
 * "Activate My VIXA" / "Finish Setup" / any unrecognised template tap.
 * Same outcome as the user typing "hi", but explicit — so a tap while a PIN
 * is pending re-sends the PIN form instead of being read as a wrong PIN.
 */
async function resumeSetup(phone, phone_number_id, session) {
  // Already signed in → nothing to set up from here.
  if (session.data?.authenticated) {
    await sendWhatsApp(
      phone,
      "👋 You're signed in — here's what you can do:",
      phone_number_id,
    );
    await sendMainMenu(phone, phone_number_id);
    return;
  }

  // Mid-login → just re-send the PIN form.
  if (session.data?.awaitingPin) {
    await triggerPinFlow(phone, phone_number_id, "LOGIN");
    return;
  }

  const checkData = await checkPhoneNumber(phone);

  if (!checkData) {
    await sendWhatsApp(
      phone,
      "⚠️ Service momentarily unavailable. Please try again later.",
      phone_number_id,
    );
    return;
  }

  if (checkData.exists) {
    // Registered → sign in. After login, the onboarding stage check sends
    // the KYC or BVN form if either is still outstanding.
    await updateSession(phone, {
      data: {
        ...(session.data || {}),
        awaitingPin: true,
        pinAttempts: 0,
      },
    });
    await triggerPinFlow(phone, phone_number_id, "LOGIN");
    return;
  }

  // Not registered → onboarding form.
  notifyOnboardingStageStarted(phone, phone_number_id);
  await triggerFlow(phone, phone_number_id);
}

/* ------------- KYC: NIN first, BVN only if NIN passes ------------- */
async function handleKycSubmission(phone, phone_number_id, form) {
  const nin = String(form.nin || "").trim();
  const bvn = String(form.bvn || "").trim();
  const rawDob = form.date_of_birth;

  // 1. Validate the form itself
  if (!/^\d{11}$/.test(nin) || !/^\d{11}$/.test(bvn) || !rawDob) {
    await sendWhatsApp(
      phone,
      "⚠️ Your NIN and BVN must each be 11 digits, and your date of birth is required.\n\nPlease fill the form again 👇",
      phone_number_id,
    );
    await triggerKYCFlow(phone, phone_number_id);
    return;
  }

  // 2. Make sure we have a live token
  const live = await ensureLiveToken(
    phone,
    phone_number_id,
    "🔐 Your session expired before we could verify you. Please sign in — we'll bring the verification form straight back.",
  );
  if (!live) return;

  // 3. Names come from the account, not the form
  let me = null;
  try {
    me = await fetchAuthMe();
  } catch (err) {
    console.error("KYC: fetchAuthMe failed:", err?.message);
  }

  if (!me?.firstName) {
    await sendWhatsApp(
      phone,
      "⚠️ We couldn't load your profile just now. Please try again 👇",
      phone_number_id,
    );
    await triggerKYCFlow(phone, phone_number_id);
    return;
  }

  // 4. VERIFY NIN
  let ninStatus = null;
  try {
    const ninRes = await verifyNIN({
      nin,
      firstName: me.firstName,
      lastName: me.lastName || "",
      dateOfBirth: formatDobToISO(rawDob),
    });
    const s = ninRes?.data?.data?.status;
    ninStatus = s == null ? null : String(s);
    console.log("KYC: NIN status", ninStatus, "for", phone);
  } catch (err) {
    console.error("KYC: verifyNIN threw:", err?.message);
  }

  // Under review — neither passed nor failed. Don't call BVN and don't
  // re-send the form (resubmitting mid-review would collide). The backend
  // sends the BVN reminder once the NIN clears.
  if (ninStatus === "1" || ninStatus === "6") {
    await sendWhatsApp(
      phone,
      "⏳ Your NIN is under review. Once it's approved, we'll send you a message here to confirm your BVN and finish your verification.",
      phone_number_id,
    );
    await sendMainMenu(phone, phone_number_id);
    return;
  }

  // Anything other than "2" is a fail → tell them, re-open the form.
  if (ninStatus !== "2") {
    const text =
      ninStatus === "4"
        ? "⚠️ Verification is temporarily unavailable on our side. Please try again 👇"
        : "❌ *KYC not eligible*\n\nWe couldn't verify your NIN with the details provided. Please make sure your NIN, BVN and date of birth match your official records exactly, then try again 👇";
    await sendWhatsApp(phone, text, phone_number_id);
    await triggerKYCFlow(phone, phone_number_id);
    return;
  }

  // 5. NIN PASSED → NOW (and only now) VERIFY BVN
  let bvnOk = false;
  try {
    const bvnRes = await verifyBVN({
      bvn,
      firstName: me.firstName,
      lastName: me.lastName || "",
    });
    bvnOk = !!bvnRes?.success;
    console.log("KYC: BVN success", bvnOk, "for", phone);
  } catch (err) {
    console.error("KYC: verifyBVN threw:", err?.message);
  }

  if (!bvnOk) {
    // NIN passed, BVN didn't. Don't block the user — the backend follows up
    // with a reminder whose CTA (payload VERIFY_BVN) opens the BVN-only flow.
    await sendWhatsApp(
      phone,
      "✅ Your NIN has been verified.\n\n⏳ We're still confirming your BVN. If we need anything else from you, we'll message you here with a button to complete it.\n\nYou can carry on using VIXA in the meantime 👇",
      phone_number_id,
    );
    await sendMainMenu(phone, phone_number_id);
    return;
  }

  // 6. FULLY VERIFIED
  const fresh = await getSession(phone);
  await updateSession(phone, {
    step: "COMPLETED",
    data: { ...fresh.data, firstName: me.firstName },
  });

  await sendWhatsApp(
    phone,
    `✅ *You're verified, ${me.firstName}!*\n\n` +
      `I'm VIXA, your AI-powered wallet assistant. I'll help you send, receive, convert and manage money — NGN and crypto (USDT, BTC, ETH) — right here on WhatsApp.\n\n` +
      `For your security, please make sure your WhatsApp is locked 🔒\n\n` +
      `Let's get started 🚀`,
    phone_number_id,
  );
  await sendMainMenu(phone, phone_number_id);
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
          // Onboarded, KYC not started → combined KYC form
          if (onboardingStage === "BasicInfoCompleted") {
            await sendWhatsApp(
              phone,
              `👋 Welcome back ${me.firstName}!\n\nYour identity verification (KYC) isn't done yet. Complete it to unlock deposits, withdrawals, transfers and swaps 👇`,
              phone_number_id,
            );
            await triggerKYCFlow(phone, phone_number_id);
            return;
          }

          // NIN submitted but not yet passed → BVN must wait
          if (onboardingStage === "NinSubmitted") {
            await sendWhatsApp(
              phone,
              `👋 Welcome back ${me.firstName}!\n\n⏳ Your NIN is still under review. Once it's approved, we'll send you a message here to confirm your BVN.`,
              phone_number_id,
            );
            await sendMainMenu(phone, phone_number_id);
            return;
          }

          // NIN passed, BVN outstanding → BVN-only form
          if (onboardingStage === "NinVerified") {
            await sendWhatsApp(
              phone,
              `👋 Welcome back ${me.firstName}!\n\nYour NIN is verified. Please confirm your BVN to finish your verification 👇`,
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
        "9ae16e52-d562-4d8c-85ec-252ad247d0af",
        session.data.depositCoin,
        "CORR-${Date.now()",
        "IDEMPOTENCY-${Date.now()",
      );
      const depositResult = await depositCrypto({
        currency: session.data.depositCurrency,
        amountLocal: session.data.depositAmount,
        channelId: "9ae16e52-d562-4d8c-85ec-252ad247d0af",
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

      // The create-deposit response may carry the deposit ID as `id` or as
      // `intentId` (per backend). Use whichever is present — confirmPayment()
      // needs it when the user taps "Have Paid".
      const depositId =
        depositData.id ?? depositData.intentId ?? depositData.depositId ?? null;

      if (!depositId) {
        // Field NAMES only — shows where the ID actually is if this ever fires.
        console.error(
          "DEPOSIT: no id/intentId in create-deposit response. Keys:",
          Object.keys(depositData || {}).join(", "),
        );
      }

      await updateSession(phone, {
        data: {
          ...session.data,
          pendingDeposit: false,
          awaitingDepositPin: false,
          awaitingDepositConfirmation: true,
          depositReference: depositData.reference,
          depositId,
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
      const { fromCoin, amount, toCoin, quoteId, quote } = session.data.swap;

      const swapResult = await executeSwap({
        fromCoin,
        fromAmount: amount,
        toCoin,
        pin,
        quoteId,
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
        buildSwapResultText(swapResult.data?.data, { amount, fromCoin, toCoin, quote }),
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
      const { coin, amount, address, chain, type, quoteId, idempotencyKey } =
        session.data.send;

      const sendRes = await executeSendCrypto({
        type,
        coin,
        chain: chain?.chain,
        amount,
        phoneNumber: phone,
        externalAddress: address,
        pin,
        quoteId,
        idempotencyKey,
      });

      if (!sendRes.success) {
        const rawError = sendRes.error?.message || "Unknown server error";
        const friendly = await humanizeError(rawError, "send crypto");
        await sendWhatsApp(phone, friendly, phone_number_id);
        return;
      }

      await sendWhatsApp(
        phone,
        type === "P2P"
          ? `✅ *Transfer Successful!*\n\n${amount} ${coin} sent\nTo: ${address}\n\n🚀 Transaction submitted`
          : buildSendSubmittedText(sendRes.data?.data, address),
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
      const msgText = buildWithdrawalQuoteText(q);

      await updateSession(phone, {
        data: {
          ...session.data,
          withdraw: {
            ...session.data.withdraw,
            quoteId: q.quoteId ?? null,
            idempotencyKey: `WITHDRAW-${randomUUID()}`,
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
      const {
        coin,
        amount,
        accountNumber,
        accountName,
        networkId,
        channelId,
        quoteId,
        idempotencyKey,
        bankName,
      } = session.data.withdraw;

      const execRes = await executeWithdrawal({
        coin,
        amount,
        accountNumber,
        accountName,
        networkId,
        channelId,
        pin,
        quoteId,
        idempotencyKey,
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

      await sendWhatsApp(
        phone,
        buildWithdrawalSubmittedText(execRes.data, {
          accountName,
          bankName,
          accountNumber,
        }),
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
        `💰 Enter amount of *${selectedId}* to swap`,
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
            step: "AWAITING_SWAP_CONFIRM",
            toCoin,
            quote: quote.data.data,
            quoteId: quote.data.data?.quoteId ?? null,
          },
        },
      });

      await sendWhatsApp(
        phone,
        {
          type: "interactive",
          interactive: {
            type: "button",
            body: {
              text: buildSwapQuoteText(quote.data.data, { amount, fromCoin: fromCoin, toCoin }),
            },
            action: {
              buttons: [
                { type: "reply", reply: { id: "SWAP_CONFIRM_YES", title: "Yes, Swap" } },
                { type: "reply", reply: { id: "SWAP_CANCEL", title: "Cancel" } },
              ],
            },
          },
        },
        phone_number_id,
      );
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
          `💸 Enter amount of *${coin}* to send${minLine(chains[0].minWithdrawAmount)}`,
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
          description: Number(ch.minWithdrawAmount) > 0 ? `Min: ${ch.minWithdrawAmount}` : "No minimum",
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
        `💸 Enter amount of *${session.data.send.coin}* to send${minLine(chain.minWithdrawAmount)}`,
        phone_number_id,
      );
      return;
    }

    // ── RECEIVE: coin ────────────────────────────────
    case "RECEIVE_COIN": {
      await receiveCoinPicked(phone, phone_number_id, selectedId);
      return;
    }

    // ── RECEIVE: network ─────────────────────────────
    case "RECEIVE_WALLET": {
      await receiveNetworkPicked(phone, phone_number_id, selectedId);
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

const shortAddress = (a = "") =>
  a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
const hasValue = (v) => v !== undefined && v !== null && v !== "";
const sumFees = (...fees) => {
  const list = fees.filter(hasValue).map(Number);
  return list.length ? Number(list.reduce((a, b) => a + b, 0).toFixed(8)) : null;
};

/**
 * Quote message for POST /crypto/send/quote. Response `data`:
 *   { quoteId, coin, network, amount, networkFee, vixaFee, total, totalDebit, expiresAt }
 * Any field that's missing drops its line instead of printing "undefined".
 */
function buildSendQuoteText(q = {}, address) {
  const coin = q.coin || "";
  const lines = [];
  if (hasValue(q.amount)) lines.push(`Sending: ${q.amount} ${coin}`.trim());
  if (hasValue(q.network)) lines.push(`Network: ${q.network}`);
  if (address) lines.push(`To: ${shortAddress(address)}`);
  const fees = sumFees(q.vixaFee, q.networkFee);
  if (fees !== null) lines.push(`Fees: ${fees} ${coin}`.trim());
  const debit = hasValue(q.totalDebit) ? q.totalDebit : q.total;
  if (hasValue(debit)) lines.push(`Total from your balance: ${debit} ${coin}`.trim());
  if (hasValue(q.expiresAt)) {
    const at = new Date(q.expiresAt);
    if (!isNaN(at)) {
      lines.push(
        `Expires: ${at.toLocaleTimeString("en-NG", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Africa/Lagos",
        })}`,
      );
    }
  }
  return `📤 *Send Quote*\n\n${lines.join("\n") || "Your quote is ready."}\n\nDo you want to send?`;
}

/**
 * Success message for POST /crypto/send (onchain). Response `data`:
 *   { sendId, refId, status, coin, network, amount, networkFee, vixaFee, heldAmount }
 */
function buildSendSubmittedText(r = {}, address) {
  const coin = r?.coin || "";
  const lines = [];
  if (hasValue(r?.amount)) lines.push(`Amount: ${r.amount} ${coin}`.trim());
  if (hasValue(r?.network)) lines.push(`Network: ${r.network}`);
  const fees = sumFees(r?.vixaFee, r?.networkFee);
  if (fees !== null) lines.push(`Fees: ${fees} ${coin}`.trim());
  if (hasValue(r?.heldAmount)) lines.push(`Total debited: ${r.heldAmount} ${coin}`.trim());
  if (address) lines.push(`To: ${shortAddress(address)}`);
  if (hasValue(r?.refId)) lines.push(`Ref: ${r.refId}`);
  if (hasValue(r?.status)) lines.push(`Status: ${r.status}`);
  const body = lines.length ? `${lines.join("\n")}\n\n` : "";
  return `✅ *Send Submitted*\n\n${body}🚀 Your crypto is on its way!`;
}

/**
 * Quote message for GET /swap/quote. Response `data`:
 *   { fromCoin, fromAmount, toCoin, toAmount, swapPrice, fee, expiresAt,
 *     providerFee, vixaFee, quoteId }
 * Any field that's missing drops its line instead of printing "undefined".
 */
function buildSwapQuoteText(q = {}, ctx = {}) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const from = q.fromCoin || ctx.fromCoin || "";
  const to = q.toCoin || ctx.toCoin || "";
  const fromAmount = has(q.fromAmount) ? q.fromAmount : ctx.amount;
  const lines = [];
  if (has(fromAmount)) lines.push(`From: ${fromAmount} ${from}`.trim());
  if (has(q.toAmount)) lines.push(`To: ≈ ${q.toAmount} ${to}`.trim());
  // Fee currency isn't stated by the API, so no coin label.
  if (has(q.fee)) lines.push(`Fee: ${Number(Number(q.fee).toFixed(8))}`);
  if (has(q.expiresAt)) {
    const at = new Date(q.expiresAt);
    if (!isNaN(at)) {
      lines.push(
        `Expires: ${at.toLocaleTimeString("en-NG", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Africa/Lagos",
        })}`,
      );
    }
  }
  return `🔄 *Swap Quote*\n\n${lines.join("\n") || "Your quote is ready."}\n\nDo you want to swap?`;
}

/**
 * Result message for POST /swap. Response `data`:
 *   { fromCoin, toCoin, fromAmount, toAmount, fee, status, oxReference, swapId, ... }
 * Falls back to the quote's toAmount if the response has none.
 */
function buildSwapResultText(r = {}, ctx = {}) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const from = r?.fromCoin || ctx.fromCoin || "";
  const to = r?.toCoin || ctx.toCoin || "";
  const fromAmount = has(r?.fromAmount) && Number(r.fromAmount) ? r.fromAmount : ctx.amount;
  const toAmount = has(r?.toAmount) && Number(r.toAmount) ? r.toAmount : ctx.quote?.toAmount;
  const status = has(r?.status) ? String(r.status) : "";
  const done = !status || /complet|success/i.test(status);

  let text = done ? "✅ *Swap Successful!*\n\n" : "✅ *Swap Submitted*\n\n";
  if (has(fromAmount) && has(toAmount)) text += `${fromAmount} ${from} → ${toAmount} ${to}\n`;
  if (!done) text += `Status: ${status}\n`;
  const ref = r?.oxReference || r?.swapId;
  if (has(ref)) text += `Ref: ${ref}\n`;
  text += done
    ? "\n🎉 Your wallet has been updated."
    : "\n⏳ We'll update your wallet once it's done.";
  return text;
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
    description: c.chain || "Swap",
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

/**
 * Rate message for POST /rates/convert (direction 0). Response `data`:
 *   { fromCurrency, toCurrency, inputAmount, outputAmount, rateUsed, fee,
 *     feePercentage, direction, rateTimestamp, expiresInSeconds }
 * Only an estimate — the deposit itself quotes the final amount.
 * Any field that's missing drops its line instead of printing "undefined".
 */
function buildDepositEstimateText(c = {}, amountEntered) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  // The API answers with "NAIRA"; show it as NGN (₦).
  let from = (c.fromCurrency || "NGN").toUpperCase();
  if (from === "NAIRA") from = "NGN";
  const to = (c.toCurrency || "USDT").toUpperCase();
  const fiat = (v, opts) => {
    const n = Number(v).toLocaleString("en-NG", opts);
    return from === "NGN" ? `₦${n}` : `${n} ${from}`;
  };
  const paid = has(c.inputAmount) ? c.inputAmount : amountEntered;

  const lines = [];
  if (has(paid)) lines.push(`You pay: ${fiat(paid, { maximumFractionDigits: 2 })}`);
  if (has(c.outputAmount)) lines.push(`You'll receive: ≈ ${c.outputAmount} ${to}`);
  if (has(c.fee)) lines.push(`Fee: ${c.fee} ${to}`);
  if (Number(c.rateUsed) > 0) {
    lines.push(`Rate: 1 ${to} ≈ ${fiat(1 / Number(c.rateUsed), { maximumFractionDigits: 0 })}`);
  }

  let text = `💱 *Deposit Estimate*\n\n${lines.join("\n") || "Here's your estimate."}`;
  if (has(c.rateTimestamp)) {
    const at = new Date(c.rateTimestamp);
    if (!isNaN(at)) {
      text += `\n\n🕒 Rate as of: ${at.toLocaleString("en-NG", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Lagos",
      })}`;
    }
  }
  return text;
}

/**
 * Address message for GET /crypto/receive items:
 *   { coin, network, address, memo, txUrlPrefix }
 * The memo line only appears when the network needs one — sending without
 * it can lose the funds.
 */
function buildReceiveAddressText(w = {}) {
  const memo = w.memo ? `🏷️ *Memo/Tag:* \`${w.memo}\`\n⚠️ Include this memo when sending, or the funds may be lost.\n\n` : "";
  return (
    `📥 *${w.coin} Receive Address*\n\n` +
    `Network: ${w.network}\n\n` +
    memo +
    `📌 *Tap & hold to copy address:*\n` +
    `\`\`\`\n${w.address}\n\`\`\``
  );
}

/**
 * Success message for POST /withdrawal/execute. Response `data`:
 *   { withdrawalId, refId, status, coin, network, amountToBank, networkFee,
 *     vixaFee, heldAmount }
 * Bank details aren't in the response, so they come from the session.
 * Any field that's missing drops its line instead of printing "undefined".
 */
function buildWithdrawalSubmittedText(r = {}, bank = {}) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const coin = r?.coin || "";
  const lines = [];

  if (has(r?.heldAmount)) lines.push(`Amount: ${r.heldAmount} ${coin}`.trim());

  const fees = [r?.vixaFee, r?.networkFee].filter(has).map(Number);
  if (fees.length) {
    const totalFees = Number(fees.reduce((a, b) => a + b, 0).toFixed(8));
    lines.push(`Fees: ${totalFees} ${coin}`.trim());
  }

  if (has(bank.accountName)) lines.push(`To: ${bank.accountName}`);
  if (has(bank.bankName)) lines.push(`Bank: ${bank.bankName}`);
  if (has(bank.accountNumber)) lines.push(`Account: ${bank.accountNumber}`);
  if (has(r?.refId)) lines.push(`Ref: ${r.refId}`);
  if (has(r?.status)) lines.push(`Status: ${r.status}`);

  const body = lines.length ? `${lines.join("\n")}\n\n` : "";
  return `✅ *Withdrawal Submitted*\n\n${body}🚀 Funds are on the way!`;
}

/**
 * Quote message for POST /withdrawal/quote. Response `data`:
 *   { quoteId, coin, network, totalDebit, vixaFee, networkFee, amountToBank,
 *     estimatedFiat, fiatCurrency, rate, expiresAt }
 * Any field that's missing drops its line instead of printing "undefined".
 */
function buildWithdrawalQuoteText(q = {}) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const coin = q.coin || "";
  const fiat = q.fiatCurrency || "";
  const money = (v) =>
    Number(v).toLocaleString("en-NG", { maximumFractionDigits: 2 });
  const fiatAmount = (v) =>
    fiat === "NGN" ? `₦${money(v)}` : `${money(v)} ${fiat}`.trim();

  const lines = [];
  if (has(q.totalDebit)) lines.push(`Withdrawing: ${q.totalDebit} ${coin}`.trim());

  const fees = [q.vixaFee, q.networkFee].filter(has).map(Number);
  if (fees.length) {
    // toFixed(8) trims float noise (0.016 + 0.025564 = 0.041564000000000005).
    const totalFees = Number(fees.reduce((a, b) => a + b, 0).toFixed(8));
    lines.push(`Fees: ${totalFees} ${coin}`.trim());
  }

  if (has(q.estimatedFiat))
    lines.push(`You'll receive: ≈ ${money(q.estimatedFiat)} ${fiat}`.trim());
  if (has(q.rate) && coin) lines.push(`Rate: 1 ${coin} = ${fiatAmount(q.rate)}`);

  if (has(q.expiresAt)) {
    const expiry = new Date(q.expiresAt);
    if (!isNaN(expiry)) {
      lines.push(
        `Expires: ${expiry.toLocaleTimeString("en-NG", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Africa/Lagos",
        })}`,
      );
    }
  }

  if (!lines.length) lines.push("Your quote is ready.");

  return `📊 *Withdrawal Quote*\n\n${lines.join("\n")}\n\nDo you want to proceed?`;
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
      // P2P is switched off — see SEND_CRYPTO in the menu handler.
      await startSend(from, phone_number_id, "EXTERNAL");
      break;
    }
    case "RECEIVE": {
      await startReceive(from, phone_number_id);
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
          description: c.chain || "Swap",
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

async function triggerKYCFlow(toPhone, phone_number_id) {
  if (!WHATSAPP_TOKEN || !phone_number_id || !KYC_FLOW_ID) {
    console.log(
      "[MOCK KYC FLOW] to:",
      toPhone,
      KYC_FLOW_ID ? "" : "(KYC_FLOW_ID is not set)",
    );
    return false;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phone_number_id}/messages`;

  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: {
        text: "🪪 *Verify your identity*\n\nHave your NIN and BVN ready — both are 11 digits.",
      },
      action: {
        name: "flow",
        parameters: {
          flow_id: KYC_FLOW_ID,
          flow_token: `${toPhone}::KYC_VERIFY`,
          flow_cta: "Verify Identity",
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
    console.error("triggerKYCFlow failed:", res.status, debug);
    logger.error?.("flow send rejected", {
      flow: "KYC_VERIFY",
      status: res.status,
      debug,
    });
    return false;
  }

  console.log("triggerKYCFlow sent to", toPhone);
  return true;
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
