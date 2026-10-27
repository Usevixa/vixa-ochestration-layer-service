// services/supportedCurrencies.service.js
import axios from "axios";
import https from "https";
import { getToken } from "./auth.service.js";

const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 30000,
});

const VIXA_API_BASE =
  process.env.VIXA_API_BASE || "https://api.usevixa.com/api/v1";

/**
 * Values GET /supported-currencies/transaction-types returns. Each flow knows
 * its own type, so they live here as constants rather than being looked up
 * on every request — that would add a call, and a way to fail, for nothing.
 */
export const TRANSACTION_TYPES = {
  DEPOSIT: "Deposit",
  WITHDRAW: "WithdrawalToBank",
  SWAP: "Swap",
  SEND_EXTERNAL: "SendExternal",
  SEND_INTERNAL: "SendInternal", // unused while P2P is switched off
  RECEIVE: "Receive",
  BALANCE: "Balance",
};

/**
 * GET /supported-currencies?transactionType=...
 * Response `data`: { currencies: [{ coin, chains: [{ chain, oxsNetworkSlug,
 *   needTag, minDepositAmount, minWithdrawAmount, decimals,
 *   operations: { <TransactionType>: { enabled } } }] }], totalCoins, totalChains }
 *
 * The response can include chains where this transaction type is switched
 * off, so those are dropped here — and a coin with no chains left with them.
 *
 * @returns {{ success: boolean, coins: Array<{ coin: string, chains: object[] }>, error?: any }}
 */
export async function getSupportedCoins(transactionType) {
  try {
    const token = getToken();

    const res = await axios.get(`${VIXA_API_BASE}/supported-currencies`, {
      httpsAgent,
      params: { transactionType },
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    const currencies = res.data?.data?.currencies;
    if (!Array.isArray(currencies)) {
      console.error(
        `getSupportedCoins(${transactionType}): no currencies list. Body:`,
        JSON.stringify(res.data)?.slice(0, 400),
      );
      return { success: false, coins: [], error: "No currencies list" };
    }

    const coins = currencies
      .map((c) => ({
        ...c,
        chains: (c.chains || []).filter(
          (ch) => ch?.chain && ch.operations?.[transactionType]?.enabled !== false,
        ),
      }))
      .filter((c) => c.coin && c.chains.length);

    console.log(
      `getSupportedCoins(${transactionType}): ${coins.length} coins —`,
      coins.map((c) => c.coin).join(", "),
    );

    return { success: true, coins };
  } catch (err) {
    console.error(
      `getSupportedCoins(${transactionType}) ERROR:`,
      err?.response?.data || err?.message,
    );
    return { success: false, coins: [], error: err?.response?.data || err?.message };
  }
}
