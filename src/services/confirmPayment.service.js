// services/confirmPayment.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: 30000, // socket timeout
});

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * confirmPayment({ id }) — `id` is the deposit's intentId.
 * Response: { success, message, data: { status, usdtEstimate, reference, expiresAt } }
 */
export async function confirmPayment({ id }) {
    try {
        const token = getToken();
        if (!token) {
            throw new Error("Missing auth token for confirming deposit");
        }

        // POST with no body — the options object must be the THIRD argument,
        // otherwise axios sends it as the body and no auth header goes out.
        const res = await axios.post(
            `${VIXA_API_BASE}/payment/crypto/deposits/${encodeURIComponent(id)}/confirm`,
            null,
            {
                httpsAgent,
                timeout: 750000, // request timeout
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "text/plain",
                },
            }
        );

        console.log("confirmPayment RESPONSE:", res.data);

        return { success: true, data: res.data };
    } catch (err) {
        console.error("confirmPayment ERROR:", err?.response?.data || err?.message);
        return { success: false, error: err?.response?.data || err?.message };
    }
}
