import OpenAI from "openai";

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
  // Determine what the system is currently expecting from the user
  let currentContext = "No active flow. User is at the main menu.";
  
  if (sessionData?.pendingDeposit) currentContext = "Expecting deposit amount in NGN.";
  if (sessionData?.awaitingDepositPin) currentContext = "Expecting 4-digit PIN to confirm deposit.";
  if (sessionData?.swap?.step === "ENTER_AMOUNT") currentContext = `Expecting amount of ${sessionData.swap.fromCoin} to swap.`;
  // Add other contexts based on your state machine...

  const systemPrompt = `
  You are VIXA, a helpful crypto wallet AI assistant on WhatsApp.
  Your job is to analyze the user's message and determine their intent based on their current context.
  
  CURRENT CONTEXT: ${currentContext}
  
  RULES:
  - If the user provides the expected input, set intent to "PROVIDE_INPUT" and extract the exact value.
  - If the user says hello or asks a random question, set intent to "CHITCHAT_OR_CLARIFY". Generate a friendly 'replyMessage' that answers them AND gently reminds them of the CURRENT CONTEXT.
  - If the user wants to stop or cancel, set intent to "CANCEL_FLOW".
  - If the user has no active flow and asks to do something (swap, deposit, etc.), set intent to "START_NEW_FLOW".
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini", // Fast and cheap for this task
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "intent_classification",
        schema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: ["PROVIDE_INPUT", "CANCEL_FLOW", "CHITCHAT_OR_CLARIFY", "START_NEW_FLOW"],
            },
            extractedValue: {
              type: "string",
              description: "The raw data extracted if intent is PROVIDE_INPUT (e.g., '5000', '1234', 'wallet_address'). Null otherwise.",
            },
            replyMessage: {
              type: "string",
              description: "The message to send back to the user if intent is CHITCHAT_OR_CLARIFY.",
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


export async function humanizeError(technicalError, context = "processing your request") {
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