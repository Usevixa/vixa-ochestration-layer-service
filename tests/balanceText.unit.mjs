// node tests/balanceText.unit.mjs
import { formatBalanceLines } from "../src/utils/balanceText.js";

// fetchWalletBalances() output for the live /wallet/get-balances response.
const live = [
  { coin: "ETH", balance: "0.000000000114969219",
    networks: [{ network: "ethereum", available: "0.000000000114969219" }] },
  { coin: "SOL", balance: "0.010030345",
    networks: [{ network: "solana", available: "0.010030345" }] },
  { coin: "USDT", balance: "2.43933636", networks: [
    { network: "polygon", available: "1.998582" },
    { network: "solana", available: "0.44075436" },
  ] },
];

const want = [
  "• SOL: 0.010030345",
  "• USDT: 2.43933636",
  "   – Polygon (POS): 1.998582",
  "   – Solana (SPL): 0.44075436",
].join("\n");

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : "\n" + got}`);
};

const got = formatBalanceLines(live);
check("live response → per network, ETH dust hidden", got === want, got);
check("one network → total only", formatBalanceLines([live[1]]).split("\n").length === 1, formatBalanceLines([live[1]]));
check("dust network dropped, one left → total only",
  formatBalanceLines([{ coin: "USDT", balance: "5", networks: [{ network: "solana", available: "5" }, { network: "polygon", available: "1e-12" }] }]) === "• USDT: 5",
  "");
check("only dust → empty", formatBalanceLines([live[0]]) === "", formatBalanceLines([live[0]]));
check("no networks field → total", formatBalanceLines([{ coin: "BTC", balance: "0.5" }]) === "• BTC: 0.5", "");
check("trailing zeros trimmed", formatBalanceLines([{ coin: "USDT", balance: "2.500000" }]) === "• USDT: 2.5", formatBalanceLines([{ coin: "USDT", balance: "2.500000" }]));
check("null → empty", formatBalanceLines(null) === "", "");

console.log(`\n${failed ? "some" : "all"} checks: ${failed} failed`);
process.exit(failed ? 1 : 0);
