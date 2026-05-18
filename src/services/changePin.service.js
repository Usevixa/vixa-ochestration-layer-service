import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const BASE_URL = "https://api.usevixa.com/api/v1";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

export async function requestChangePinOtp() {
  try {
    const token = await getToken();
    const res = await axios.post(
      `${BASE_URL}/account/request-otp`,
      { purpose: "ChangePIN" },
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
      `${BASE_URL}/account/change-pin`,
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