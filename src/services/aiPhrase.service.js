// services/aiPhrase.service.js
// lightweight wrapper to produce short canned/AI-driven WhatsApp messages
import OpenAI from "openai";
const OPENAI_KEY = process.env.OPENAI_API_KEY;
let client;
if (OPENAI_KEY) client = new OpenAI({ apiKey: OPENAI_KEY });

async function callModel(systemPrompt, userPrompt) {
  if (!client) return null;
  try {
    const res = await client.responses.create({
      model: "gpt-4.1",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_output_tokens: 80,
    });

    if (res.output_text) return res.output_text.trim();
    if (Array.isArray(res.output) && res.output.length) {
      const t = res.output.find((c) => c.type === "message" || c.type === "output_text");
      if (t?.text) return t.text.trim();
    }
    return null;
  } catch (err) {
    console.warn("AI phrase error:", err.message);
    return null;
  }
}

export async function phrase(key, context = {}) {
  const system = "You are VIXA AI, a friendly WhatsApp assistant. Always respond with ONE short WhatsApp message, maximum 40 words.";
  let userPrompt;

  switch (key) {
    case "greet":
      userPrompt = `Craft a WhatsApp-friendly greeting message from VIXA.

Include:
- “Hi, this is VIXA.”
- A short reminder of what VIXA helps with (crypto payments, deposits, withdrawals, balance, etc.)
- Tell the user we need to onboard them
- Ask for their first name

Keep it under 40 words.`;
      break;
    case "ask_lastname":
      userPrompt = `Ask the user for their last name.`;
      break;
    case "ask_email":
      userPrompt = `Ask the user for their email address.`;
      break;
    case "ask_pin":
      userPrompt = `Ask the user to choose a 4-digit PIN to secure their account.`;
      break;
    case "ask_confirm_pin":
      userPrompt = `Ask them to re-enter the 4-digit PIN to confirm.`;
      break;
    case "account_created_ask_nin":
      userPrompt = `Tell the user: their account is created, and immediately ask them to send their 11-digit NIN to continue KYC.`;
      break;
    case "account_created_confirmation":
      userPrompt = `Short confirmation message: 'Account created and verified. Type menu to continue.' Keep it under 30 words.`;
      break;
    default:
      userPrompt = key;
  }

  const modelText = await callModel(system, userPrompt);
  if (modelText) return modelText;

  const FALLBACK = {
    greet: "Welcome to VIXA! Let's set up your account. Tap the button to complete onboarding.",
    ask_lastname: "Great — what's your last name?",
    ask_email: "Please enter your email address.",
    ask_pin: "Choose a 4-digit PIN to secure your account.",
    ask_confirm_pin: "Please re-enter the 4-digit PIN to confirm.",
    account_created_ask_nin: "🎉 Your account is created! Please send your 11-digit NIN to continue KYC.",
    account_created_confirmation: "✅ You're verified and your wallet is ready. Type 'menu' to continue.",
    menu:
      "📍 Here’s what I can help you do:\n\n1) Check Balance\n2) Deposit (NGN → USDT)\n3) Sell USDT\n4) Receive Crypto\n5) Send Crypto\n6) Withdraw to Bank\n7) Transaction History\n\nReply with the option number.",
  };
  return FALLBACK[key] || "Okay, please continue.";
}
