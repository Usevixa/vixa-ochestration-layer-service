// node tests/depositAssets.unit.mjs
import { normalizeDepositAssets } from "../src/utils/depositAssets.js";
import { chainLabel } from "../src/utils/chainNames.js";

const NGN = { NGN: { min: 5000, max: 1500000 }, TZS: { min: 14500, max: 5000000 } };

// Live "Buy options" response (trimmed): flat coin + chain rows.
const live = {
  success: true,
  message: "Buy options",
  data: [
    { coin: "BTC", chain: "BITCOIN", limits: NGN },
    { coin: "USDC", chain: "BASE", limits: NGN },
    { coin: "USDC", chain: "ETHEREUM", limits: NGN },
    { coin: "USDT", chain: "POLYGON", limits: NGN },
    { coin: "USDT", chain: "SOLANA", limits: NGN },
    { coin: "USDT", chain: "TRON", limits: NGN },
    { coin: "USDT", chain: "TRON", limits: NGN }, // duplicate row
  ],
};

// Swagger's documented nested shape.
const swagger = {
  success: true,
  message: "ok",
  data: {
    success: true,
    data: [{ coin: "USDT", chains: [{ chain: "TRX", minDepositAmount: "1" }, { chain: "ETH" }] }],
  },
};

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : "  GOT " + JSON.stringify(got)}`);
};

const a = normalizeDepositAssets(live);
check("live: grouped into 3 coins in API order", JSON.stringify(a.map((x) => x.coin)) === '["BTC","USDC","USDT"]', a?.map((x) => x.coin));
const usdt = a.find((x) => x.coin === "USDT");
check("live: USDT has 3 chains (duplicate dropped)", usdt.chains.map((c) => c.chain).join() === "POLYGON,SOLANA,TRON", usdt.chains.map((c) => c.chain));

const b = normalizeDepositAssets(swagger);
check("swagger: nested shape still works", b.length === 1 && b[0].chains.length === 2, b);

check("no list → null", normalizeDepositAssets({ success: false, message: "x", data: null }) === null, "not null");
check("empty list → []", JSON.stringify(normalizeDepositAssets({ data: [] })) === "[]", normalizeDepositAssets({ data: [] }));

for (const [code, want] of [
  ["BITCOIN", "Bitcoin"], ["ETHEREUM", "Ethereum (ERC20)"], ["POLYGON", "Polygon (POS)"],
  ["SOLANA", "Solana (SPL)"], ["BASE", "Base"], ["TRON", "TRON (TRC20)"],
]) {
  check(`label ${code} → ${want}`, chainLabel(code) === want, chainLabel(code));
}

console.log(`\n${failed ? "some" : "all"} checks: ${failed} failed`);
process.exit(failed ? 1 : 0);
