/**
 * Deterministic-path tests. Runs with OPENAI_API_KEY unset so classifyMessage()
 * returns null and we exercise ONLY the keyword/value/fallback layers — i.e.
 * the behaviour when OpenAI is slow, down, or out of credit.
 */
delete process.env.OPENAI_API_KEY;

const { resolveIntent, extractSlots, parseAmount } = await import(
  "../src/ai/intentRouter.js"
);

const DEPOSIT_AMOUNT = { authenticated: true, pendingDeposit: true };
const SWAP_AMOUNT = {
  authenticated: true,
  swap: { step: "ENTER_AMOUNT", fromCoin: "USDT", fromCoinLimits: { minAmount: 1, maxAmount: 100 } },
};
const SWAP_PIN = { authenticated: true, swap: { step: "AWAITING_SWAP_PIN" } };
const WITHDRAW_PIN = { authenticated: true, withdraw: { step: "ENTER_EXECUTE_PIN" } };
const LOCK_REASON = { authenticated: true, lockWallet: { step: "ENTER_REASON" } };
const SWAP_SELECT = { authenticated: true, swap: { step: "SELECT_FROM" } };
const IDLE = { authenticated: true };

const cases = [
  // ── The screenshots ────────────────────────────────────────────
  ["Scratch that I want to swap", DEPOSIT_AMOUNT, "SWITCH_FLOW", "SWAP"],
  ["No I want to swap instead", DEPOSIT_AMOUNT, "SWITCH_FLOW", "SWAP"],
  ["Yes that's what I said I want to swap", IDLE, "SWITCH_FLOW", "SWAP"],
  ["Swap", IDLE, "SWITCH_FLOW", "SWAP"],
  ["Deposit", IDLE, "SWITCH_FLOW", "DEPOSIT"],
  ["Balance", IDLE, "SWITCH_FLOW", "BALANCE"],

  // ── Cancel vs switch ───────────────────────────────────────────
  ["cancel", DEPOSIT_AMOUNT, "CANCEL", null],
  ["forget it", DEPOSIT_AMOUNT, "CANCEL", null],
  ["I don't want to deposit again", DEPOSIT_AMOUNT, "CANCEL", null],
  ["cancel that, let me withdraw", DEPOSIT_AMOUNT, "SWITCH_FLOW", "WITHDRAW"],
  ["abeg stop, i wan cash out", DEPOSIT_AMOUNT, "SWITCH_FLOW", "WITHDRAW"],

  // ── Priority / specificity, not array order ────────────────────
  ["give me my deposit address", IDLE, "SWITCH_FLOW", "RECEIVE"],
  ["what is my wallet address", IDLE, "SWITCH_FLOW", "RECEIVE"],
  ["my phone was stolen", IDLE, "SWITCH_FLOW", "LOCK_WALLET"],
  ["i forgot my pin", IDLE, "SWITCH_FLOW", "CHANGE_PIN"],
  ["how much do i have", IDLE, "SWITCH_FLOW", "BALANCE"],

  // ── Word boundaries: these used to trigger CANCEL ──────────────
  ["I want my money back in my bank", IDLE, "MENU", null], // offline: escalates to LLM; no longer mis-fires CANCEL
  ["5000", DEPOSIT_AMOUNT, "PROVIDE_INPUT", null],
  ["5k", DEPOSIT_AMOUNT, "PROVIDE_INPUT", null],
  ["₦20,000", DEPOSIT_AMOUNT, "PROVIDE_INPUT", null],
  ["50", SWAP_AMOUNT, "PROVIDE_INPUT", null],

  // ── Sealed states: secrets never leave, flow can still escape ──
  ["1234", SWAP_PIN, "PROVIDE_INPUT", null],
  ["what does this mean?", WITHDRAW_PIN, "ANSWER", null],
  ["cancel", WITHDRAW_PIN, "CANCEL", null],

  // ── Free-text step accepts prose that looks like a keyword ─────
  ["someone stole my phone", LOCK_REASON, "PROVIDE_INPUT", null],
  ["suspicious activity", LOCK_REASON, "PROVIDE_INPUT", null],

  // ── Already in the flow → no restart loop ──────────────────────
  ["swap", SWAP_SELECT, "SWITCH_FLOW", "SWAP"],

  // ── Menu ───────────────────────────────────────────────────────
  ["menu", IDLE, "MENU", null],
  ["hello", IDLE, "MENU", null],
];

let pass = 0;
let fail = 0;

for (const [text, session, wantType, wantFlow] of cases) {
  const d = await resolveIntent({ text, sessionData: session });
  const ok = d.type === wantType && (wantFlow === null || d.flow === wantFlow);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "✅" : "❌"} "${text}"`.padEnd(48) +
      ` → ${d.type}${d.flow ? "/" + d.flow : ""} [${d.source}]` +
      (ok ? "" : `   EXPECTED ${wantType}${wantFlow ? "/" + wantFlow : ""}`),
  );
}

console.log("\n--- slot extraction ---");
for (const t of [
  "swap 50 usdt to btc",
  "I want to deposit 20000 naira",
  "send 0.5 eth",
  "convert usdt to sol",
]) {
  console.log(`"${t}"`.padEnd(34), JSON.stringify(extractSlots(t)));
}

console.log("\n--- amount parsing ---");
for (const t of ["5k", "₦20,000", "1.5m", "500", "abc"]) {
  console.log(`"${t}"`.padEnd(12), parseAmount(t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
