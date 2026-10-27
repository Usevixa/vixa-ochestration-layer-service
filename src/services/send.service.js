import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * Quote an external (onchain) send
 * POST /crypto/send/quote
 * Body: { type: "onchain", coin, chain, amount, externalAddress }
 * Response `data`: { quoteId, coin, network, amount, networkFee, vixaFee,
 *   total, totalDebit, expiresAt }
 */
export async function fetchSendQuote({ coin, chain, amount, externalAddress }) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    const payload = {
      type: "onchain",
      coin: String(coin).toLowerCase(),
      chain,
      amount,
      externalAddress,
    };
    console.log("fetchSendQuote payload:", payload);

    const res = await axios.post(`${VIXA_API_BASE}/crypto/send/quote`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("fetchSendQuote RESPONSE:", res.data);
    return { success: true, data: res.data };
  } catch (err) {
    console.error("fetchSendQuote ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}

/**
 * Execute Send Crypto (Dynamic Payload)
 */
export async function executeSendCrypto({
  type, // "P2P" or "EXTERNAL"
  coin,
  chain,
  amount,
  phoneNumber,     // Sender's Phone (from session)
  externalAddress, // User Input (Recipient Phone for P2P, Wallet Address for Onchain)
  pin,
  quoteId,         // Onchain only, from fetchSendQuote
  idempotencyKey,  // Onchain only, made once per quote
}) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    let payload = {};

    // 1. Construct Payload for P2P
    if (type === "P2P") {
      // For P2P, externalAddress holds the RECIPIENT'S phone number
      const recipientPhone = formatPhoneNumber(externalAddress);
      
      payload = {
        type: "p2p",
        coin: coin,
        amount: amount,
        phoneNumber: recipientPhone, // Send RECIPIENT phone here
        pin: pin
      };
    } 
    // 2. ONCHAIN — everything else was fixed by the quote
    else {
      payload = { quoteId, pin, idempotencyKey };
    }

    // Never log the PIN.
    const { pin: _pin, ...loggable } = payload;
    console.log("🚀 EXECUTING SEND WITH PAYLOAD:", JSON.stringify(loggable, null, 2));

    const res = await axios.post(`${VIXA_API_BASE}/crypto/send`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("executeSendCrypto RESPONSE:", res.data);

    return { success: true, data: res.data };
  } catch (err) {
    console.error("executeSendCrypto ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}

// Helper to ensure phone number format +234...
function formatPhoneNumber(phone) {
  if (!phone) return phone;
  // Remove spaces or dashes
  let cleaned = phone.replace(/\s+/g, "").replace(/-/g, "");
  
  // If starts with 0 (e.g., 090...), replace 0 with +234
  if (cleaned.startsWith("0")) {
    return "+234" + cleaned.substring(1);
  }
  // If starts with 234, add +
  if (cleaned.startsWith("234")) {
    return "+" + cleaned;
  }
  // If already has +, return as is
  if (cleaned.startsWith("+")) {
    return cleaned;
  }
  // Fallback: assume it's a local number without 0, add +234
  return "+234" + cleaned;
}