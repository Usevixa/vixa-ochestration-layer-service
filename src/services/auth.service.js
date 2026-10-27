// services/auth.service.js
import axios from "axios";
import { AsyncLocalStorage } from "node:async_hooks";
import { getSession, updateSession } from "./session.service.js";

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * The access token for the user whose message is being handled.
 *
 * This used to be two module-level variables shared by every user. Handlers
 * await between restoring the token and using it, so user B's message could
 * overwrite the token mid-way through user A's withdrawal, and A's next API
 * call went out as B. AsyncLocalStorage gives each inbound message its own
 * store that follows it through every await, so that can no longer happen.
 */
const tokenContext = new AsyncLocalStorage();

/**
 * Run `fn` with its own token store. Every inbound message must be handled
 * inside one of these — getToken() refuses to work outside it.
 */
export function runWithUserContext(phone, fn) {
  return tokenContext.run({ phone, token: null, tokenExpiresAt: null }, fn);
}

function currentContext() {
  const store = tokenContext.getStore();
  if (!store) {
    // Fail closed. An API call with no user context is a bug, never a reason
    // to fall back to some other user's token.
    throw new Error("getToken() called outside a user context");
  }
  return store;
}

function setContextToken(token, expiresAt) {
  const store = currentContext();
  store.token = token;
  store.tokenExpiresAt = expiresAt;
}

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
    const expiresAtRaw = res.data?.data?.accessTokenExpiresAt;
    const tokenExpiresAt = expiresAtRaw
      ? new Date(expiresAtRaw).getTime()
      : Date.now() + 3600 * 1000;

    const refreshToken = res.data?.data?.refreshToken;
    const refreshTokenExpiresAtRaw = res.data?.data?.refreshTokenExpiresAt;
    const refreshTokenExpiresAt = refreshTokenExpiresAtRaw
      ? new Date(refreshTokenExpiresAtRaw).getTime()
      : null;

    const isFullyOnboarded = res.data?.data?.isFullyOnboarded ?? null;
    const onboardingStage = res.data?.data?.onboardingStage ?? null;

    setContextToken(token, tokenExpiresAt);

    await updateSession(phoneNumber, {
      data: {
        token,
        pin,
        tokenExpiresAt,
        refreshToken,
        refreshTokenExpiresAt,
        isFullyOnboarded,
        onboardingStage,
      },
    });

    return { token, isFullyOnboarded, onboardingStage };
  } catch (err) {
    console.error("loginUser ERROR:", err?.response?.data || err.message);
    throw err;
  }
}

export function isSessionTokenValid(sessionData) {
  if (!sessionData?.token) return false;
  if (!sessionData?.tokenExpiresAt) return true; // no expiry stored = assume valid
  // Only flag as expired if it's been expired for more than 60 seconds
  // This prevents false positives from clock skew or server restarts
  const GRACE_MS = 60_000;
  return Date.now() < sessionData.tokenExpiresAt + GRACE_MS;
}

export function restoreCachedToken(sessionData) {
  if (sessionData?.token) {
    const expiresAt = sessionData.tokenExpiresAt || Date.now() + 3600 * 1000;
    setContextToken(sessionData.token, expiresAt);
    console.log(
      "Restored token from session, expires:",
      new Date(expiresAt).toISOString(),
    );
  }
}

export async function verifyUserToken() {
  const token = getToken();
  if (!token) throw new Error("No cached token");
  const res = await axios.get(`${VIXA_API_BASE}/auth/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

export async function refreshAccessToken({ phoneNumber, refreshToken }) {
  try {
    const res = await axios.post(`${VIXA_API_BASE}/auth/refresh`, {
      refreshToken,
      deviceId: "",
    });

    const data = res.data?.data;
    if (!data?.accessToken)
      throw new Error("No access token in refresh response");

    const newTokenExpiresAt = data.accessTokenExpiresAt
      ? new Date(data.accessTokenExpiresAt).getTime()
      : Date.now() + 3600 * 1000;

    const newRefreshTokenExpiresAt = data.refreshTokenExpiresAt
      ? new Date(data.refreshTokenExpiresAt).getTime()
      : null;

    setContextToken(data.accessToken, newTokenExpiresAt);

    await updateSession(phoneNumber, {
      data: {
        token: data.accessToken,
        tokenExpiresAt: newTokenExpiresAt,
        refreshToken: data.refreshToken,
        refreshTokenExpiresAt: newRefreshTokenExpiresAt,
      },
    });

    console.log("Token refreshed silently for", phoneNumber);
    return { success: true };
  } catch (err) {
    console.error(
      "refreshAccessToken failed:",
      err?.response?.data || err.message,
    );
    return { success: false };
  }
}

export function getToken() {
  const store = currentContext();
  // Optionally refresh here if expired (requires storing credentials or refresh token)
  if (store.token && store.tokenExpiresAt && Date.now() > store.tokenExpiresAt) {
    console.warn("Cached token expired");
    store.token = null;
  }
  return store.token;
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
    // Returns null rather than throwing. Both call sites in webhook.js already
    // handle a null result with "Service momentarily unavailable"; the throw
    // skipped past that into the route's outer catch, so a user signing in
    // while the API was down got no reply at all.
    return null;
  }
}
