import OpenAI from "openai";
import { toFile } from "openai/uploads";

let _openai = null;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const MODEL = process.env.VIXA_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const TIMEOUT_MS = Number(process.env.VIXA_TRANSCRIBE_TIMEOUT_MS || 15000);

/**
 * Biases the decoder toward VIXA vocabulary. Without it, "USDT" comes back
 * as "US DT", "you SDT", "USD T" a large fraction of the time.
 */
const DOMAIN_PROMPT =
  "VIXA wallet, WhatsApp, Nigeria. Terms: USDT, USDC, BTC, ETH, TRON, TRX, " +
  "naira, NGN, swap, withdraw, deposit, wallet balance, BVN, NIN, PIN, OTP, " +
  "Opay, Kuda, Moniepoint, GTBank, Access Bank, Zenith, First Bank.";

/**
 * Meta sends OGG/Opus, which OpenAI accepts natively — no ffmpeg needed.
 * @returns {Promise<{success:true,text:string}|{success:false,reason:string}>}
 */
export async function transcribeAudio({ buffer, mimeType }) {
  const openai = getOpenAI();
  if (!openai) return { success: false, reason: "NO_KEY" };

  try {
    const ext = mimeType?.includes("mpeg") ? "mp3"
      : mimeType?.includes("mp4") || mimeType?.includes("aac") ? "m4a"
      : "ogg";

    const file = await toFile(buffer, `voice.${ext}`, { type: mimeType });

    const res = await openai.audio.transcriptions.create(
      { file, model: MODEL, language: "en", prompt: DOMAIN_PROMPT },
      { timeout: TIMEOUT_MS, maxRetries: 1 },
    );

    const text = res.text?.trim();
    return text ? { success: true, text } : { success: false, reason: "EMPTY" };
  } catch (err) {
    console.error("transcribeAudio failed:", err?.message || err);
    return { success: false, reason: "API_ERROR" };
  }
}