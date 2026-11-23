// services/withdrawal.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";
import logger from "../lib/logger.js";
import { normalizeWithdrawalAssets } from "../utils/withdrawalAssets.js";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";


export async function fetchWithdrawalQuote(payload) {
  try {
    const token = await getToken();
    console.log("qoute payload ==>", payload)
    const res = await axios.post(`${VIXA_API_BASE}/withdrawal/quote`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Quote Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function fetchBanks(countryCode, channelId) { 
  try {
    const token = await getToken();
    const res = await axios.get(`${VIXA_API_BASE}/payment/networks?CountryId=${countryCode}&ChannelId=${channelId}`, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log('fetching banks', res)
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Fetch Banks Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function validateBankAccount(payload) {
  try {
    const token = await getToken();
    const res = await axios.post(`${VIXA_API_BASE}/payment/validate-bank-account`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Validate Account Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function executeWithdrawal(payload) {
  try {
    const token = await getToken();

    console.log(payload,'execute payload')
    const res = await axios.post(`${VIXA_API_BASE}/withdrawal/execute`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Execute Withdrawal Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function fetchSupportedCountries(region = "africa") {
  try {
    const token = await getToken();
    const res = await axios.get(`${VIXA_API_BASE}/payment/supported-countries?Region=${region}`, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Fetch Countries Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

// 🆕 Fetch payment channels based on the selected country
export async function fetchPaymentChannels(countryCode, ramp) {
  try {
    const token = await getToken();
    const res = await axios.get(`${VIXA_API_BASE}/payment/channels?ramp=${ramp}&country=${countryCode}`, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Fetch Channels Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}


/**
 * GET /withdrawal/assets — coins the user can withdraw, each with the
 * networks holding a balance. Dust is dropped (see normalizeWithdrawalAssets).
 * @returns {{ success: boolean, assets: Array, error?: any }}
 */
export async function getWithdrawalAssets() {
  try {
    const token = getToken();
    const res = await axios.get(`${VIXA_API_BASE}/withdrawal/assets`, {
      httpsAgent,
      timeout: 8000,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "text/plain",
      },
    });

    const assets = normalizeWithdrawalAssets(res.data);
    if (!assets) {
      const body = JSON.stringify(res.data)?.slice(0, 400);
      console.error("getWithdrawalAssets: no asset list. Body:", body);
      logger.error?.("withdrawal assets: no list", { status: res.status, body });
      return { success: false, assets: [], error: res.data?.message || "No asset list" };
    }
    return { success: true, assets };
  } catch (err) {
    const status = err?.response?.status ?? null;
    const body = JSON.stringify(err?.response?.data ?? err?.message)?.slice(0, 400);
    console.error("getWithdrawalAssets ERROR:", status, body);
    logger.error?.("withdrawal assets: request failed", { status, body });
    return { success: false, assets: [], error: err?.response?.data || err?.message };
  }
}
