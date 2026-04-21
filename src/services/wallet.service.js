// services/wallet.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";

export async function fetchWalletBalances(coin = "") {
  try {
    const token = getToken();

    const res = await axios.get(
      "https://api.usevixa.com/api/v1/wallet/get-balances?Page=1&PageSize=20",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/plain",
        },
        params: coin ? { Coin: coin } : {},
      }
    );

    console.log("fetching wallet Balances", res);

    /**
     * Expected response shape:
     * {
     *   success: true,
     *   message: "...",
     *   data: {
     *     success: true,
     *     data: [ { coin, available, locked, chain } ]
     *   }
     */
    return res.data?.data?.data || [];
  } catch (err) {
    console.error(
      "fetchWalletBalances ERROR:",
      err?.response?.data || err?.message
    );
    throw new Error("Failed to fetch wallet balances");
  }
}
