// node tests/withdrawalAssets.unit.mjs
import { normalizeWithdrawalAssets, formatCryptoAmount } from "../src/utils/withdrawalAssets.js";
import { chainLabel } from "../src/utils/chainNames.js";

// Live "Withdrawable assets" response.
const live = {
  success: true,
  message: "Withdrawable assets",
  data: [
    { coin: "USDT", availableBalance: 1.44075436, needsConvert: false,
      networks: [{ network: "solana", available: 1.44075436 }] },
    { coin: "SOL", availableBalance: 0.010030345, needsConvert: true,
      networks: [{ network: "solana", available: 0.010030345 }] },
    { coin: "ETH", availableBalance: 1.14969219e-10, needsConvert: true,
      networks: [{ network: "ethereum", available: 1.14969219e-10 }] },
  ],
};

let failed = 0;
const check = (label, ok, got) => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : "  GOT " + JSON.stringify(got)}`);
};

const a = normalizeWithdrawalAssets(live);
check("dust ETH dropped, order kept", a.map((x) => x.coin).join() === "USDT,SOL", a.map((x) => x.coin));
check("needsConvert read", a[0].needsConvert === false && a[1].needsConvert === true, a);
check("network kept raw", a[0].networks[0].network === "solana", a[0].networks);
check("old shape: network inherits coin flag", a[1].networks[0].needsConvert === true && a[0].networks[0].needsConvert === false, a);

// New shape: needsConvert per network; coin flag true only when all are.
const perChain = normalizeWithdrawalAssets({ data: [
  { coin: "USDT", availableBalance: 370, needsConvert: false, networks: [
    { network: "solana", available: 50, needsConvert: false },
    { network: "polygon", available: 300, needsConvert: false },
    { network: "ethereum", available: 20, needsConvert: true },
  ] },
  { coin: "BTC", availableBalance: 0.1, needsConvert: true, networks: [
    { network: "bitcoin", available: 0.1, needsConvert: true },
  ] },
  { coin: "ZERO", availableBalance: 0, needsConvert: false, networks: [{ network: "x", available: 0 }] },
] });
check("per-network flags kept", perChain[0].networks.map((n) => n.needsConvert).join() === "false,false,true", perChain[0].networks);
check("coin flag false when some chain needs no swap", perChain[0].needsConvert === false, perChain[0]);
check("coin flag true when all chains need a swap", perChain[1].needsConvert === true, perChain[1]);
check("zero balance coin dropped", !perChain.some((x) => x.coin === "ZERO"), perChain.map((x) => x.coin));
check("no list → null", normalizeWithdrawalAssets({ success: false, data: null }) === null, "not null");
check("empty list → []", JSON.stringify(normalizeWithdrawalAssets({ data: [] })) === "[]", "");

check("format 1.44075436", formatCryptoAmount(1.44075436) === "1.44075436", formatCryptoAmount(1.44075436));
check("format 0.010030345 → 8dp", formatCryptoAmount(0.010030345) === "0.01003035" || formatCryptoAmount(0.010030345) === "0.01003034", formatCryptoAmount(0.010030345));
check("format no exponent", !/e/i.test(formatCryptoAmount(1.14969219e-10)), formatCryptoAmount(1.14969219e-10));
check("format 1200.5", formatCryptoAmount(1200.5) === "1,200.5", formatCryptoAmount(1200.5));

check("label solana", chainLabel("solana") === "Solana (SPL)", chainLabel("solana"));
check("label ethereum", chainLabel("ethereum") === "Ethereum (ERC20)", chainLabel("ethereum"));

console.log(`\n${failed ? "some" : "all"} checks: ${failed} failed`);
process.exit(failed ? 1 : 0);
