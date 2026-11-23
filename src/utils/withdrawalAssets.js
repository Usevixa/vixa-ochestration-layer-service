/**
 * Normalise GET /withdrawal/assets into
 *   [{ coin, availableBalance, needsConvert, networks: [{ network, available }] }]
 *
 * Live response:
 *   { success, message: "Withdrawable assets", data: [{ coin, availableBalance,
 *     needsConvert, networks: [{ network, available }] }] }
 *
 * Dust (e.g. ETH 1.14969219e-10) is dropped: a network is kept only when its
 * amount is still above 0 at 8 decimals, and a coin only when it has such a
 * network. needsConvert means the backend swaps the coin to USDT during the
 * withdrawal (the quote returns swapRate / usdtEquivalent).
 *
 * @param {*} body - the parsed response body (axios `res.data`)
 * @returns {Array|null} null when no list is found
 */
export function normalizeWithdrawalAssets(body) {
  const d = body?.data;
  const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : null;
  if (!list) return null;

  const out = [];
  for (const item of list) {
    const coin = String(item?.coin ?? "").trim();
    if (!coin) continue;

    const networks = (Array.isArray(item.networks) ? item.networks : [])
      .map((n) => ({
        network: String(n?.network ?? "").trim(),
        available: Number(n?.available),
      }))
      .filter((n) => n.network && round8(n.available) > 0);

    if (!networks.length) continue;

    out.push({
      coin,
      availableBalance: Number(item.availableBalance) || 0,
      needsConvert: item.needsConvert === true,
      networks,
    });
  }
  return out;
}

function round8(n) {
  return Number.isFinite(n) ? Number(n.toFixed(8)) : 0;
}

/** A balance for humans: up to 8 decimals, no exponent, no trailing zeros. */
export function formatCryptoAmount(n) {
  const v = round8(Number(n));
  return v.toLocaleString("en-US", { maximumFractionDigits: 8, useGrouping: true });
}
