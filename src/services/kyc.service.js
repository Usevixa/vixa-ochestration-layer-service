// services/verify.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000, // socket timeout
});

export async function verifyNIN({ nin, firstName, lastName, dateOfBirth }) {
  try {
    const payload = {
      nin,
      firstName,
      lastName,
      dateOfBirth,
    };

    const token = getToken();
    if (!token) {
      throw new Error("Missing auth token for NIN verification");
    }

    console.log("Verifying NIN with:", {
      ...payload,
      token,
    });

    const res = await axios.post(
      "https://api.usevixa.com/api/v1/kyc/verify-nin",
      payload,
      {
        httpsAgent,
        timeout: 750000, // request timeout
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/plain",
        },
      }
    );

    return { success: true, data: res.data };
  } catch (err) {
    console.error("verifyNIN ERROR:", err?.response?.data || err?.message);
    return { success: false, error: err?.response?.data || err?.message };
  }
}
