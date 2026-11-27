// node tests/quoteExpiry.unit.mjs
import { isQuoteStale, isQuoteExpiredError, QUOTE_REFRESHED_PREFIX } from "../src/utils/quoteExpiry.js";

let failed = 0;
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
};

const now = Date.parse("2026-11-27T10:00:00Z");
const old = now - 120_000;

// Swap and send quotes carry `expiresAt`.
check("expired → stale", isQuoteStale("2026-11-27T09:59:00Z", old, now));
check("20s left → stale", isQuoteStale("2026-11-27T10:00:20Z", old, now));
check("2 min left → fresh", !isQuoteStale("2026-11-27T10:02:00Z", old, now));
check("fetched 5s ago → never stale", !isQuoteStale("2026-11-27T09:59:00Z", now - 5_000, now));
check("no expiry → not stale", !isQuoteStale(undefined, old, now));
check("bad expiry → not stale", !isQuoteStale("soon", old, now));
check("no fetchedAt, expired → stale", isQuoteStale("2026-11-27T09:59:00Z", undefined, now));

check("expired error → refresh", isQuoteExpiredError({ message: "Quote expired" }));
check("get a new quote → refresh", isQuoteExpiredError({ message: "This quote has expired or has already been used. Get a new quote." }));
check("insufficient balance → not refresh", !isQuoteExpiredError({ message: "Insufficient balance" }));
check("transport string → not refresh", !isQuoteExpiredError("timeout of 30000ms exceeded"));

check("prefix wording", QUOTE_REFRESHED_PREFIX.startsWith("⏳ Your previous quote expired."));

console.log(`\n${failed ? "some" : "all"} checks: ${failed} failed`);
process.exit(failed ? 1 : 0);
