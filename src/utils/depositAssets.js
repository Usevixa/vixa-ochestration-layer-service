/**
 * Normalise GET /payment/crypto/deposits/assets into
 *   [{ coin, chains: [{ chain, limits?, minDepositAmount?, ... }] }]
 *
 * The endpoint has returned two shapes:
 *
 *   Swagger (OxSupportedCoinListResponse) — nested, grouped by coin:
 *     { success, message, data: { success, data: [{ coin, iconUrl, chains: [{ chain, ... }] }] } }
 *
 *   Live ("Buy options") — flat, one row per coin + chain:
 *     { success, message, data: [{ coin, chain, walletId, address, tag,
 *       limits: { NGN: { min, max }, ... } }] }
 *
 * Both end up the same here, so nothing downstream cares which one came back.
 *
 * @param {*} body - the parsed response body (axios `res.data`)
 * @returns {Array<{ coin: string, chains: object[] }> | null} null when no list is found
 */
export function normalizeDepositAssets(body) {
  const d = body?.data;
  const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : null;
  if (!list) return null;

  const byCoin = new Map(); // keeps the API's order
  const add = (coin, chain) => {
    const c = String(coin ?? "").trim();
    if (!c || !chain?.chain) return;
    const key = c.toUpperCase();
    if (!byCoin.has(key)) byCoin.set(key, { coin: c, chains: [] });
    const entry = byCoin.get(key);
    // The flat shape can repeat a coin + chain; keep the first.
    if (!entry.chains.some((x) => String(x.chain) === String(chain.chain))) {
      entry.chains.push(chain);
    }
  };

  for (const item of list) {
    if (Array.isArray(item?.chains)) {
      for (const ch of item.chains) add(item.coin, ch); // nested shape
    } else if (item?.chain) {
      add(item.coin, item); // flat shape: the row itself is the chain
    }
  }

  return [...byCoin.values()].filter((a) => a.chains.length);
}

/** NGN { min, max } for a chain row, or null when it has no usable NGN limits. */
export function ngnLimits(chain) {
  const l = chain?.limits?.NGN;
  const min = Number(l?.min);
  const max = Number(l?.max);
  if (!(min > 0) && !(max > 0)) return null;
  return { min: min > 0 ? min : null, max: max > 0 ? max : null };
}
