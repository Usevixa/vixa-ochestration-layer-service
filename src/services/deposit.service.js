// services/verify.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000, // socket timeout
});

export async function depositCrypto({
  currency,
  amountLocal,
  channelId,
  coin,
  // chain,
  correlationId,
  idempotencyKey,
  pin
}) {
  try {
    const payload = {
      currency,
      amountLocal,
      channelId,
      coin,
      // chain,
      correlationId,
      idempotencyKey,
      pin
    };

    const token = getToken();
    if (!token) {
      throw new Error("Missing auth token for deposit");
    }

    // Never log the token or PIN.
    const { pin: _pin, ...loggable } = payload;
    console.log("depositCrypto payload:", loggable);

    const res = await axios.post(
      `${VIXA_API_BASE}/payment/crypto/deposit/initiate`,
      payload,
      {
        httpsAgent,
        timeout: 750000, // request timeout
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/plain",
        },
      }
    );

    console.log("depositCrypto RESPONSE:", res.data);

    return { success: true, data: res.data };
  } catch (err) {
    console.error("depositCrypto ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}
