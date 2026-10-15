// services/wallet.service.js
import axios from "axios";
import { getToken } from "./auth.service.js";

const VIXA_API_BASE = process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * GET /wallet/balances
 * Response: { data: { coins: [{ coin, decimals, total, pending, available,
 *             networks: [{ network, total, pending, available }] }], asOf } }
 *
 * Returns [{ coin, balance, total, pending, decimals, networks }] — `balance`
 * is the spendable (`available`) amount, which is what every caller shows.
 */
export async function fetchWalletBalances(coin = "") {
  try {
    const token = getToken();

    const res = await axios.get(`${VIXA_API_BASE}/wallet/balances`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    console.log("fetchWalletBalances RESPONSE:", res.data);

    const coins = res.data?.data?.coins || [];
    const balances = coins.map((c) => ({
      coin: c.coin,
      balance: c.available,
      total: c.total,
      pending: c.pending,
      decimals: c.decimals,
      networks: c.networks || [],
    }));

    return coin
      ? balances.filter((b) => b.coin?.toUpperCase() === coin.toUpperCase())
      : balances;
  } catch (err) {
    console.error(
      "fetchWalletBalances ERROR:",
      err?.response?.data || err?.message
    );
    throw new Error("Failed to fetch wallet balances");
  }
}
