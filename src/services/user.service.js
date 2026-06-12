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

    return res.data; // { id, userName, firstName, lastName, ... }
  } catch (err) {
    console.error(
      "fetchAuthMe ERROR:",
      err?.response?.data || err?.message
    );
    throw new Error("Failed to fetch user profile");
  }
}
