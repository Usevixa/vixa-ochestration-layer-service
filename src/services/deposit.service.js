// services/deposit.service.js
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
 * Response: { success, message, data: { success, data: [{ coin, iconUrl,
 *   chains: [{ chain, needTag, depositConfirm, withdrawConfirm,
 *   minDepositAmount, minWithdrawAmount, txUrl }] }] } }
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
    const params = { PageNo: 1, PageLimit: 100 };
    if (coin) params.coin = coin;

    const res = await axios.get(`${VIXA_API_BASE}/payment/crypto/deposits/assets`, {
      httpsAgent,
      timeout: 8000,
      params,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "text/plain",
      },
    });

    const list = res.data?.data?.data;
    if (!Array.isArray(list)) {
      console.error(
        "getDepositAssets: no asset list. Body:",
        JSON.stringify(res.data)?.slice(0, 400),
      );
      return { success: false, assets: [], error: "No asset list" };
    }

    const assets = list
      .map((a) => ({
        ...a,
        coin: String(a?.coin || "").trim(),
        chains: (a?.chains || []).filter((ch) => ch?.chain),
      }))
      .filter((a) => a.coin && a.chains.length);

    return { success: true, assets };
  } catch (err) {
    console.error("getDepositAssets ERROR:", err?.response?.data || err?.message);
    return { success: false, assets: [], error: err?.response?.data || err?.message };
  }
}
