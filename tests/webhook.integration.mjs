/**
 * End-to-end test of the REAL webhook route.
 *
 * IMPORTANT: every import here is DYNAMIC and happens after the env is
 * rewritten. Static `import` statements are hoisted and would run before these
 * assignments, which would let the test hit production. Do not "tidy" these
 * back into top-level imports.
 *
 *   WHATSAPP_TOKEN unset      -> sendWhatsApp takes its [MOCK send] branch
 *   VIXA_API_BASE  -> dead port -> no request reaches api.usevixa.com
 */
process.env.WHATSAPP_TOKEN = "";
delete process.env.WHATSAPP_TOKEN;
process.env.VIXA_API_BASE = "http://127.0.0.1:9";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const express = (await import("express")).default;
const router = (await import("../src/routes/webhook.js")).default;
const { updateSession, getSession } = await import(
  "../src/services/session.service.js"
);

// Fail loudly if the guard above ever stops working.
if (process.env.WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN still set!");

const sent = [];
const errors = [];
const realLog = console.log;
const realError = console.error;

console.log = (...a) => {
  const s = a.map(String).join(" ");
  if (s.startsWith("[MOCK send]")) sent.push(a[2]);
  if (s.startsWith("[MOCK ITEM FLOW]")) sent.push("<item-selection flow sent>");
  if (s.startsWith("[MOCK PIN FLOW]")) sent.push("<PIN flow sent: " + s.split("context:")[1]?.trim() + ">");
  if (s.startsWith("[MOCK FLOW]")) sent.push("<onboarding flow sent>");
};
console.error = (...a) => {
  const s = a.map(String).join(" ");
  errors.push(s);
};

process.on("uncaughtException", (e) => realError("💥 UNCAUGHT:", e));
process.on("unhandledRejection", (e) => realError("💥 UNHANDLED REJECTION:", e));

const app = express();
app.use(express.json());
app.use("/", router);
const server = app.listen(0);
const port = server.address().port;

const RAW_PHONE = "2348000000001";
const KEY = "+2348000000001"; // normalizePhone() prefixes with '+'

function payload(text) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "TEST_PNID" },
              messages: [
                {
                  from: RAW_PHONE,
                  id: "wamid." + Math.random(),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function send(text, seed) {
  sent.length = 0;
  errors.length = 0;

  await updateSession(KEY, {
    data: {
      authenticated: true,
      firstName: "Tobi",
      phone_number_id: "TEST_PNID",
      token: "test-token", // auth.service reads `token`
      tokenExpiresAt: Date.now() + 3_600_000,
      ...seed,
    },
  });

  await fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload(text)),
  });

  // Wait for a quiet period rather than a fixed sleep — an LLM round-trip can
  // outlast any guess, and a truncated window looks identical to real silence.
  let lastCount = -1;
  let quietFor = 0;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (sent.length === lastCount) {
      quietFor += 500;
      if (quietFor >= 3000 && sent.length > 0) break;
      // Must exceed INTENT_TIMEOUT_MS (6s) x maxRetries(1) plus overhead,
      // or a slow OpenAI call is indistinguishable from genuine silence.
      if (quietFor >= 20_000) break;
    } else {
      lastCount = sent.length;
      quietFor = 0;
    }
  }

  return {
    sent: [...sent],
    thrown: errors.filter((e) => e.includes("Error processing webhook")),
    state: (await getSession(KEY)).data,
  };
}

const BLANK = {
  pendingDeposit: false,
  awaitingDepositPin: false,
  awaitingDepositConfirmation: false,
  awaitingPin: false,
  pendingSwitch: null,
  swap: null,
  send: null,
  withdraw: null,
  receive: null,
  lockWallet: null,
  unlockWallet: null,
  changePin: null,
};

const cases = [
  ["THE SCREENSHOT BUG: cancel+switch mid-deposit", "Scratch that I want to swap", { ...BLANK, pendingDeposit: true }, /swap|couldn't open/i],
  ["Swap entry, API down (was silent)", "Swap", { ...BLANK }, /available|couldn't open|swap/i],
  ["Deposit entry", "I want to deposit", { ...BLANK }, /amount in NGN/i],
  ["Amount below minimum", "400", { ...BLANK, pendingDeposit: true }, /between ₦500/i],
  ["'5k' normalises to 5000 (passes min)", "5k", { ...BLANK, pendingDeposit: true }, /^(?!.*between ₦500)/i],
  ["Question mid-flow keeps place", "What does this mean?", { ...BLANK, pendingDeposit: true }, /amount in NGN/i],
  ["Plain cancel", "cancel", { ...BLANK, pendingDeposit: true }, /cancelled/i],
  ["Text at a SELECT step (was a logout)", "hmm ok", { ...BLANK, swap: { step: "SELECT_FROM" } }, /didn't|swap/i],
  ["Committed step asks before switching", "I want to swap", { ...BLANK, withdraw: { step: "ENTER_EXECUTE_PIN" } }, /yes.*no|cancel it/i],
  ["Free-text lock reason not re-routed", "someone stole my phone", { ...BLANK, lockWallet: { step: "ENTER_REASON" } }, /./],
  ["Balance, API down", "check my balance", { ...BLANK }, /./],
  ["Receive, API down", "give me my wallet address", { ...BLANK }, /./],
  ["Gibberish at the menu", "asdkjhasd", { ...BLANK }, /./],
];

let thrown = 0;
let silent = 0;
let unmatched = 0;

for (const [label, text, seed, expect] of cases) {
  const r = await send(text, seed);
  const isSilent = r.sent.length === 0;
  const joined = r.sent
    .map((m) =>
      typeof m === "string" ? m : m?.interactive?.body?.text || JSON.stringify(m),
    )
    .join(" ⟂ ");
  const matched = expect ? expect.test(joined) : true;

  if (r.thrown.length) thrown++;
  if (isSilent) silent++;
  if (!isSilent && !matched) unmatched++;

  const icon = r.thrown.length ? "💥" : isSilent ? "🔇" : matched ? "✅" : "⚠️ ";
  realLog(`\n${icon} ${label}`);
  realLog(`   in:  "${text}"`);
  if (isSilent) realLog("   out: (NOTHING — user sees silence)");
  r.sent.forEach((m) => {
    const txt =
      typeof m === "string"
        ? m
        : m?.interactive?.body?.text || JSON.stringify(m).slice(0, 90);
    realLog(`   out: ${String(txt).replace(/\n/g, " ⏎ ").slice(0, 130)}`);
  });
  if (r.thrown.length) realLog(`   THREW: ${r.thrown[0].slice(0, 180)}`);
  if (r.state.awaitingPin) realLog("   ⚠️  session flipped to awaitingPin (logged out!)");
  if (r.state.pendingSwitch) realLog(`   ✔ state: pendingSwitch → ${r.state.pendingSwitch.flow}`);
}

realLog(
  `\n${"─".repeat(64)}\n${cases.length} scenarios · ${thrown} threw · ${silent} silent · ${unmatched} unexpected output`,
);

server.close();
process.exit(thrown || silent || unmatched ? 1 : 0);
