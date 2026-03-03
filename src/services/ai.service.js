import OpenAI from "openai";

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