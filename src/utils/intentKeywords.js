/**
 * Deterministic keyword layer for VIXA intent recognition.
 *
 * This is the FAST path. It handles the ~85% of messages that are an
 * unambiguous single intent ("swap", "check my balance", "cancel") without
 * paying for an LLM round-trip. Anything ambiguous — a cancel AND a flow in
 * the same sentence, two competing flows, or nothing at all — is escalated to
 * the model by src/ai/intentRouter.js.
 *
 * Matching rules (all three matter — the old version had none of them):
 *   1. WORD BOUNDARIES. Plain `includes()` meant "back" matched "feedback"
 *      and "give me my money back", silently cancelling live transactions.
 *   2. SPECIFICITY WINS, not array order. "deposit address" (2 words) beats
 *      "deposit" (1 word), so asking for a receiving address no longer dumps
 *      the user into the NGN buy flow.
 *   3. TIES BROKEN BY PRIORITY, not by whoever was declared first in the file.
 */

/** Higher priority wins when two phrases match with the same specificity. */
const FLOW_PRIORITY = {
  LOCK_WALLET: 100, // safety first — never lose a "my phone was stolen"
  UNLOCK_WALLET: 95,
  CHANGE_PIN: 90,
  CANCEL: 80,
  RECEIVE: 70,
  WITHDRAW: 60,
  SWAP: 55,
  DEPOSIT: 50,
  SEND: 45,
  BALANCE: 40,
  SUPPORT: 25,
  SETTINGS: 20,
};

export const KEYWORD_INTENT_MAP = [
  // CANCEL triggers
  {
    flow: "CANCEL",
    keywords: [
      "cancel",
      "cancel it",
      "cancel this",
      "cancel transaction",
      "cancel transfer",
      "cancel withdrawal",
      "cancel deposit",
      "cancel swap",
      "cancel send",
      "stop",
      "stop it",
      "stop this",
      "abort",
      "end this",
      "forget it",
      "forget this",
      "never mind",
      "nevermind",
      "leave it",
      "leave am",
      "i dont want",
      "i dont want again",
      "i no do again",
      "i no want again",
      "not doing again",
      "change my mind",
      "i changed my mind",
      "scratch that",
      "ignore that",
      "ignore this",
      "go back",
      "start over",
      "restart",
      "begin again",
      "start again",
      "take me back",
      "abeg cancel",
      "please cancel",
      "cancel am",
      "stop am",
      "forget am",
      "no need again",
      "i no need am again",
      "make we stop",
      "lets stop",
    ],
  },

  // LOCK WALLET triggers — high safety priority
  {
    flow: "LOCK_WALLET",
    keywords: [
      "lock wallet",
      "lock my wallet",
      "lock my account",
      "freeze wallet",
      "freeze my wallet",
      "freeze my account",
      "block wallet",
      "block my wallet",
      "block my account",
      "disable wallet",
      "disable my wallet",
      "secure my wallet",
      "secure my account",
      "restrict my wallet",
      "restrict my account",
      "i want to lock",
      "my phone was stolen",
      "my phone is stolen",
      "i lost my phone",
      "i misplaced my phone",
      "someone stole my phone",
      "my whatsapp was hacked",
      "my account was hacked",
      "someone has access",
      "someone entered my account",
      "someone is using my account",
      "unauthorized access",
      "unauthorised access",
      "i suspect fraud",
      "fraud on my account",
      "suspicious activity",
      "suspicious transaction",
      "stop all transactions",
      "stop withdrawals",
      "pause my wallet",
      "pause my account",
      "abeg lock my wallet",
      "please lock my wallet",
      "help me lock my wallet",
      "help me freeze my wallet",
      "make nobody use my wallet",
      "make nobody withdraw",
      "my money is at risk",
      "protect my wallet",
      "protect my money",
    ],
  },

  // CHANGE PIN triggers
  {
    flow: "CHANGE_PIN",
    keywords: [
      "change pin",
      "change my pin",
      "update pin",
      "update my pin",
      "reset pin",
      "reset my pin",
      "new pin",
      "create new pin",
      "set new pin",
      "pin reset",
      "change transaction pin",
      "reset transaction pin",
      "update transaction pin",
      "forgot pin",
      "forgot my pin",
      "i forgot my pin",
      "i cant remember my pin",
      "i dont remember my pin",
      "lost my pin",
      "recover pin",
      "recover my pin",
      "change password",
      "change my password",
      "reset password",
      "reset my password",
      "update password",
      "update my password",
      "pin not working",
      "my pin is not working",
      "wrong pin",
      "pin problem",
      "pin issue",
      "i want to change pin",
      "i need to change pin",
      "help me change my pin",
      "help me reset my pin",
      "abeg reset my pin",
      "abeg change my pin",
      "i wan change my pin",
      "i wan reset my pin",
    ],
  },

  // UNLOCK WALLET triggers
  {
    flow: "UNLOCK_WALLET",
    keywords: [
      "unlock wallet",
      "unlock my wallet",
      "unlock account",
      "unlock my account",
      "unfreeze wallet",
      "unfreeze my wallet",
      "unfreeze account",
      "unfreeze my account",
      "open my wallet",
      "open wallet",
      "restore access",
      "restore my access",
      "restore wallet",
      "restore my wallet",
      "reactivate wallet",
      "reactivate my wallet",
      "reactivate account",
      "reactivate my account",
      "enable wallet",
      "enable my wallet",
      "wallet locked",
      "my wallet is locked",
      "account locked",
      "my account is locked",
      "wallet frozen",
      "my wallet is frozen",
      "account frozen",
      "my account is frozen",
      "wallet blocked",
      "my wallet is blocked",
      "i cannot access my wallet",
      "i cant access my wallet",
      "i cannot use my wallet",
      "wallet disabled",
      "my wallet was disabled",
      "help me unlock my wallet",
      "abeg unlock my wallet",
      "abeg open my wallet",
      "i want to unlock",
      "i want to unlock my wallet",
      "let me use my wallet again",
      "make my wallet work again",
    ],
  },

  // SETTINGS triggers
  {
    flow: "SETTINGS",
    keywords: [
      "settings",
      "account settings",
      "my settings",
      "open settings",
      "manage account",
      "manage my account",
      "profile",
      "my profile",
      "account profile",
      "account details",
      "edit profile",
      "update profile",
      "edit account",
      "update account",
      "notification settings",
      "privacy settings",
      "security settings",
      "abeg open settings",
      "abeg show my profile",
      "help me update my account",
    ],
  },

  // SUPPORT triggers
  {
    flow: "SUPPORT",
    keywords: [
      "support",
      "customer support",
      "customer care",
      "customer service",
      "contact support",
      "contact vixa",
      "talk to support",
      "talk to a human",
      "talk to an agent",
      "speak to someone",
      "i need help",
      "help me please",
      "report a problem",
      "report an issue",
      "complaint",
      "make a complaint",
      "my money is missing",
      "my transaction failed",
      "abeg i need help",
    ],
  },

  // WITHDRAW triggers
  {
    flow: "WITHDRAW",
    keywords: [
      "withdraw",
      "withdrawal",
      "withdraw money",
      "withdraw my money",
      "withdraw funds",
      "make withdrawal",
      "cash out",
      "cashout",
      "take out money",
      "take out my money",
      "remove money",
      "payout",
      "pay out",
      "send to bank",
      "send money to bank",
      "send to my bank",
      "transfer to bank",
      "move to bank",
      "send to my account",
      "send to account",
      "send to bank account",
      "pay into my account",
      "withdraw to bank account",
      "bank transfer",
      "send to opay",
      "withdraw to opay",
      "send to palmpay",
      "withdraw to palmpay",
      "send to kuda",
      "withdraw to kuda",
      "send to moniepoint",
      "withdraw to moniepoint",
      "sell",
      "sell usdt",
      "sell my usdt",
      "sell crypto",
      "sell my crypto",
      "sell bitcoin",
      "sell btc",
      "sell eth",
      "sell ethereum",
      "sell sol",
      "convert usdt to naira",
      "convert dollar to naira",
      "convert crypto to naira",
      "change usdt to naira",
      "change dollar to naira",
      "usdt to naira",
      "dollar to naira",
      "crypto to naira",
      "send to mobile money",
      "send to momo",
      "withdraw to mobile money",
      "withdraw to momo",
      "i want to withdraw",
      "i wan withdraw",
      "i wan cash out",
      "i want to cash out",
      "i want to sell",
      "wan sell",
      "i wan sell",
      "abeg withdraw",
      "abeg cashout",
      "help me withdraw",
      "help me cash out",
      "send my money to my bank",
      "i need my money in naira",
      "i want my money in naira",
      "i wan collect naira",
      "i wan sell my usdt",
      "help me sell usdt",
    ],
  },

  // SEND triggers
  {
    flow: "SEND",
    keywords: [
      "send crypto",
      "send usdt",
      "send btc",
      "send bitcoin",
      "send eth",
      "send ethereum",
      "send sol",
      "send bnb",
      "transfer crypto",
      "transfer usdt",
      "transfer btc",
      "transfer bitcoin",
      "transfer eth",
      "send to wallet",
      "send to another wallet",
      "send to external wallet",
      "send to wallet address",
      "send to address",
      "transfer to wallet",
      "transfer to another wallet",
      "transfer to address",
      "pay to wallet",
      "pay with crypto",
      "send to vixa user",
      "transfer to vixa user",
      "pay someone",
      "i want to send",
      "i want to send crypto",
      "i want to send usdt",
      "i want to transfer crypto",
      "help me send usdt",
      "abeg send usdt",
      "i wan send usdt",
    ],
  },

  // DEPOSIT triggers
  {
    flow: "DEPOSIT",
    keywords: [
      "deposit",
      "make deposit",
      "fund wallet",
      "fund my wallet",
      "fund account",
      "fund my account",
      "top up",
      "topup",
      "add money",
      "add funds",
      "put money",
      "put money in my wallet",
      "load wallet",
      "load my wallet",
      "recharge wallet",
      "credit wallet",
      "credit my wallet",
      "buy usdt",
      "buy dollar",
      "buy crypto",
      "buy bitcoin",
      "buy btc",
      "buy eth",
      "buy ethereum",
      "buy sol",
      "purchase usdt",
      "purchase crypto",
      "naira to usdt",
      "naira to dollar",
      "convert naira to usdt",
      "convert naira to dollar",
      "change naira to usdt",
      "exchange naira for usdt",
      "use naira to buy usdt",
      "i wan deposit",
      "i wan fund wallet",
      "i wan top up",
      "i wan buy usdt",
      "i wan buy dollar",
      "i wan buy crypto",
      "abeg fund my wallet",
      "abeg top up my wallet",
      "abeg buy usdt",
      "help me fund wallet",
      "help me buy usdt",
      "make i buy usdt",
      "i want to load my wallet",
      "i want to credit my wallet",
    ],
  },

  // RECEIVE triggers
  {
    flow: "RECEIVE",
    keywords: [
      "receive",
      "receive crypto",
      "receive usdt",
      "receive btc",
      "receive bitcoin",
      "receive eth",
      "receive sol",
      "get crypto",
      "collect crypto",
      "collect usdt",
      "my address",
      "wallet address",
      "my wallet address",
      "deposit address",
      "my deposit address",
      "usdt address",
      "btc address",
      "eth address",
      "sol address",
      "trc20 address",
      "erc20 address",
      "give me address",
      "give me my address",
      "show address",
      "show my address",
      "where can i receive",
      "where should they send",
      "what is my wallet address",
      "i need my receiving address",
      "i need my deposit address",
      "abeg give me address",
      "i wan receive usdt",
      "i wan collect usdt",
    ],
  },

  // SWAP triggers
  {
    flow: "SWAP",
    keywords: [
      "swap",
      "swap crypto",
      "swap usdt",
      "swap btc",
      "swap bitcoin",
      "swap eth",
      "swap sol",
      "convert btc to usdt",
      "convert bitcoin to usdt",
      "convert eth to usdt",
      "convert sol to usdt",
      "convert usdt to btc",
      "convert usdt to eth",
      "convert usdt to sol",
      "convert btc to eth",
      "convert eth to btc",
      "change btc to usdt",
      "change eth to usdt",
      "change sol to usdt",
      "change usdt to btc",
      "change usdt to eth",
      "exchange btc to usdt",
      "exchange eth to usdt",
      "exchange usdt to btc",
      "exchange usdt to eth",
      "i want to swap",
      "i want to swap crypto",
      "help me swap",
      "abeg swap",
      "i wan swap",
      "change btc",
      "change eth",
    ],
  },

  // BALANCE triggers
  {
    flow: "BALANCE",
    keywords: [
      "balance",
      "my balance",
      "check balance",
      "check my balance",
      "see balance",
      "see my balance",
      "show balance",
      "show my balance",
      "wallet balance",
      "account balance",
      "available balance",
      "available funds",
      "what do i have",
      "how much do i have",
      "how much is in my wallet",
      "how much money do i have",
      "how much usdt do i have",
      "how much crypto do i have",
      "check wallet",
      "check my wallet",
      "my usdt balance",
      "my btc balance",
      "my eth balance",
      "my sol balance",
      "wetin dey my wallet",
      "how much i get",
      "how much dey my wallet",
      "abeg check my balance",
      "abeg show my balance",
      "i wan see my balance",
    ],
  },
];

/** Every flow the router is allowed to return. Anything else is rejected. */
export const KNOWN_FLOWS = [
  "DEPOSIT",
  "WITHDRAW",
  "SWAP",
  "SEND",
  "RECEIVE",
  "BALANCE",
  "SUPPORT",
  "CHANGE_PIN",
  "LOCK_WALLET",
  "UNLOCK_WALLET",
  "SETTINGS",
];

/**
 * Lowercase, drop apostrophes ("don't" -> "dont"), turn every other
 * non-alphanumeric run into a single space, and pad with spaces so that
 * ` ${phrase} ` matching is a true word-boundary test.
 */
export function normalizeText(text) {
  if (!text) return " ";
  const cleaned = String(text)
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${cleaned} `;
}

/** Pre-normalize the phrase table once at module load, not on every message. */
const COMPILED = KEYWORD_INTENT_MAP.map((entry) => ({
  flow: entry.flow,
  priority: FLOW_PRIORITY[entry.flow] ?? 0,
  phrases: entry.keywords
    .map((kw) => {
      const normalized = normalizeText(kw);
      return {
        phrase: normalized,
        // Specificity = word count. "deposit address" (2) beats "deposit" (1).
        weight: normalized.trim().split(" ").filter(Boolean).length,
      };
    })
    .sort((a, b) => b.weight - a.weight),
}));

/**
 * Phrases that negate the intent that follows them. Used to tell
 * "i dont want to deposit" (cancel) apart from "cancel that, i want to
 * deposit" (switch) without an LLM call.
 */
const NEGATION_PHRASES = [
  " i dont want ",
  " i do not want ",
  " i dont need ",
  " i no want ",
  " i no need ",
  " not doing ",
  " dont want to ",
];

/**
 * Score a message against the whole phrase table.
 *
 * @returns {{
 *   cancel: {flow:string, phrase:string, weight:number, at:number}|null,
 *   flows: Array<{flow:string, phrase:string, weight:number, at:number, priority:number}>,
 *   best: {flow:string}|null,
 *   negated: boolean,
 *   ambiguous: boolean,
 * }}
 */
export function scoreKeywordIntents(text) {
  const haystack = normalizeText(text);

  const hitsByFlow = new Map();

  for (const entry of COMPILED) {
    for (const { phrase, weight } of entry.phrases) {
      const at = haystack.indexOf(phrase);
      if (at === -1) continue;

      const existing = hitsByFlow.get(entry.flow);
      // Keep only the most specific phrase per flow.
      if (!existing || weight > existing.weight) {
        hitsByFlow.set(entry.flow, {
          flow: entry.flow,
          phrase: phrase.trim(),
          weight,
          at,
          priority: entry.priority,
        });
      }
    }
  }

  const cancel = hitsByFlow.get("CANCEL") || null;
  const flows = [...hitsByFlow.values()]
    .filter((h) => h.flow !== "CANCEL")
    .sort((a, b) => b.weight - a.weight || b.priority - a.priority);

  const negated = NEGATION_PHRASES.some((p) => haystack.includes(p));

  // Ambiguous = the deterministic layer should NOT decide alone.
  //   - a cancel and a flow in one sentence ("scratch that, I want to swap")
  //   - two flows too close to call ("swap and check my balance")
  //
  // A clear winner (2+ more words of specificity) is decided locally: that's
  // what makes "give me my deposit address" resolve to RECEIVE without paying
  // for a model call, even though "deposit" also matched.
  const tooClose = flows.length > 1 && flows[0].weight - flows[1].weight < 2;

  const ambiguous = Boolean((cancel && flows.length) || tooClose);

  return {
    cancel,
    flows,
    best: flows[0] || cancel || null,
    negated,
    ambiguous,
  };
}

/**
 * Back-compatible shim for the original API.
 * Prefer scoreKeywordIntents() — this loses the ambiguity signal.
 */
export function matchKeywordIntent(text) {
  const { best } = scoreKeywordIntents(text);
  if (!best) return { flow: null, matched: false };
  return { flow: best.flow, matched: true };
}
