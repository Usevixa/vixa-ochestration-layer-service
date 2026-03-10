// services/onboarding.service.js
import axios from "axios";
import bcrypt from "bcrypt";

const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

export async function createUserOnboarding({
  firstName,
  lastName,
  phoneNumber,
  phoneNumberId,
  email,
  pin,
}) {
  try {
    // Hash PIN locally before sending to downstream if you prefer.
    // NOTE: If your downstream expects plain PIN, remove hashing and send pin directly.
    const pinHash = await bcrypt.hash(pin, 10);

    // Example body - adjust according to your real onboarding API contract
    const body = {
      firstName,
      lastName,
      phoneNumber,
      phoneNumberId,
      email,
      // If your downstream expects plain pin, send pin instead of pinHash
      pin, // change to pinHash if API expects hashed
    };

   console.log(body, 'onboarding payload')
    const res = await axios.post(`${VIXA_API_BASE}/onboarding/users`, body, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    return { success: true, data: res.data };
  } catch (err) {
    console.error("createUserOnboarding ERROR:", err?.response?.data || err.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}
