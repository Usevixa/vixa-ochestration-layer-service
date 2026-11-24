import { chainLabel } from "./chainNames.js";
import { formatCryptoAmount } from "./withdrawalAssets.js";

/** Above 0 once rounded to 8 decimals; dust like 1.1e-10 is not. */
const shown = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && Number(n.toFixed(8)) > 0;
};

/**
 * The API's exact decimal string (never rounded up, so we never show more
 * than the user has), with trailing zeros trimmed. Numbers or exponent
 * strings fall back to the 8-decimal formatter.
 */
const amount = (v) => {
  const t = String(v ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    return t.includes(".") ? t.replace(/\.?0+$/, "") : t;
  }
  return formatCryptoAmount(v);
};

/**
 * Balance lines for the "Your Wallet Balances" message, from
 * fetchWalletBalances(): [{ coin, balance, networks: [{ network, available }] }].
 *
 *   • USDT: 2.43933636
 *      – Polygon (POS): 1.998582
 *      – Solana (SPL): 0.44075436
 *   • SOL: 0.010030345
 *
 * A coin held on one network shows only its total. Dust is hidden, both
 * whole coins and single networks. Returns "" when nothing is left to show.
 */
export function formatBalanceLines(balances = []) {
  const lines = [];
  for (const b of balances || []) {
    if (!b?.coin || !shown(b.balance)) continue;
    lines.push(`• ${b.coin}: ${amount(b.balance)}`);

    const nets = (b.networks || []).filter((n) => n?.network && shown(n.available));
    if (nets.length > 1) {
      for (const n of nets) {
        lines.push(`   – ${chainLabel(n.network)}: ${amount(n.available)}`);
      }
    }
  }
  return lines.join("\n");
}
