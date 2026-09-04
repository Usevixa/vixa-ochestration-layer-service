/**
 * VIXA intent router.
 *
 * ONE entry point for every inbound text message, in every state. The old code
 * had two divergent paths — a keyword-only path when the user was mid-flow and
 * an LLM path when they weren't — which is why natural language worked at the
 * menu and stopped working the moment a transaction started.
 *
 * The pipeline, cheapest and safest first:
 *
 *   0. SEALED STATES. If we're waiting on a PIN/OTP/NIN/BVN, the message is
 *      never sent to OpenAI. Full stop. Secrets do not leave this process.
 *   1. FREE-TEXT STATES. If the step wants prose (a lock reason, an account
 *      holder's name), keyword matching is suppressed so "someone stole my
 *      phone" is accepted as the answer instead of restarting the lock flow.
 *   2. DETERMINISTIC KEYWORDS. Unambiguous single intents resolve locally with
 *      no latency and no cost.
 *   3. EXPECTED-VALUE PARSE. A bare number when we asked for a number is
 *      input, not something to reason about.
 *   4. THE MODEL. Only for what's genuinely ambiguous — compound sentences,
 *      questions, confusion. Given the real current state, not a stub.
 *   5. FALLBACK. Model down, slow, or nonsense? Fall back to the best keyword
 *      hit, then to a safe clarifying reply. The bot always says something.
 */

import { describeFlowState } from "./flowState.js";
import { scoreKeywordIntents, normalizeText } from "../utils/intentKeywords.js";
import { classifyMessage } from "../services/ai.service.js";

/** Below this, we ask rather than assume. */
const CONFIDENCE_FLOOR = 0.6;

const DECISION_TYPES = [
  "PROVIDE_INPUT",
  "SWITCH_FLOW",
  "CANCEL",
  "ANSWER",
  "MENU",
  "CLARIFY",
];

/** Steps whose answer is prose — keyword matching would fight the user here. */
const FREE_TEXT_EXPECTATIONS = new Set(["text", "account_name", "tag"]);

/** Only these end a sealed step. Everything else gets a canned nudge. */
const HARD_CANCEL =
  /^(cancel|stop|abort|quit|exit|forget it|nevermind|never mind)$/;

const MENU_REQUEST = /^(menu|main menu|options|home|start|hi|hello|hey)$/;

const COIN_SYMBOLS = [
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

const COIN_ALIASES = {
  BITCOIN: "BTC",
  ETHEREUM: "ETH",
  SOLANA: "SOL",
  TETHER: "USDT",
  DOLLAR: "USDT",
  DOLLARS: "USDT",
  RIPPLE: "XRP",
  TRON: "TRX",
  DOGECOIN: "DOGE",
};

const EMPTY_SLOTS = {
  amount: null,
  fromCoin: null,
  toCoin: null,
  currency: null,
};

/**
 * "5k" -> 5000, "₦20,000" -> 20000, "1.5m" -> 1500000.
 * @returns {number|null}
 */
export function parseAmount(text) {
  if (!text) return null;
  const m = String(text)
    .replace(/[,\s]/g, "")
    .match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!m) return null;

  let value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") value *= 1_000;
  if (suffix === "m") value *= 1_000_000;

  return value > 0 ? value : null;
}

/** True when the whole message is just a number — "5000", "5k", "₦20,000". */
function isBareAmount(text) {
  return /^[₦$n]?\s*\d[\d,]*(\.\d+)?\s*(k|m|naira|ngn|usdt|usd)?$/i.test(
    String(text).trim(),
  );
}

/**
 * Pull transaction details mentioned in passing, so "swap 50 usdt to btc"
 * carries its own answers instead of making the user re-pick from menus.
 */
export function extractSlots(text) {
  const slots = { ...EMPTY_SLOTS };
  if (!text) return slots;

  const tokens = normalizeText(text).trim().split(" ").filter(Boolean);
  const upper = tokens.map((t) => {
    const u = t.toUpperCase();
    return COIN_ALIASES[u] || u;
  });

  const coinPositions = [];
  upper.forEach((tok, i) => {
    if (COIN_SYMBOLS.includes(tok)) coinPositions.push({ coin: tok, i });
  });

  if (coinPositions.length) {
    slots.fromCoin = coinPositions[0].coin;
    if (coinPositions.length > 1) slots.toCoin = coinPositions[1].coin;

    // "to"/"into"/"for" flips which side of the pair a coin sits on.
    const toIdx = tokens.findIndex((t) => t === "to" || t === "into");
    if (toIdx !== -1) {
      const after = coinPositions.find((c) => c.i > toIdx);
      const before = coinPositions.find((c) => c.i < toIdx);
      if (after) slots.toCoin = after.coin;
      if (before) slots.fromCoin = before.coin;
      if (after && !before) slots.fromCoin = null;
    }
  }

  if (/naira|ngn|₦/i.test(text)) slots.currency = "NGN";

  // Read the amount off the RAW text, not the normalised tokens — normalising
  // strips the decimal point, which turned "send 0.5 eth" into "0" and "5".
  const amountMatch = String(text).match(/(\d[\d,]*(?:\.\d+)?)\s*([km])?\b/i);
  if (amountMatch) {
    slots.amount = parseAmount(`${amountMatch[1]}${amountMatch[2] || ""}`);
  }

  return slots;
}

function mergeSlots(base, extra) {
  const merged = { ...EMPTY_SLOTS, ...(base || {}) };
  for (const key of Object.keys(EMPTY_SLOTS)) {
    if (merged[key] == null && extra?.[key] != null) merged[key] = extra[key];
  }
  return merged;
}

function decision(partial) {
  return {
    type: "ANSWER",
    flow: null,
    value: null,
    slots: { ...EMPTY_SLOTS },
    reply: null,
    confidence: 1,
    source: "keyword",
    // Only ever set on the LLM path. The sealed, keyword and value paths
    // don't look at language at all — null here means "no opinion", which
    // is not the same as "English".
    language: null,
    languageConfidence: 0,
    ...partial,
  };
}

/**
 * Resolve one inbound message into an action the webhook can execute.
 *
 * @param {object}  args
 * @param {string}  args.text        - raw message body
 * @param {object}  args.sessionData - session.data
 * @param {object} [args.profile]    - { firstName }
 * @returns {Promise<{
 *   type: 'PROVIDE_INPUT'|'SWITCH_FLOW'|'CANCEL'|'ANSWER'|'MENU'|'CLARIFY',
 *   flow: string|null,
 *   value: string|null,
 *   slots: object,
 *   reply: string|null,
 *   confidence: number,
 *   source: 'sealed'|'keyword'|'value'|'llm'|'fallback',
 *   state: object,
 * }>}
 */
export async function resolveIntent({ text, sessionData, profile }) {
  const state = describeFlowState(sessionData);
  const raw = (text || "").trim();
  const withState = (d) => ({ ...d, state });

  if (!raw) {
    return withState(
      decision({
        type: "ANSWER",
        reply: "I didn't catch that — could you send it again?",
        source: "fallback",
      }),
    );
  }

  const lower = raw.toLowerCase();

  // ── 0. Sealed states: secrets never reach the model ──────────────
  if (state.sealed) {
    // OTPs are typed and have handlers in the state machine. PINs are NOT —
    // they come back through the PIN Flow (processFlowCompletion), so a typed
    // PIN has nothing to claim it and used to fall all the way through to
    // "I didn't quite get that", trapping the user in a loop with their PIN
    // sitting in plaintext in the chat.
    if (/^\d{4,8}$/.test(raw)) {
      if (state.expecting === "pin") {
        return withState(
          decision({
            type: "ANSWER",
            reply:
              "🔒 For your security, please use the *Enter PIN* button above rather than typing it here.\n\nI'd also delete that message from this chat.",
            source: "sealed",
          }),
        );
      }
      return withState(
        decision({ type: "PROVIDE_INPUT", value: raw, source: "sealed" }),
      );
    }

    if (state.expecting === "otp" && lower === "resend") {
      return withState(
        decision({ type: "PROVIDE_INPUT", value: "resend", source: "sealed" }),
      );
    }

    if (HARD_CANCEL.test(lower)) {
      return withState(decision({ type: "CANCEL", source: "sealed" }));
    }

    // Local scan only — this text is NOT sent anywhere.
    const local = scoreKeywordIntents(raw);
    if (local.flows.length && !local.negated) {
      return withState(
        decision({
          type: "SWITCH_FLOW",
          flow: local.flows[0].flow,
          slots: extractSlots(raw),
          confidence: 0.8,
          source: "sealed",
        }),
      );
    }

    return withState(
      decision({
        type: "ANSWER",
        reply:
          "For your security I can only accept the code here. Send it to continue, or type *cancel* to stop.",
        source: "sealed",
      }),
    );
  }

  // ── 1. Explicit menu request ─────────────────────────────────────
  if (MENU_REQUEST.test(lower) && !state.active) {
    return withState(decision({ type: "MENU", source: "keyword" }));
  }

  // ── 2. Free-text steps: only a hard cancel escapes ───────────────
  if (FREE_TEXT_EXPECTATIONS.has(state.expecting)) {
    if (HARD_CANCEL.test(lower)) {
      return withState(decision({ type: "CANCEL", source: "keyword" }));
    }
    return withState(
      decision({ type: "PROVIDE_INPUT", value: raw, source: "value" }),
    );
  }

  // ── 3. Deterministic keyword layer ───────────────────────────────
  const scored = scoreKeywordIntents(raw);
  const slots = extractSlots(raw);

  // "I don't want to deposit" — negation attached to a flow means stop.
  if (scored.negated && scored.cancel) {
    return withState(decision({ type: "CANCEL", source: "keyword" }));
  }

  // Cancel with no replacement action.
  if (scored.cancel && !scored.flows.length) {
    return withState(decision({ type: "CANCEL", source: "keyword" }));
  }

  // THE BUG FROM THE SCREENSHOTS: "Scratch that I want to swap".
  // A cancel and a flow in the same sentence. If the flow is mentioned after
  // the cancel, the flow is what they landed on — route there, don't just
  // cancel and drop them at the menu.
  if (scored.cancel && scored.flows.length) {
    const after = scored.flows.find((f) => f.at > scored.cancel.at);
    if (after) {
      return withState(
        decision({
          type: "SWITCH_FLOW",
          flow: after.flow,
          slots,
          confidence: 0.9,
          source: "keyword",
        }),
      );
    }
    // Flow mentioned first, cancel second ("deposit — actually, cancel").
    // Genuinely ambiguous: let the model read it.
  }

  // One clear winner and nothing competing with it.
  if (!scored.ambiguous && scored.flows.length && !scored.cancel) {
    return withState(
      decision({
        type: "SWITCH_FLOW",
        flow: scored.flows[0].flow,
        slots,
        confidence: 0.95,
        source: "keyword",
      }),
    );
  }

  // ── 4. The message is simply the value we asked for ──────────────
  if (!scored.flows.length && !scored.cancel) {
    if (state.expecting === "amount" && isBareAmount(raw)) {
      const amount = parseAmount(raw);
      if (amount != null) {
        return withState(
          decision({
            type: "PROVIDE_INPUT",
            value: String(amount),
            source: "value",
          }),
        );
      }
    }

    if (state.expecting === "account_number" && /^\d{6,20}$/.test(raw)) {
      return withState(
        decision({ type: "PROVIDE_INPUT", value: raw, source: "value" }),
      );
    }

    // A P2P recipient's phone number. Accept the shapes Nigerians actually
    // type — 08012345678, 2348012345678, +2348012345678 — and strip spaces
    // and dashes first. Without this the number reaches the model, costing a
    // round trip, and a model timeout drops them on "I didn't quite get that"
    // in the middle of a transfer.
    if (state.expecting === "phone") {
      const digits = raw.replace(/[\s-]/g, "");
      if (/^\+?\d{10,15}$/.test(digits)) {
        return withState(
          decision({ type: "PROVIDE_INPUT", value: digits, source: "value" }),
        );
      }
    }

    // A wallet address: one long unbroken token, no spaces.
    if (state.expecting === "address" && /^[a-zA-Z0-9:_-]{20,}$/.test(raw)) {
      return withState(
        decision({ type: "PROVIDE_INPUT", value: raw, source: "value" }),
      );
    }
  }

  // ── 5. Ambiguous, conversational, or unrecognised → the model ────
  const ai = await classifyMessage({
    text: raw,
    state,
    profile,
    lang: sessionData?.lang,
  });

  if (ai && DECISION_TYPES.includes(ai.type)) {
    const confidence = typeof ai.confidence === "number" ? ai.confidence : 0.5;

    // A SWITCH_FLOW with no flow is meaningless — don't act on it.
    if (ai.type === "SWITCH_FLOW" && !ai.flow) {
      return withState(
        decision({
          type: "CLARIFY",
          reply: "Sorry — which would you like to do?",
          source: "llm",
          confidence,
        }),
      );
    }

    // Never let a low-confidence guess destroy a transaction the user is
    // one PIN away from completing. Ask instead.
    if (
      ai.type === "SWITCH_FLOW" &&
      confidence < CONFIDENCE_FLOOR &&
      state.active
    ) {
      return withState(
        decision({
          type: "CLARIFY",
          flow: ai.flow,
          reply: `Just to be sure — do you want to leave this ${state.flow?.toLowerCase().replace("_", " ")} and start a ${ai.flow.toLowerCase().replace("_", " ")} instead?`,
          source: "llm",
          confidence,
        }),
      );
    }

    return withState(
      decision({
        type: ai.type,
        flow: ai.flow || null,
        value: ai.value || null,
        slots: mergeSlots(ai.slots, slots),
        reply:
          ai.type === "ANSWER"
            ? ai.reply ||
              "I'm here to help with your VIXA wallet — what would you like to do?"
            : null,
        confidence,
        language: ai.language || null,
        languageConfidence:
          typeof ai.languageConfidence === "number" ? ai.languageConfidence : 0,
        source: "llm",
      }),
    );
  }

  // ── 6. Model unavailable: fall back to the strongest keyword hit ─
  if (scored.flows.length) {
    return withState(
      decision({
        type: "SWITCH_FLOW",
        flow: scored.flows[0].flow,
        slots,
        confidence: 0.5,
        source: "fallback",
      }),
    );
  }

  if (scored.cancel) {
    return withState(decision({ type: "CANCEL", source: "fallback" }));
  }

  // Nothing matched and the model is down. Say something useful, never
  // nothing — and never dump the menu on top of a live transaction.
  return withState(
    decision({
      type: state.active ? "ANSWER" : "MENU",
      reply: state.active ? "Sorry, I didn't quite get that." : null,
      source: "fallback",
      confidence: 0.3,
    }),
  );
}
