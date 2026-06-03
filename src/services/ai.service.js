import OpenAI from "openai";
import { matchKeywordIntent } from "../utils/intentKeywords.js";

/**
 * Translates a technical error into a user-friendly WhatsApp message.
 * @param {string} technicalError - The raw error message from the API/code.
 * @param {string} context - What the user was trying to do (e.g., "withdrawal quote").
 * @returns {Promise<string>} - The humanized error message.
 */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function analyzeUserIntent(message, sessionData) {
  // Fast keyword pre-screen — no AI call needed
  const { flow, matched } = matchKeywordIntent(message);

  if (matched) {
    if (flow === "CANCEL") {
      return { intent: "CANCEL_FLOW", detectedFlow: null, replyMessage: null };
    }
    return {
      intent: "START_SPECIFIC_FLOW",
      detectedFlow: flow,
      replyMessage: null,
    };
  }
  // Determine what the system is currently expecting from the user
  let currentContext = "No active flow. User is at the main menu.";

  if (sessionData?.pendingDeposit)
    currentContext = "Expecting deposit amount in NGN.";
  if (sessionData?.awaitingDepositPin)
    currentContext = "Expecting 4-digit PIN to confirm deposit.";
  if (sessionData?.swap?.step === "ENTER_AMOUNT")
    currentContext = `Expecting amount of ${sessionData.swap.fromCoin} to swap.`;
  // Add other contexts based on your state machine...

  const systemPrompt = `
  You are VIXA, a helpful crypto wallet AI assistant on WhatsApp.
  Your job is to analyze the user's message and determine their intent based on their current context.
  
  CURRENT CONTEXT: ${currentContext}
  
  RULES:
  - If the user says anything like "I want to deposit", "let me swap", "I want to withdraw", "send crypto", "receive", "check my balance", "check balance" — this is ALWAYS "START_SPECIFIC_FLOW", even if there is an active context. NEVER treat financial action phrases as "PROVIDE_INPUT".
  - If the user provides the expected input (a plain number, a wallet address, a phone number, etc.) that directly matches what the context expects, set intent to "PROVIDE_INPUT" and extract the exact value.
  - If the user says hello, asks a general question, or sends something unrelated to the context AND is not requesting a financial action, set intent to "CHITCHAT_OR_CLARIFY". Generate a friendly 'replyMessage' that answers them AND gently reminds them of the CURRENT CONTEXT.
  - If the user wants to cancel, stop, or go back with NO new financial action mentioned, set intent to "CANCEL_FLOW". Set detectedFlow to null.
  - If the user wants to do a specific financial action (deposit, withdraw, swap, send, receive, check balance), set intent to "START_SPECIFIC_FLOW" and set detectedFlow to the matching value.
  - If the user asks about support, help, contact details, customer service, or how to reach VIXA, this is ALWAYS "START_SPECIFIC_FLOW" with detectedFlow set to "SUPPORT".
  - If the user wants to change their PIN, says "change PIN", "update PIN", "new PIN", or similar, this is ALWAYS "START_SPECIFIC_FLOW" with detectedFlow set to "CHANGE_PIN".
  - If the user wants to lock their wallet, says "lock wallet", "secure my wallet", or similar, this is ALWAYS "START_SPECIFIC_FLOW" with detectedFlow set to "LOCK_WALLET".
  - If the user wants to unlock their wallet, says "unlock wallet", "restore access", or similar, this is ALWAYS "START_SPECIFIC_FLOW" with detectedFlow set to "UNLOCK_WALLET".
  - If the user says "settings", "account settings", "manage account", or similar, this is ALWAYS "START_SPECIFIC_FLOW" with detectedFlow set to "SETTINGS".
  
  detectedFlow must be one of: "DEPOSIT", "WITHDRAW", "SWAP", "SEND", "RECEIVE", "BALANCE", "SUPPORT", or null.
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Fast and cheap for this task
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    // AFTER
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intent_classification",
        schema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: [
                "PROVIDE_INPUT",
                "CANCEL_FLOW",
                "CHITCHAT_OR_CLARIFY",
                "START_SPECIFIC_FLOW",
              ],
            },
            extractedValue: {
              type: "string",
              description:
                "The raw data extracted if intent is PROVIDE_INPUT. Null otherwise.",
            },
            replyMessage: {
              type: "string",
              description:
                "The message to send back to the user if intent is CHITCHAT_OR_CLARIFY.",
            },
            detectedFlow: {
              type: "string",
              description:
                "Which flow the user wants to start. One of: DEPOSIT, WITHDRAW, SWAP, SEND, RECEIVE, BALANCE, SUPPORT, CHANGE_PIN, LOCK_WALLET, UNLOCK_WALLET, SETTINGS, or null.",
            },
          },
          required: ["intent"],
          additionalProperties: false,
        },
      },
    },
  });

  return JSON.parse(completion.choices[0].message.content);
}

// Add this to the bottom of services/ai.service.js

export async function humanizeError(
  technicalError,
  context = "processing your request",
) {
  // If there's no specific error text, provide a generic fallback immediately
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

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast and cheap
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 50,
      temperature: 0.5, // Keep it consistent and focused
    });

    return completion.choices[0].message.content.trim();
  } catch (err) {
    console.error("AI Error Translation failed:", err);
    // 🛡️ FALLBACK: If OpenAI fails, return the raw technical error cleanly
    return `❌ Failed to complete action: ${technicalError}`;
  }
}
