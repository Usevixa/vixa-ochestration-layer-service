/**
 * Remembers which WhatsApp message ids have already been handled.
 *
 * Meta redelivers a webhook whenever it does not receive a prompt 200 — which
 * is exactly what happens while the container is crash-looping or restarting.
 * Those retries continue with backoff for up to ~7 days. With no record of
 * what has already been processed, every redelivery re-runs the full handler
 * and the user receives the same replies again... and again.
 *
 * That is the cause of a bot appearing to send messages nobody asked for.
 *
 * Kept in memory, matching session.service.js. A restart forgets everything,
 * which in the worst case means one duplicate reply per in-flight message —
 * a far smaller failure than the retry storm it prevents. Move both to Redis
 * together when sessions move.
 */

const TTL_MS = Number(process.env.MSG_DEDUP_TTL_MS || 30 * 60 * 1000); // 30 min
const MAX_ENTRIES = Number(process.env.MSG_DEDUP_MAX || 10_000);

/** @type {Map<string, number>} message id -> first-seen timestamp */
const seen = new Map();

function prune(now) {
  for (const [id, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(id);
    else break; // Map preserves insertion order, so the rest are newer.
  }

  // Hard cap, in case of a flood of unique ids within the TTL window.
  while (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * Record a message id and report whether it is new.
 *
 * @param {string} messageId - `msg.id` from the webhook payload (wamid...)
 * @returns {boolean} true if this is the first time we have seen it
 */
export function markMessageSeen(messageId) {
  if (!messageId) return true; // Nothing to key on — do not block processing.

  const now = Date.now();
  prune(now);

  if (seen.has(messageId)) return false;

  seen.set(messageId, now);
  return true;
}

/** Exposed for tests and diagnostics. */
export function dedupSize() {
  return seen.size;
}

/** Exposed for tests. */
export function resetDedup() {
  seen.clear();
}
