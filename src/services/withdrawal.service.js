// services/withdrawal.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const BASE_URL = "https://api.usevixa.com/api/v1";

export async function fetchWithdrawalQuote(payload) {
  try {
    const token = await getToken();
    console.log("qoute payload ==>", payload)
    const res = await axios.post(`${BASE_URL}/withdrawal/quote`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Quote Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function fetchBanks(countryCode) {
  try {
    const token = await getToken();
    const res = await axios.get(`${BASE_URL}/payment/networks?CountryId=${countryCode}`, {
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
    const res = await axios.post(`${BASE_URL}/payment/validate-bank-account`, payload, {
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
    const res = await axios.post(`${BASE_URL}/withdrawal/execute`, payload, {
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
    const res = await axios.get(`${BASE_URL}/payment/supported-countries?Region=${region}`, {
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
export async function fetchPaymentChannels(countryCode, ramp = "withdraw") {
  try {
    const token = await getToken();
    const res = await axios.get(`${BASE_URL}/payment/channels?ramp=${ramp}&country=${countryCode}`, {
      httpsAgent,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, data: res.data.data };
  } catch (error) {
    console.error("Fetch Channels Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

