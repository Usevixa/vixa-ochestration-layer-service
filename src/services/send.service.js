import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const BASE_URL = "https://api.usevixa.com/api/v1";

/**
 * Fetch supported send currencies
 * GET /crypto/supported-currencies
 */
export async function fetchSendSupportedCurrencies({ coin, chain } = {}) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    const res = await axios.get(`${BASE_URL}/crypto/supported-currencies`, {
      httpsAgent,
      params: { coin, chain },
      headers: { Authorization: `Bearer ${token}` },
    });

    return { success: true, data: res.data };
  } catch (err) {
    console.error("fetchSendSupportedCurrencies ERROR:", err?.response?.data || err?.message);
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
    // 2. Construct Payload for ONCHAIN
    else {
      payload = {
        type: "onchain",
        coin: coin,
        chain: chain,
        amount: amount,
        phoneNumber: phoneNumber, // Send SENDER phone here (usually for reference)
        externalAddress: externalAddress, 
        pin: pin
      };
    }

    console.log("🚀 EXECUTING SEND WITH PAYLOAD:", JSON.stringify(payload, null, 2));

    const res = await axios.post(`${BASE_URL}/crypto/send`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });

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