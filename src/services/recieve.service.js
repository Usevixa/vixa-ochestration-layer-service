// services/receive.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";
import https from "https";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * Fetch crypto receive addresses
 * GET /crypto/receive?coin=USDT  (coin optional — omit to list every coin)
 * Response: { data: [{ coin, network, address, memo, txUrlPrefix }] }
 *
 * `wallets` is the list with an `id` added (coin + network), because the
 * response has none and the network picker needs one to find the pick.
 */
export async function fetchReceiveWallets({ coin } = {}) {
  try {
    const token = await getToken();
    if (!token) throw new Error("Missing auth token");

    const res = await axios.get(`${VIXA_API_BASE}/crypto/receive`, {
      httpsAgent,
      params: coin ? { coin } : {},
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("fetchReceiveWallets RESPONSE:", res.data);

    const list = Array.isArray(res.data?.data) ? res.data.data : [];
    const wallets = list
      .filter((w) => w?.address)
      .map((w) => ({ ...w, id: `${w.coin}_${w.network}` }));

    return { success: true, data: res.data, wallets };
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
