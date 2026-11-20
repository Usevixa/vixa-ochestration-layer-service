// node tests/chainNames.unit.mjs
import { chainLabel } from "../src/utils/chainNames.js";

const cases = [
  ["TRX", "TRON (TRC20)"],
  ["trc20", "TRON (TRC20)"],
  ["TRC-20", "TRON (TRC20)"],
  ["ETH", "Ethereum (ERC20)"],
  ["BSC", "BNB Smart Chain (BEP20)"],
  ["bep_20", "BNB Smart Chain (BEP20)"],
  ["SOL", "Solana (SPL)"],
  ["MATIC", "Polygon (POS)"],
  ["ARBI", "Arbitrum One"],
  ["BTC", "Bitcoin"],
  ["NEWCHAIN", "NEWCHAIN"], // unknown → raw code
  ["  ton ", "TON"],
  [undefined, ""],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = chainLabel(input);
  const ok = got === want && got.length <= 30;
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${JSON.stringify(input)} → ${JSON.stringify(got)}${ok ? "" : `  EXPECTED ${JSON.stringify(want)}`}`);
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
