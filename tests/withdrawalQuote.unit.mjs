// node tests/withdrawalQuote.unit.mjs
import { buildWithdrawalQuoteText } from "../src/utils/withdrawalQuote.js";

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

console.log(`\n${failed ? "some" : "all"} checks: ${failed} failed`);
process.exit(failed ? 1 : 0);
