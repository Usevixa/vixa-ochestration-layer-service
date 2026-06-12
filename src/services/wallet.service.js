// services/wallet.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";

const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

export async function fetchWalletBalances(coin = "") {
  try {
    const token = getToken();

    const res = await axios.get(
      `${VIXA_API_BASE}/wallet/get-balances?Page=1&PageSize=20`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/plain",
        },
        params: coin ? { Coin: coin } : {},
      }
    );

    console.log("fetching wallet Balances", res);

    return res.data?.data?.data || [];
  } catch (err) {
    console.error(
      "fetchWalletBalances ERROR:",
      err?.response?.data || err?.message
    );
    throw new Error("Failed to fetch wallet balances");
  }
}
