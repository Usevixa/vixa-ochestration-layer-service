

export const KEYWORD_INTENT_MAP = [
  // DEPOSIT triggers
  {
    keywords: ["buy", "purchase", "fund", "top up", "topup", "add money",
               "recharge", "load", "credit my wallet", "i want to buy",
               "make deposit", "put money"],
    flow: "DEPOSIT",
  },
  // WITHDRAW triggers
  {
    keywords: ["withdraw", "cash out", "take out", "remove money",
               "send to bank", "bank transfer"],
    flow: "WITHDRAW",
  },
  // SEND triggers
  {
    keywords: ["send", "transfer to", "pay someone", "send crypto"],
    flow: "SEND",
  },
  // RECEIVE triggers
  {
    keywords: ["receive", "get crypto", "my address", "wallet address",
               "deposit address"],
    flow: "RECEIVE",
  },
  // SWAP triggers
  {
    keywords: ["swap", "convert", "exchange", "change btc", "change eth"],
    flow: "SWAP",
  },
  // BALANCE triggers
  {
    keywords: ["balance", "how much", "check wallet", "my wallet",
               "what do i have"],
    flow: "BALANCE",
  },
  // CANCEL triggers
  {
    keywords: ["cancel", "stop", "abort", "forget it", "never mind",
               "start over", "restart", "go back", "scratch that",
               "leave it", "i don't want", "change my mind"],
    flow: "CANCEL",
  },
];

/**
 * Returns { flow, matched: true } if a keyword matches,
 * or { flow: null, matched: false } if nothing matches.
 */
export function matchKeywordIntent(text) {
  if (!text) return { flow: null, matched: false };
  const lower = text.toLowerCase().trim();

  for (const entry of KEYWORD_INTENT_MAP) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) {
        return { flow: entry.flow, matched: true };
      }
    }
  }
  return { flow: null, matched: false };
}