import crypto from "crypto";

/**
 * Verifies that an inbound webhook really came from Meta.
 *
 * Meta signs every webhook POST with HMAC-SHA256 over the RAW request body,
 * using the app secret, and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Without this check the /callback endpoint accepts a POST from anyone who
 * knows the URL — which means anyone can make the bot send messages to your
 * users, or drive a user's session into any state they like. For a webhook
 * that moves money this is not optional.
 *
 * Set WHATSAPP_APP_SECRET to enable it:
 *   Meta App Dashboard → Settings → Basic → App Secret
 *
 * While that variable is unset, requests are allowed through and a warning is
 * logged, so that deploying this cannot take the integration down before the
 * secret has been configured.
 */

let warnedMissingSecret = false;

/**
 * @param {import('express').Request} req - needs req.rawBody (see src/index.js)
 * @returns {{ ok: boolean, reason: string|null, enforced: boolean }}
 */
export function verifyMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;

  if (!secret) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn(
        "⚠️  WHATSAPP_APP_SECRET is not set — webhook signatures are NOT being " +
          "verified. Anyone who knows this URL can post to it. Set the app " +
          "secret from Meta App Dashboard → Settings → Basic → App Secret.",
      );
    }
    return { ok: true, reason: "not-configured", enforced: false };
  }

  const header = req.get("x-hub-signature-256");
  if (!header) {
    return { ok: false, reason: "missing X-Hub-Signature-256", enforced: true };
  }

  if (!req.rawBody || !req.rawBody.length) {
    // Without the raw bytes the HMAC cannot be recomputed. Fail closed:
    // silently allowing here would defeat the whole check.
    return { ok: false, reason: "raw body unavailable", enforced: true };
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  // Length check first — timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length) {
    return { ok: false, reason: "signature mismatch", enforced: true };
  }

  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch", enforced: true };
  }

  return { ok: true, reason: null, enforced: true };
}
