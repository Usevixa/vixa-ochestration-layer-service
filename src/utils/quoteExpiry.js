/**
 * Quote expiry, shared by every flow that gets a quote before the PIN
 * (withdraw to bank, swap, send to an external wallet).
 *
 * Quotes expire while the user reads them, picks a bank or types an
 * address. Two checks keep the user from starting over:
 *   1. isQuoteStale: before asking for the PIN, get a fresh quote if the
 *      stored one has expired or is about to.
 *   2. isQuoteExpiredError: if execute still says the quote expired, get a
 *      fresh quote instead of ending the flow.
 * Either way the user sees the new quote and confirms it (and enters the
 * PIN) again, so nothing goes through at a price they didn't accept.
 */

/**
 * Execute errors a fresh quote fixes, e.g.
 *   "This quote has expired or has already been used. Get a new quote."
 *   "The coin, chain and amount do not match this quote. Get a new quote."
 * Plain transport strings (timeouts, network errors) are never treated as
 * expiry.
 */
export function isQuoteExpiredError(error) {
  const m = error && typeof error === "object" ? String(error.message || "") : "";
  return /expired|get a new quote/i.test(m);
}

/**
 * True when a quote has expired or has under 30s left, so asking for the
 * PIN now would most likely end in "quote expired". A quote fetched in the
 * last 15s is never stale, so a server clock ahead of ours can't loop the
 * user through refresh after refresh. An unknown expiry is not stale:
 * execute will tell us.
 *
 * @param {string} expiresAt  ISO time from the quote
 * @param {number} fetchedAt  Date.now() when we got the quote
 */
export function isQuoteStale(expiresAt, fetchedAt, now = Date.now()) {
  const expires = Date.parse(expiresAt || "");
  if (!Number.isFinite(expires)) return false;
  if (fetchedAt && now - fetchedAt < 15_000) return false;
  return expires - now < 30_000;
}

/** Heading put above a refreshed quote. */
export const QUOTE_REFRESHED_PREFIX =
  "⏳ Your previous quote expired. Here's the updated one 👇\n\n";
