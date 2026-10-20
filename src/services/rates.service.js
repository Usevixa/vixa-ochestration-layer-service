// services/rates.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: 30000, // socket timeout
});

const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * The rates API names currencies its own way (see GET /rates/pairs):
 * NGN is "naira", while coins like USDT are their lowercase ticker.
 * "ngn" now returns "No rate available".
 */
const RATE_CURRENCY_NAMES = { ngn: "naira" };

function rateCurrencyName(code) {
    const lower = String(code || "").toLowerCase();
    return RATE_CURRENCY_NAMES[lower] || lower;
}

/**
 * POST /rates/convert
 * Body: { fromCurrency, toCurrency, amount, direction }
 *   direction 0 = `amount` is in fromCurrency (what the user pays).
 * Response `data`: { fromCurrency, toCurrency, inputAmount, outputAmount,
 *   rateUsed, fee, feePercentage, direction, rateTimestamp, expiresInSeconds }
 */
export async function convertRate({
    fromCurrency,
    toCurrency,
    amount,
    direction = 0,
}) {
    try {
        const token = getToken();
        if (!token) {
            throw new Error("Missing auth token for rate conversion");
        }

        const res = await axios.post(
            `${VIXA_API_BASE}/rates/convert`,
            {
                fromCurrency: rateCurrencyName(fromCurrency),
                toCurrency: rateCurrencyName(toCurrency),
                amount,
                direction,
            },
            {
                httpsAgent,
                timeout: 30000,
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
            }
        );

        console.log("convertRate RESPONSE:", res.data);

        return { success: true, data: res.data };
    } catch (err) {
        console.error("convertRate ERROR:", err?.response?.data || err?.message);
        return { success: false, error: err?.response?.data || err?.message };
    }
}
