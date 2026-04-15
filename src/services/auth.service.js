// services/auth.service.js
import axios from "axios";
import { getSession, updateSession } from "./session.service.js";

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

let cachedToken = null;
let tokenExpiresAt = null;

/**
 * loginUser({ phoneNumber, pin, deviceId })
 * Logs the user in and caches accessToken for subsequent API calls.
 */
// services/auth.service.js

export async function loginUser({ phoneNumber, pin, deviceId = "" }) {
  console.log(phoneNumber, pin, deviceId, "phoneNumber, pin, deviceId");
  try {
    const res = await axios.post(`${VIXA_API_BASE}/auth/login`, {
      phoneNumber,
      pin,
      deviceId,
    });

    const token = res.data?.data?.accessToken || res.data?.accessToken;
    const expiresIn = res.data?.data?.accessTokenExpiresIn || 3600; // fallback 1 hour

    if (!token) {
      throw new Error("No access token returned from auth service");
    }

    // 1. CRITICAL: Cache globally so fetchAuthMe works immediately
    cachedToken = token;
    tokenExpiresAt = Date.now() + (expiresIn - 300) * 1000;

    // 2. Only update token-related session data here.
    // 🛑 DO NOT set authenticated: true or awaitingPin: false here!
    await updateSession(phoneNumber, {
      data: {
        token,
        pin, 
        tokenExpiresAt: Date.now() + (expiresIn - 300) * 1000,
      },
    });
    
    return token;
  } catch (err) {
    console.error("loginUser ERROR:", err?.response?.data || err.message);
    throw err;
  }
}

export function isSessionTokenValid(sessionData) {
  if (!sessionData?.token) return false;
  if (!sessionData?.tokenExpiresAt) return false;
  return Date.now() < sessionData.tokenExpiresAt;
}

export async function verifyUserToken() {
  if (!cachedToken) throw new Error("No cached token");
  const res = await axios.get(`${VIXA_API_BASE}/auth/verify`, {
    headers: { Authorization: `Bearer ${cachedToken}` },
  });
  return res.data;
}

export function getToken() {
  // Optionally refresh here if expired (requires storing credentials or refresh token)
  if (cachedToken && tokenExpiresAt && Date.now() > tokenExpiresAt) {
    console.warn("Cached token expired");
    cachedToken = null;
  }
  return cachedToken;
}

// services/auth.service.js
export async function checkPhoneNumber(phoneNumber) {
  try {
    const res = await axios.get(`${VIXA_API_BASE}/auth/check-phone`, {
      params: { phoneNumber },
    });

    // returns true if user exists, false otherwise
    return res.data?.data;
  } catch (err) {
    console.error(
      "checkPhoneNumber ERROR:",
      err?.response?.data || err.message,
    );
    throw err;
  }
}
