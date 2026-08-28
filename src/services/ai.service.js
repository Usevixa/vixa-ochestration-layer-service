import OpenAI from "openai";
import { KNOWN_FLOWS } from "../utils/intentKeywords.js";

/**
 * Lazily constructed. `new OpenAI()` throws when OPENAI_API_KEY is absent, and
 * at module scope that took the entire server down at import time rather than
 * degrading to the deterministic keyword path.
 */
let _openai = null;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/**
 * gpt-4.1-mini is both cheaper and materially better at instruction-following
 * than 4o-mini, which is what this was pinned to. Override per-environment if
 * you want to A/B it.
 */
const INTENT_MODEL = process.env.VIXA_INTENT_MODEL || "gpt-4.1-mini";

/** A slow model must never hold a WhatsApp reply hostage. */
const INTENT_TIMEOUT_MS = Number(process.env.VIXA_INTENT_TIMEOUT_MS || 6000);

const FLOW_CATALOGUE = `
- DEPOSIT — buy USDT with Nigerian Naira. The user funds their VIXA wallet from cash/bank. Triggered by "deposit", "fund my wallet", "buy usdt", "top up", "naira to dollar".
- WITHDRAW — cash out crypto to a bank account or mobile money. Triggered by "withdraw", "cash out", "sell my usdt", "send to my bank", "usdt to naira".
- SWAP — exchange one crypto for another inside VIXA (e.g. BTC → USDT). Triggered by "swap", "convert btc to usdt".
- SEND — send crypto out to another VIXA user or an external blockchain address.
- RECEIVE — show the user their own deposit/receiving wallet address so someone else can send them crypto.
- BALANCE — show current wallet balances.
- SUPPORT — contact the VIXA support team.
- CHANGE_PIN — change or reset the 4-digit transaction PIN.
- LOCK_WALLET — freeze the wallet (lost phone, suspected fraud).
- UNLOCK_WALLET — restore access to a locked wallet.
- SETTINGS — open the account settings menu.
`.trim();

const INTENT_SCHEMA = {
  name: "vixa_intent",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: ["PROVIDE_INPUT", "SWITCH_FLOW", "CANCEL", "ANSWER", "MENU"],
        description:
          "PROVIDE_INPUT = the message is the value the current step asked for. SWITCH_FLOW = they want to start/move to a different action. CANCEL = they want out, with no replacement action. ANSWER = a question, greeting or confusion that deserves a reply but must NOT change any state. MENU = they explicitly asked to see the list of options.",
      },
      flow: {
        // Deliberately not an enum: strict-mode enums that include null are
        // brittle across API versions, and classifyMessage() validates the
        // value against KNOWN_FLOWS on the way out anyway.
        type: ["string", "null"],
        description: `Required when type is SWITCH_FLOW, null otherwise. Must be one of: ${KNOWN_FLOWS.join(", ")}.`,
      },
      value: {
        type: ["string", "null"],
        description:
          "The exact value extracted when type is PROVIDE_INPUT. Null otherwise.",
      },
      slots: {
        type: "object",
        additionalProperties: false,
        properties: {
          amount: { type: ["number", "null"] },
          fromCoin: { type: ["string", "null"] },
          toCoin: { type: ["string", "null"] },
          currency: { type: ["string", "null"] },
        },
        required: ["amount", "fromCoin", "toCoin", "currency"],
        description:
          "Details mentioned in passing, e.g. 'swap 50 usdt to btc' -> amount 50, fromCoin USDT, toCoin BTC.",
      },
      reply: {
        type: ["string", "null"],
        description:
          "Required when type is ANSWER. A short WhatsApp reply, under 45 words.",
      },
      confidence: {
        type: "number",
        description: "0 to 1. Below 0.6 the router will ask for clarification.",
      },
      language: {
        type: ["string", "null"],
        description:
          "BCP-47 code of the language the user wrote in — 'en', 'fr', 'es', 'pt', 'sw'. Nigerian Pidgin is 'en'. Null when the message is too short or ambiguous to tell (a bare number, 'ok', 'yes').",
      },
      languageConfidence: {
        type: "number",
        description:
          "0 to 1, how sure you are of `language`. Be honest: African languages are easily misidentified. Below 0.8 the app keeps the user in English.",
      },
    },
    required: [
      "type",
      "flow",
      "value",
      "slots",
      "reply",
      "confidence",
      "language",
      "languageConfidence",
    ],
  },
};

function buildSystemPrompt(state, profile, lang) {
  const name = profile?.firstName
    ? ` The user's name is ${profile.firstName}.`
    : "";

  return `You are VIXA, a crypto wallet assistant that runs inside WhatsApp for Nigerian users.${name}

You are NOT a chatbot that free-styles. You are a router. Your only job is to
decide what the user's message means so the app can act on it. The app does the
actual work — you never claim to have moved money, and you never invent
balances, rates, fees, addresses or transaction statuses.

WHAT VIXA CAN DO:
${FLOW_CATALOGUE}

WHERE THE USER IS RIGHT NOW:
${state.describe}
${state.expecting ? `We are specifically waiting for: ${state.expecting}.` : ""}

HOW TO DECIDE:

1. If the message is the thing we are waiting for, return PROVIDE_INPUT and put
   the cleaned value in "value". "5k" -> "5000". "N20,000" -> "20000".

2. If the message names a different VIXA action, return SWITCH_FLOW with that
   flow — EVEN IF the user also said something cancel-like in the same breath.
   "Scratch that, I want to swap" is SWITCH_FLOW/SWAP, not CANCEL.
   "No, I want to swap instead" is SWITCH_FLOW/SWAP.
   Wanting a different action already implies cancelling the current one.

3. Return CANCEL only when they want to stop with NO replacement action:
   "cancel", "forget it", "I don't want to do this again", "stop".
   "I don't want to deposit" with nothing after it is CANCEL, not SWITCH_FLOW.

4. If it is a question, a greeting, confusion, or small talk, return ANSWER and
   write "reply". The reply must:
     - answer them in plain, warm language (Nigerian English is fine)
     - be under 45 words, no markdown headers, no bullet lists
     - NOT restate the current step — the app appends that automatically
     - say plainly that you don't know rather than guessing, if you don't know
   "What does this mean?" is ANSWER — explain the step they're on.
   "Are you there?" is ANSWER — reassure them briefly.

5. Return MENU only when they explicitly ask to see options: "menu", "options",
   "what can you do".

NEVER:
- Never return PROVIDE_INPUT for a message that names a financial action.
- Never return SWITCH_FLOW to the flow the user is already in — that is ANSWER
  or PROVIDE_INPUT.
- Never put a PIN, OTP, NIN or BVN into "reply".
- Never promise to do something yourself ("let me check that for you") — the
  app is what acts. Describe what the user should do instead.

Set confidence honestly. If the message is genuinely unclear, use a low
confidence and return ANSWER rather than guessing a flow — a wrong SWITCH_FLOW
destroys a transaction the user was halfway through.

LANGUAGE:
Report the language the user wrote in as "language", with "languageConfidence".
${
  lang && lang !== "en"
    ? `This user's language is set to ${lang}. Write "reply" in ${lang}.`
    : `Write "reply" in English.`
}
Nigerian Pidgin counts as English — report 'en' and reply in English.
A bare number, "ok", "yes" or a single word is NOT enough to identify a
language: return null with a low confidence rather than guessing.`;
}

/**
 * Ask the model to classify one message in context.
 *
 * @returns {Promise<object|null>} null when the model is unavailable or
 *   returns something unusable — callers MUST have a deterministic fallback.
 */
export async function classifyMessage({ text, state, profile, lang }) {
  const openai = getOpenAI();
  if (!openai) return null;

  try {
    const completion = await openai.chat.completions.create(
      {
        model: INTENT_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: buildSystemPrompt(state, profile, lang) },
          { role: "user", content: text },
        ],
        response_format: { type: "json_schema", json_schema: INTENT_SCHEMA },
      },
      { timeout: INTENT_TIMEOUT_MS, maxRetries: 1 },
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    // Trust nothing. The model can still emit a flow we don't implement.
    if (parsed.flow && !KNOWN_FLOWS.includes(parsed.flow)) {
      console.warn("[intent] model returned unknown flow:", parsed.flow);
      parsed.flow = null;
      if (parsed.type === "SWITCH_FLOW") parsed.type = "ANSWER";
    }

    return parsed;
  } catch (err) {
    console.error("[intent] classifyMessage failed:", err?.message || err);
    return null;
  }
}

/**
 * Back-compatible wrapper for the original signature.
 * @deprecated Use resolveIntent() from src/ai/intentRouter.js.
 */
export async function analyzeUserIntent(message, sessionData) {
  // Dynamic import keeps the ai.service <-> intentRouter cycle harmless.
  const { resolveIntent } = await import("../ai/intentRouter.js");

  const decision = await resolveIntent({ text: message, sessionData });
  const legacyType = {
    PROVIDE_INPUT: "PROVIDE_INPUT",
    SWITCH_FLOW: "START_SPECIFIC_FLOW",
    CANCEL: "CANCEL_FLOW",
    ANSWER: "CHITCHAT_OR_CLARIFY",
    MENU: "CHITCHAT_OR_CLARIFY",
    CLARIFY: "CHITCHAT_OR_CLARIFY",
  };

  return {
    intent: legacyType[decision.type] || "CHITCHAT_OR_CLARIFY",
    detectedFlow: decision.flow,
    extractedValue: decision.value,
    replyMessage: decision.reply,
  };
}

/**
 * Translate a technical error into something a non-technical user can read.
 */
export async function humanizeError(
  technicalError,
  context = "processing your request",
) {
  if (!technicalError || technicalError === "[object Object]") {
    return "⚠️ Something went unexpectedly wrong. Please try again in a moment.";
  }

  const systemPrompt = `
  You are VIXA, a friendly and empathetic crypto wallet AI assistant on WhatsApp.
  Your job is to translate technical error messages into simple, natural language for a non-technical user.

  RULES:
  - Keep it under 25 words.
  - Do NOT use technical jargon (e.g., "500", "undefined", "null", "endpoint", "API").
  - Start with a polite apology or a gentle warning emoji.
  - Do NOT invent solutions. Just explain the problem simply.
  `;

  const userPrompt = `The user was trying to: ${context}\nTechnical Error Received: ${technicalError}`;

  const openai = getOpenAI();
  if (!openai) {
    return "⚠️ Sorry, that didn't go through. Please try again in a moment.";
  }

  try {
    const completion = await openai.chat.completions.create(
      {
        model: INTENT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 60,
        temperature: 0.5,
      },
      { timeout: INTENT_TIMEOUT_MS, maxRetries: 1 },
    );

    return (
      completion.choices?.[0]?.message?.content?.trim() ||
      "⚠️ Something went wrong. Please try again in a moment."
    );
  } catch (err) {
    console.error("AI Error Translation failed:", err?.message || err);
    return `❌ Sorry, we couldn't complete that. Please try again shortly.`;
  }
}
