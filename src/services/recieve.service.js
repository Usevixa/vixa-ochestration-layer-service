// services/receive.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const BASE_URL = "https://api.usevixa.com/api/v1";

/**
 * Fetch crypto receive wallet addresses
 * GET /api/v1/wallet/crypto/subwallets/addresses
 */
export async function fetchReceiveWallets({ coin, chain, pageNo = 1, pageLimit = 10 } = {}) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    const res = await axios.get(
      `${BASE_URL}/wallet/crypto/subwallets/addresses`,
      {
        httpsAgent,
        params: {
          coin,
          chain,
          pageNo,
          pageLimit,
        },
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    console.log('fetching reciver rates walltes', res)

    return { success: true, data: res.data };
  } catch (err) {
    console.error(
      "fetchReceiveWallets ERROR:",
      err?.response?.data || err?.message
    );

    return {
      success: false,
      error: err?.response?.data || err?.message,
    };
  }
}
