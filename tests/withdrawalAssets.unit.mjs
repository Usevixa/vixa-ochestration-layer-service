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
