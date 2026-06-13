import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";


const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

export async function requestChangePinOtp(purpose = "ChangePIN") {
  try {
    const token = await getToken();
    const res = await axios.post(
      `${VIXA_API_BASE}/account/request-otp`,
      { purpose },  // ✅ now dynamic
      {
        httpsAgent,
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return { success: true, data: res.data };
  } catch (error) {
    console.error("Request OTP Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function changePinRequest({ currentPin, newPin, confirmPin, otpCode }) {
  try {
    const token = await getToken();
    const res = await axios.post(
      `${VIXA_API_BASE}/account/change-pin`,
      { currentPin, newPin, confirmPin, otpCode },
      {
        httpsAgent,
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return { success: true, data: res.data };
  } catch (error) {
    console.error("Change PIN Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}


export async function lockWallet({ pin, reason }) {
  try {
    const token = await getToken();
    const res = await axios.post(
      `${VIXA_API_BASE}/account/wallet/lock`,
      { pin, reason },
      {
        httpsAgent,
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return { success: true, data: res.data };
  } catch (error) {
    console.error("Lock Wallet Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}

export async function unlockWallet({ pin, otpCode }) {
  try {
    const token = await getToken();
    const res = await axios.post(
      `${VIXA_API_BASE}/account/wallet/unlock`,
      { pin, otpCode },
      {
        httpsAgent,
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return { success: true, data: res.data };
  } catch (error) {
    console.error("Unlock Wallet Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data || error.message };
  }
}