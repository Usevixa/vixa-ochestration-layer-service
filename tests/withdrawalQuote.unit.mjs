// node tests/withdrawalQuote.unit.mjs
import {
  buildWithdrawalQuoteText,
  isQuoteExpiredError,
  isWithdrawalQuoteStale,
} from "../src/utils/withdrawalQuote.js";

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : "\n   GOT: " + JSON.stringify(got)}`);
};

const ok = buildWithdrawalQuoteText({
  quoteId: 1, coin: "USDT", chain: "solana", coinAmount: 50, totalFees: 0.5,
  estimatedFiat: 75000, fiatCurrency: "NGN", rate: 1500, hasEnoughBalance: true,
});
check("shows network from quote chain", /Network: Solana \(SPL\)/.test(ok), ok);
check("shows withdrawing (coinAmount)", /Withdrawing: 50 USDT/.test(ok), ok);
check("asks to proceed", /Do you want to proceed\?/.test(ok), ok);
check("no undefined", !/undefined/.test(ok), ok);

const swap = buildWithdrawalQuoteText({ coin: "SOL", chain: "solana", coinAmount: 0.5, usdtEquivalent: 70.12 });
check("swap line for non-USDT", /Swapped to: ≈ 70.12 USDT/.test(swap), swap);

const short = buildWithdrawalQuoteText(
  { coin: "USDT", chain: "solana", coinAmount: 60, hasEnoughBalance: false, shortfall: 10, availableBalance: 50 },
  { ask: false },
);
check("shortfall line", /Not enough balance on Solana \(SPL\)\. You're short by 10 USDT\. Available: 50 USDT\./.test(short), short);
check("shortfall doesn't ask to proceed", !/proceed/.test(short), short);

const noChain = buildWithdrawalQuoteText({ coin: "USDT", totalDebit: 5 }, { network: "polygon" });
check("falls back to session network + old field", /Network: Polygon \(POS\)/.test(noChain) && /Withdrawing: 5 USDT/.test(noChain), noChain);

// Execute errors that a fresh quote fixes.
check("expired/used → refresh", isQuoteExpiredError({ message: "This quote has expired or has already been used. Get a new quote." }), "");
check("mismatch → refresh", isQuoteExpiredError({ message: "The coin, chain and amount do not match this quote. Get a new quote." }), "");
check("invalid PIN → not refresh", !isQuoteExpiredError({ message: "Invalid PIN" }), "");
check("transport string → not refresh", !isQuoteExpiredError("timeout of 30000ms exceeded"), "");
check("null → not refresh", !isQuoteExpiredError(null), "");

// Stale check before the PIN.
const now = Date.parse("2026-11-26T10:00:00Z");
const old = now - 5 * 60_000;
check("expired → stale", isWithdrawalQuoteStale({ quoteExpiresAt: "2026-11-26T09:59:00Z", quoteFetchedAt: old }, now), "");
check("20s left → stale", isWithdrawalQuoteStale({ quoteExpiresAt: "2026-11-26T10:00:20Z", quoteFetchedAt: old }, now), "");
check("2 min left → fresh", !isWithdrawalQuoteStale({ quoteExpiresAt: "2026-11-26T10:02:00Z", quoteFetchedAt: old }, now), "");
check("no expiry → not stale", !isWithdrawalQuoteStale({ quoteFetchedAt: old }, now), "");
check("just fetched → never stale (clock skew)", !isWithdrawalQuoteStale({ quoteExpiresAt: "2026-11-26T09:59:00Z", quoteFetchedAt: now - 5_000 }, now), "");

console.log(`\n${failed ? "some" : "all"} checks: ${failed} failed`);
process.exit(failed ? 1 : 0);
