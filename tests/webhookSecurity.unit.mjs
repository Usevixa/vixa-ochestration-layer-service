/**
 * Proves the two webhook protections behave correctly, including the failure
 * modes that matter: a forged signature must be rejected, and a redelivered
 * message must be ignored.
 */
import crypto from "crypto";
import {
  markMessageSeen,
  dedupSize,
  resetDedup,
} from "../src/utils/messageDedup.js";

let pass = 0;
let fail = 0;
const check = (label, ok) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
};

// ── Deduplication ────────────────────────────────────────────────
console.log("--- duplicate message protection ---");
resetDedup();

check("first delivery is processed", markMessageSeen("wamid.AAA") === true);
check("redelivery is skipped", markMessageSeen("wamid.AAA") === false);
check("third delivery still skipped", markMessageSeen("wamid.AAA") === false);
check("a different message still gets through", markMessageSeen("wamid.BBB") === true);
check("missing id does not block processing", markMessageSeen(undefined) === true);
check("two ids tracked", dedupSize() === 2);

// The exact scenario from the screenshots: one message, many retries.
resetDedup();
const deliveries = Array.from({ length: 12 }, () => markMessageSeen("wamid.RETRY"));
check(
  "12 retries of one message → exactly 1 processed",
  deliveries.filter(Boolean).length === 1,
);

// ── Signature verification ───────────────────────────────────────
console.log("\n--- signature verification ---");

const SECRET = "test-app-secret";
const body = Buffer.from(JSON.stringify({ entry: [{ id: "1" }] }));
const validSig =
  "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");

function fakeReq(headers, rawBody) {
  return {
    ip: "1.2.3.4",
    rawBody,
    get: (name) => headers[name.toLowerCase()],
  };
}

// Loaded fresh so the module-level "already warned" flag doesn't interfere.
const { verifyMetaSignature } = await import("../src/utils/verifySignature.js");

delete process.env.WHATSAPP_APP_SECRET;
{
  const r = verifyMetaSignature(fakeReq({}, body));
  check("unset secret → allowed but flagged unenforced", r.ok && !r.enforced);
}

process.env.WHATSAPP_APP_SECRET = SECRET;
{
  const r = verifyMetaSignature(fakeReq({ "x-hub-signature-256": validSig }, body));
  check("valid signature → accepted and enforced", r.ok && r.enforced);
}
{
  const r = verifyMetaSignature(fakeReq({}, body));
  check("no signature header → rejected", !r.ok);
}
{
  const forged = "sha256=" + "0".repeat(64);
  const r = verifyMetaSignature(fakeReq({ "x-hub-signature-256": forged }, body));
  check("forged signature → rejected", !r.ok);
}
{
  // Same signature, body altered in transit.
  const tampered = Buffer.from(JSON.stringify({ entry: [{ id: "666" }] }));
  const r = verifyMetaSignature(
    fakeReq({ "x-hub-signature-256": validSig }, tampered),
  );
  check("tampered body → rejected", !r.ok);
}
{
  const r = verifyMetaSignature(
    fakeReq({ "x-hub-signature-256": validSig }, undefined),
  );
  check("missing raw body → fails closed, not open", !r.ok);
}
{
  const r = verifyMetaSignature(fakeReq({ "x-hub-signature-256": "short" }, body));
  check("malformed signature → rejected without throwing", !r.ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
