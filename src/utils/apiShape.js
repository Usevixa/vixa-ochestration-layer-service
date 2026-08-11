/**
 * Response-shape normalisation for the VIXA API.
 *
 * Why this exists: the API does not wrap list responses consistently. Compare
 * the two call sites that shipped before this file:
 *
 *   receive:  walletsRes?.data?.data?.data     // three levels
 *   swap:     currenciesRes?.data?.data?.currencies  // two levels
 *   banks:    banksRes.data                    // used directly as an array
 *
 * When a hard-coded path guesses wrong the result is `undefined`, and the very
 * next line calls `.find()` or `.map()` on it — which is exactly how the swap
 * flow died silently. Rather than hard-code another guess, resolve the list by
 * probing known shapes and LOG which one matched, so the real contract becomes
 * visible in Seq instead of being rediscovered from screenshots.
 */

/** Paths probed in order. First one yielding a non-empty array wins. */
const LIST_PATHS = [
  ["data", "currencies"],
  ["data", "data", "currencies"],
  ["currencies"],
  ["data", "data", "data"],
  ["data", "data"],
  ["data", "items"],
  ["data", "list"],
  ["data"],
  [],
];

function at(obj, path) {
  return path.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Find the list inside an arbitrarily wrapped API payload.
 *
 * @param {*} payload - the `data` field of a service result
 * @param {string} label - for logging, e.g. "swap/currencies"
 * @returns {{ list: any[], path: string, sampleKeys: string[] }}
 */
export function unwrapList(payload, label = "list") {
  for (const path of LIST_PATHS) {
    const value = at(payload, path);
    if (Array.isArray(value) && value.length) {
      const pathStr = path.length ? path.join(".") : "<root>";
      const sampleKeys =
        value[0] && typeof value[0] === "object" ? Object.keys(value[0]) : [];
      return { list: value, path: pathStr, sampleKeys };
    }
  }

  // Nothing found — log enough to identify the real shape next time.
  console.error(
    `[apiShape] ${label}: no list found. top-level keys =`,
    payload && typeof payload === "object" ? Object.keys(payload) : typeof payload,
    "| body =",
    JSON.stringify(payload)?.slice(0, 600),
  );

  return { list: [], path: "none", sampleKeys: [] };
}

/** Field names an item might use for its ticker, in preference order. */
const COIN_KEYS = ["coin", "symbol", "ticker", "code", "currency", "asset"];

/**
 * Read an item's coin ticker regardless of which field name it uses.
 * Returns null when the item carries none of the known keys.
 */
export function readCoin(item) {
  if (!item || typeof item !== "object") return null;
  for (const key of COIN_KEYS) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
  }
  return null;
}

/**
 * Guarantee every item exposes a `.coin` field.
 *
 * Downstream code builds picker rows with `id: c.coin, title: c.coin`. If the
 * API keys its ticker as `symbol`, every row renders the string "undefined"
 * and selection matching breaks. Normalising here means no call site has to
 * care which field name came back.
 */
export function normalizeCoins(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const coin = readCoin(item);
      return coin ? { ...item, coin } : null;
    })
    .filter(Boolean);
}

/**
 * Resolve a currency list and report precisely which of the two failure modes
 * occurred, because they need different fixes:
 *   - "empty"       -> the API returned no list at all (wrong path or error)
 *   - "no-matches"  -> a list came back but none of its tickers are recognised
 *
 * @returns {{ list: any[], path: string, sampleKeys: string[], reason: string|null }}
 */
export function resolveCurrencies(payload, label) {
  const { list, path, sampleKeys } = unwrapList(payload, label);

  if (!list.length) {
    return { list, path, sampleKeys, reason: "empty" };
  }

  const tickers = list.map(readCoin).filter(Boolean);
  if (!tickers.length) {
    console.error(
      `[apiShape] ${label}: found ${list.length} items at "${path}" but none carry a recognisable ticker.`,
      "keys on first item =",
      sampleKeys,
      "| first item =",
      JSON.stringify(list[0])?.slice(0, 300),
    );
    return { list, path, sampleKeys, reason: "no-ticker-field" };
  }

  console.log(
    `[apiShape] ${label}: ${list.length} items at "${path}", tickers = ${tickers.slice(0, 12).join(", ")}${tickers.length > 12 ? "…" : ""}`,
  );

  return { list, path, sampleKeys, reason: null };
}
