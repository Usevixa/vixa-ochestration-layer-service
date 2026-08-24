/**
 * Spoken-number normalisation for the voice path.
 *
 * Transcription returns words ("twenty five thousand naira"), but every
 * numeric guard in intentRouter.js requires a digit — isBareAmount() and
 * extractSlots() both anchor on \d. Without this, a spoken amount misses
 * the cheap deterministic path, costs an LLM round trip, and lands on
 * "Sorry, I didn't quite get that" whenever the model times out.
 *
 * Runs ONLY on transcribed text. On typed text it would rewrite "one of my
 * wallets" -> "1 of my wallets" for no benefit.
 */

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const SCALE = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };

const key = (w) => w.toLowerCase().replace(/[^a-z]/g, "");
const isNumWord = (k) => k in SMALL || k in TENS || k in SCALE;

function runToNumber(keys) {
  let total = 0;
  let current = 0;
  let seen = false;

  for (const k of keys) {
    if (k === "and") continue;
    if (k in SMALL) { current += SMALL[k]; seen = true; }
    else if (k in TENS) { current += TENS[k]; seen = true; }
    else if (k === "hundred") { current = (current || 1) * 100; seen = true; }
    else { total += (current || 1) * SCALE[k]; current = 0; seen = true; }
  }

  return seen ? total + current : null;
}

/** "twenty five thousand naira" -> "25000 naira" */
export function wordsToNumbers(input) {
  if (!input) return input;

  const out = [];
  let run = [];

  const flush = () => {
    // A trailing "and" belongs to the sentence, not the number:
    // "fifty thousand and send it" must not swallow the "and".
    const trailing = [];
    while (run.length && key(run[run.length - 1]) === "and") {
      trailing.unshift(run.pop());
    }
    if (run.length) {
      const n = runToNumber(run.map(key));
      out.push(n == null ? run.join(" ") : String(n));
    }
    out.push(...trailing);
    run = [];
  };

  for (const w of String(input).split(/\s+/)) {
    const k = key(w);
    if (isNumWord(k) || (k === "and" && run.length)) run.push(w);
    else { flush(); out.push(w); }
  }
  flush();

  return out
    .join(" ")
    // "zero point five" -> "0 point 5" -> "0.5"
    .replace(/(\d+)\s+point\s+((?:\d+\s*)+)/gi,
      (_, a, b) => `${a}.${b.trim().split(/\s+/).join("")}`)
    .trim();
}

/**
 * Also strips terminal punctuation. MENU_REQUEST and isBareAmount are both
 * ^...$ anchored, so "Hello." and "Five thousand naira." would otherwise
 * fall through to the model for no reason.
 */
export function normalizeSpokenText(text) {
  return wordsToNumbers(String(text || "").trim())
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}