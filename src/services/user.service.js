// services/user.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

export async function fetchAuthMe() {
  try {
    const token = getToken();

    const res = await axios.get(
      `${VIXA_API_BASE}/auth/me`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "*/*",
        },
      }
    );

    // /auth/me has been seen both bare ({ firstName, ... }) and wrapped in the
    // usual envelope ({ success, message, data: { firstName, ... } }). Callers
    // read me.firstName, so lift the envelope's fields to the top; `data` is
    // kept so older me.data.* reads still work.
    const body = res.data;
    const inner =
      body?.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? body.data
        : null;
    const me = inner ? { ...body, ...inner } : body;

    if (!displayName(me)) {
      // Field names only — never log profile values.
      console.warn(
        "fetchAuthMe: no firstName in profile. Keys:",
        Object.keys(me || {}).join(", "),
      );
    }
    return me; // { id, userName, firstName, lastName, ... }
  } catch (err) {
    console.error(
      "fetchAuthMe ERROR:",
      err?.response?.data || err?.message
    );
    throw new Error("Failed to fetch user profile");
  }
}

/**
 * The user's first name for greetings, or "" when there isn't a usable one.
 * Guards against the strings "undefined"/"null" that template literals
 * produce from missing values, so a greeting never shows them.
 */
export function displayName(me) {
  const raw = me?.firstName ?? me?.data?.firstName ?? "";
  const name = String(raw).trim();
  return /^(undefined|null)$/i.test(name) ? "" : name;
}

/** " Name" for "Welcome back${withName(me)}", or "" when there's no name. */
export function withName(me) {
  const name = displayName(me);
  return name ? ` ${name}` : "";
}
