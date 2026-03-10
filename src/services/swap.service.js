// services/swap.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const BASE_URL = "https://api.usevixa.com/api/v1";

/**
 * Fetch available currencies for swapping
 * GET /api/v1/swap/currencies
 */
export async function fetchSwapCurrencies() {
  try {
    const token = await getToken(); // Ensure we await if getToken is async, though your example implies sync.
    if (!token) throw new Error("Missing auth token");

    const res = await axios.get(`${BASE_URL}/swap/currencies`, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log('fetching swap currencies', res)

    return { success: true, data: res.data };
  } catch (err) {
    console.error("fetchSwapCurrencies ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}

/**
 * Get a quote for the swap
 * GET /api/v1/swap/quote?fromCoin=...&toCoin=...&fromAmount=...
 */
export async function fetchSwapQuote({ fromCoin, toCoin, fromAmount }) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    const res = await axios.get(`${BASE_URL}/swap/quote`, {
      httpsAgent,
      params: { fromCoin, toCoin, fromAmount },
      headers: { Authorization: `Bearer ${token}` },
    });

    return { success: true, data: res.data };
  } catch (err) {
    console.error("fetchSwapQuote ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}

/**
 * Execute swap
 * POST /api/v1/swap
 */
export async function executeSwap({ fromCoin, fromAmount, toCoin, pin }) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    const res = await axios.post(
      `${BASE_URL}/swap`,
      { fromCoin, fromAmount, toCoin, pin },
      {
        httpsAgent,
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    return { success: true, data: res.data };
  } catch (err) {
    console.error("executeSwap ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}
