// services/verify.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: 30000, // socket timeout
});

const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

export async function fetchRates({ 
    fromCurrency,
    toCurrency,

}) {
    try {

        const token = getToken();
        if (!token) {
            throw new Error("Missing auth token for fetching rates");
        }

        const res = await axios.get(
            `${VIXA_API_BASE}/rates/${fromCurrency}/${toCurrency}`,
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

       console.log(res, 'supplying recent rates')

        return { success: true, data: res.data };
    } catch (err) {
        console.error("verifyNIN ERROR:", err?.response?.data || err?.message);
        return { success: false, error: err?.response?.data || err?.message };
    }
}
