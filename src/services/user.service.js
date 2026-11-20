// services/user.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import { displayName } from "../utils/names.js";
export { displayName, withName } from "../utils/names.js";
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
        "fetchAuthMe: no first name in profile. Keys:",
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

