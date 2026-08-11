/**
 * Proves the currency-list resolver handles every wrapping shape the VIXA API
 * is known to use, plus the ticker-field variations, without needing network
 * access. The real response shape is unknown for /swap/currencies — that's the
 * point: whichever of these it turns out to be, the flow now works.
 */
import {
  unwrapList,
  readCoin,
  normalizeCoins,
  resolveCurrencies,
} from "../src/utils/apiShape.js";

const COINS = [
  { coin: "BTC", minAmount: 0.001, maxAmount: 1 },
  { coin: "USDT", minAmount: 1, maxAmount: 1000 },
];

// Silence the diagnostic logging the resolver emits by design.
const realLog = console.log;
const realErr = console.error;
console.log = () => {};
console.error = () => {};

const shapes = [
  ["data.currencies (1 level)", { data: { currencies: COINS } }, "data.currencies"],
  ["data.data.currencies (what the code assumed)", { data: { data: { currencies: COINS } } }, "data.data.currencies"],
  ["currencies at root", { currencies: COINS }, "currencies"],
  ["data.data.data (what RECEIVE uses)", { data: { data: { data: COINS } } }, "data.data.data"],
  ["data.data as a bare array", { data: { data: COINS } }, "data.data"],
  ["data as a bare array", { data: COINS }, "data"],
  ["bare array at root", COINS, "<root>"],
];

let pass = 0;
let fail = 0;

for (const [label, payload, expectedPath] of shapes) {
  const { list, path } = unwrapList(payload, "test");
  const ok = path === expectedPath && list.length === 2;
  ok ? pass++ : fail++;
  realLog(`${ok ? "✅" : "❌"} ${label.padEnd(44)} → "${path}" (${list.length} items)`);
}

realLog("\n--- ticker field variations ---");
const tickerCases = [
  [{ coin: "btc" }, "BTC"],
  [{ symbol: "eth" }, "ETH"],
  [{ ticker: "SOL" }, "SOL"],
  [{ code: "usdt" }, "USDT"],
  [{ currency: "bnb" }, "BNB"],
  [{ name: "Bitcoin" }, null], // no recognised key
];
for (const [item, expected] of tickerCases) {
  const got = readCoin(item);
  const ok = got === expected;
  ok ? pass++ : fail++;
  realLog(`${ok ? "✅" : "❌"} ${JSON.stringify(item).padEnd(28)} → ${got}`);
}

realLog("\n--- normalizeCoins guarantees .coin ---");
{
  const out = normalizeCoins([{ symbol: "eth", minAmount: 1 }, { name: "junk" }]);
  const ok = out.length === 1 && out[0].coin === "ETH" && out[0].minAmount === 1;
  ok ? pass++ : fail++;
  realLog(`${ok ? "✅" : "❌"} symbol-keyed item gains .coin, unusable item dropped → ${JSON.stringify(out)}`);
}

realLog("\n--- failure modes are distinguished ---");
{
  const empty = resolveCurrencies({ data: { currencies: [] } }, "t");
  const ok1 = empty.reason === "empty";
  const noTicker = resolveCurrencies({ data: { currencies: [{ name: "Bitcoin" }] } }, "t");
  const ok2 = noTicker.reason === "no-ticker-field";
  const good = resolveCurrencies({ data: { currencies: COINS } }, "t");
  const ok3 = good.reason === null;
  [ok1, ok2, ok3].forEach((o) => (o ? pass++ : fail++));
  realLog(`${ok1 ? "✅" : "❌"} empty list        → "${empty.reason}"`);
  realLog(`${ok2 ? "✅" : "❌"} unknown ticker key → "${noTicker.reason}"`);
  realLog(`${ok3 ? "✅" : "❌"} healthy response   → ${good.reason}`);
}

console.log = realLog;
console.error = realErr;
realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
