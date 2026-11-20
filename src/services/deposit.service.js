// services/deposit.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";
import logger from "../lib/logger.js";
import { normalizeDepositAssets } from "../utils/depositAssets.js";

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
  chain,
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
      chain,
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

/**
 * GET /payment/crypto/deposits/assets[?coin=]
 * The live response is a flat list of coin + chain rows with NGN limits,
 * not the nested shape Swagger documents; normalizeDepositAssets handles
 * both (see utils/depositAssets.js).
 *
 * Without `coin` it lists every depositable coin; with `coin` it narrows to
 * that coin's chains. Short timeout: the chain lookup runs inside a WhatsApp
 * Flow data_exchange, which Meta abandons after ~10s.
 *
 * @returns {{ success: boolean, assets: Array<{ coin: string, iconUrl?: string, chains: object[] }>, error?: any }}
 */
export async function getDepositAssets({ coin } = {}) {
  try {
    const token = getToken();
    // Same call as the backend's own example: no paging params. (PageLimit
    // is passed straight to the provider, which may reject large values.)
    const params = coin ? { coin } : {};

    const res = await axios.get(`${VIXA_API_BASE}/payment/crypto/deposits/assets`, {
      httpsAgent,
      timeout: 8000,
      params,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "text/plain",
      },
    });

    const assets = normalizeDepositAssets(res.data);
    if (!assets) {
      const body = JSON.stringify(res.data)?.slice(0, 400);
      console.error("getDepositAssets: no asset list. Body:", body);
      logger.error?.("deposit assets: no list", { coin: coin || null, status: res.status, body });
      return { success: false, assets: [], error: res.data?.message || "No asset list" };
    }

    return { success: true, assets };
  } catch (err) {
    const status = err?.response?.status ?? null;
    const body = JSON.stringify(err?.response?.data ?? err?.message)?.slice(0, 400);
    console.error("getDepositAssets ERROR:", status, body);
    logger.error?.("deposit assets: request failed", { coin: coin || null, status, body });
    return { success: false, assets: [], error: err?.response?.data || err?.message };
  }
}
