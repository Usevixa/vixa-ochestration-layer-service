import { chainLabel } from "./chainNames.js";
import { isQuoteExpiredError, isQuoteStale } from "./quoteExpiry.js";

/**
 * Quote message for POST /withdrawal/quote. Response `data`:
 *   { quoteId, coin, chain, coinAmount, availableBalance, hasEnoughBalance,
 *     shortfall, usdtEquivalent, swapRate, networkFee, vixaFee, totalFees,
 *     finalUsdtAmount, rate, estimatedFiat, fiatCurrency, quoteExpiresAt }
 * Older field names (totalDebit, expiresAt) are still read. Any missing field
 * drops its line instead of printing "undefined".
 */
export function buildWithdrawalQuoteText(q = {}, { network, ask = true } = {}) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const coin = q.coin || "";
  const fiat = q.fiatCurrency || "";
  const money = (v) =>
    Number(v).toLocaleString("en-NG", { maximumFractionDigits: 2 });
  const fiatAmount = (v) =>
    fiat === "NGN" ? `₦${money(v)}` : `${money(v)} ${fiat}`.trim();
  // toFixed(8) trims float noise (0.016 + 0.025564 = 0.041564000000000005).
  const crypto = (v) => Number(Number(v).toFixed(8));

  const lines = [];
  const withdrawing = has(q.coinAmount) ? q.coinAmount : q.totalDebit;
  if (has(withdrawing)) lines.push(`Withdrawing: ${crypto(withdrawing)} ${coin}`.trim());

  const chain = q.chain || network;
  if (chain) lines.push(`Network: ${chainLabel(chain)}`);

  // Coin + chain with no custody wallet: the backend swaps to USDT first.
  if (coin && coin.toUpperCase() !== "USDT" && has(q.usdtEquivalent)) {
    lines.push(`Swapped to: ≈ ${crypto(q.usdtEquivalent)} USDT`);
  }

  const fees = has(q.totalFees)
    ? [Number(q.totalFees)]
    : [q.vixaFee, q.networkFee].filter(has).map(Number);
  if (fees.length) {
    const feeCoin = has(q.totalFees) && has(q.usdtEquivalent) ? "USDT" : coin;
    lines.push(`Fees: ${crypto(fees.reduce((a, b) => a + b, 0))} ${feeCoin}`.trim());
  }

  if (has(q.estimatedFiat))
    lines.push(`You'll receive: ≈ ${money(q.estimatedFiat)} ${fiat}`.trim());
  if (has(q.rate) && coin) lines.push(`Rate: 1 ${coin} = ${fiatAmount(q.rate)}`);

  const expiresAt = q.quoteExpiresAt || q.expiresAt;
  if (has(expiresAt)) {
    const expiry = new Date(expiresAt);
    if (!isNaN(expiry)) {
      lines.push(
        `Expires: ${expiry.toLocaleTimeString("en-NG", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
          timeZone: "Africa/Lagos",
        })}`,
      );
    }
  }

  if (q.hasEnoughBalance === false) {
    const where = chain ? ` on ${chainLabel(chain)}` : "";
    const by = has(q.shortfall) ? ` You're short by ${crypto(q.shortfall)} ${coin}.` : "";
    const bal = has(q.availableBalance)
      ? ` Available: ${crypto(q.availableBalance)} ${coin}.`
      : "";
    lines.push("", `⚠️ Not enough balance${where}.${by}${bal}`);
  }

  if (!lines.length) lines.push("Your quote is ready.");

  const tail = ask ? "\n\nDo you want to proceed?" : "";
  return `📊 *Withdrawal Quote*\n\n${lines.join("\n")}${tail}`;
}

export { isQuoteExpiredError };

/** isQuoteStale for the withdraw session ({ quoteExpiresAt, quoteFetchedAt }). */
export function isWithdrawalQuoteStale(w = {}, now = Date.now()) {
  return isQuoteStale(w.quoteExpiresAt, w.quoteFetchedAt, now);
}
