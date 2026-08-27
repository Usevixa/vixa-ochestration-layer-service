/**
 * Single source of truth for "where is this user right now, and what are we
 * waiting on them to type?"
 *
 * Before this file, that knowledge was scattered across a 20-line boolean in
 * webhook.js (which listed 12 of ~25 states) and a 3-line `currentContext`
 * string in ai.service.js (which listed 3). Anything not on those lists fell
 * through to "no active flow", which is why mid-flow messages got answered
 * with "I don't have any specific context to respond to" and why unmatched
 * text re-sent the main menu on top of a live transaction.
 *
 * Every state carries:
 *   expecting  — the kind of value we want, so the router can validate cheaply
 *   sealed     — true for secrets (PIN/OTP/NIN/BVN). Sealed input is NEVER
 *                sent to the LLM and never reinterpreted as an intent.
 *   committed  — true once money is one confirmation away. Abandoning a
 *                committed step requires an explicit yes/no from the user.
 *   pinContext — PIN steps only: the triggerPinFlow() context that reopens
 *                the Flow. PINs are never typed in VIXA, so a re-prompt has
 *                to re-send the Flow button rather than a bare string.
 *   describe   — plain English, injected into the model prompt
 *   rePrompt   — what to re-send after answering a question, so the user is
 *                never left wondering what we wanted
 */

const UNKNOWN_STATE = {
  active: false,
  flow: null,
  step: null,
  expecting: null,
  sealed: false,
  committed: false,
  describe: "Nothing in progress. The user is at the main menu.",
  rePrompt: null,
  pinContext: null,
};

/**
 * @param {object} sessionData - session.data from session.service.js
 * @returns {typeof UNKNOWN_STATE}
 */
export function describeFlowState(sessionData) {
  const d = sessionData || {};

  const state = (partial) => ({ ...UNKNOWN_STATE, active: true, ...partial });

  // ── Authentication / onboarding ────────────────────────────────
  if (d.awaitingPin) {
    return state({
      flow: "LOGIN",
      step: "AWAITING_PIN",
      expecting: "pin",
      sealed: true,
      pinContext: "LOGIN",
      describe: "Waiting for the user's 4-digit login PIN.",
      rePrompt: "🔐 Please enter your *4-digit PIN* to continue.",
    });
  }

  // ── Deposit (NGN → USDT) ───────────────────────────────────────
  if (d.pendingDeposit) {
    return state({
      flow: "DEPOSIT",
      step: "ENTER_AMOUNT",
      expecting: "amount",
      describe:
        "In the DEPOSIT flow. Waiting for the amount in Nigerian Naira (NGN) the user wants to convert into USDT. Minimum ₦500, maximum ₦30,000,000.",
      rePrompt:
        "💰 Please enter the amount in NGN you want to deposit for your USDT wallet:",
    });
  }

  if (d.awaitingDepositPin) {
    return state({
      flow: "DEPOSIT",
      step: "ENTER_PIN",
      expecting: "pin",
      sealed: true,
      committed: true,
      pinContext: "DEPOSIT",
      describe:
        "In the DEPOSIT flow. The rate has been shown and we are waiting for the 4-digit PIN that authorises the deposit.",
      rePrompt: "🔐 Enter your *4-digit PIN* to confirm this deposit.",
    });
  }

  if (d.awaitingDepositConfirmation) {
    return state({
      flow: "DEPOSIT",
      step: "AWAITING_CONFIRMATION",
      expecting: "confirmation",
      committed: true,
      describe:
        "In the DEPOSIT flow, waiting for the user to confirm they have paid.",
      rePrompt: null,
    });
  }

  // ── Swap ───────────────────────────────────────────────────────
  if (d.swap?.step) {
    const from = d.swap.fromCoin;
    const limits = d.swap.fromCoinLimits;
    const map = {
      SELECT_FROM: {
        expecting: "selection",
        describe:
          "In the SWAP flow. A coin picker was sent — waiting for the user to choose the coin they are swapping FROM.",
        rePrompt:
          "🔄 Please tap the button above and pick the coin you want to swap *from*.",
      },
      SELECT_TO: {
        expecting: "selection",
        describe: `In the SWAP flow. Swapping from ${from || "a coin"} — waiting for the user to choose the coin they want to receive.`,
        rePrompt:
          "🔄 Please tap the button above and pick the coin you want to swap *to*.",
      },
      ENTER_AMOUNT: {
        expecting: "amount",
        describe: `In the SWAP flow. Waiting for how much ${from || "of the selected coin"} the user wants to swap${
          limits ? ` (min ${limits.minAmount}, max ${limits.maxAmount})` : ""
        }.`,
        rePrompt: `💰 Enter the amount of *${from || "the coin"}* you want to swap${
          limits ? `\n\nMin: ${limits.minAmount}\nMax: ${limits.maxAmount}` : ""
        }`,
      },
      AWAITING_SWAP_PIN: {
        expecting: "pin",
        sealed: true,
        committed: true,
        pinContext: "SWAP",
        describe:
          "In the SWAP flow. A quote has been shown and we are waiting for the PIN that executes the swap.",
        rePrompt: "🔐 Please enter your *PIN* to authorize this swap.",
      },
      COMPLETED: { expecting: null, describe: "The swap has completed." },
    };
    return state({
      flow: "SWAP",
      step: d.swap.step,
      ...(map[d.swap.step] || {}),
    });
  }

  // ── Send ───────────────────────────────────────────────────────
  if (d.send?.step) {
    const map = {
      SELECT_SEND_TYPE: {
        expecting: "selection",
        describe:
          "In the SEND flow. Waiting for the user to choose whether they are sending to another VIXA user or to an external wallet.",
        rePrompt: "Please tap above and choose who you're sending to.",
      },
      SELECT_COIN: {
        expecting: "selection",
        describe:
          "In the SEND flow. Waiting for the user to pick which coin to send.",
        rePrompt: "Please tap above and pick the coin you want to send.",
      },
      SELECT_CHAIN: {
        expecting: "selection",
        describe:
          "In the SEND flow. Waiting for the user to pick the network/chain.",
        rePrompt: "Please tap above and pick the network to send on.",
      },
      ENTER_AMOUNT: {
        expecting: "amount",
        describe: `In the SEND flow. Waiting for the amount of ${d.send.coin || "crypto"} to send.`,
        rePrompt: `💰 Enter the amount of *${d.send.coin || "crypto"}* you want to send:`,
      },
      ENTER_ADDRESS: {
        expecting: "address",
        describe:
          "In the SEND flow. Waiting for the destination blockchain wallet address.",
        rePrompt: "📩 Please paste the wallet address you're sending to:",
      },
      ENTER_TAG: {
        expecting: "tag",
        describe:
          "In the SEND flow. Waiting for the recipient's VIXA tag or phone number.",
        rePrompt: "👤 Please enter the recipient's VIXA tag or phone number:",
      },
      ENTER_PIN: {
        expecting: "pin",
        sealed: true,
        committed: true,
        pinContext: "SEND",
        describe:
          "In the SEND flow. Waiting for the PIN that releases the transfer.",
        rePrompt: "🔐 Enter your *4-digit PIN* to authorize this transfer.",
      },
    };
    return state({
      flow: "SEND",
      step: d.send.step,
      ...(map[d.send.step] || {}),
    });
  }

  // ── Withdraw ───────────────────────────────────────────────────
  if (d.withdraw?.step) {
    const map = {
      SELECT_WITHDRAW_REGION: {
        expecting: "selection",
        describe:
          "In the WITHDRAW flow. Waiting for the user to choose Nigeria or another country.",
        rePrompt: "📍 Please tap above and choose where you're withdrawing to.",
      },
      SELECT_WITHDRAW_TYPE: {
        expecting: "selection",
        describe:
          "In the WITHDRAW flow. Waiting for the user to choose the withdrawal method.",
        rePrompt: "Please tap above and choose your withdrawal method.",
      },
      SELECT_COUNTRY: {
        expecting: "selection",
        describe: "In the WITHDRAW flow. Waiting for a country selection.",
        rePrompt: "🌍 Please tap above and pick your country.",
      },
      SELECT_COIN: {
        expecting: "selection",
        describe: "In the WITHDRAW flow. Waiting for a coin selection.",
        rePrompt: "Please tap above and pick the coin you want to withdraw.",
      },
      SELECT_BANK: {
        expecting: "selection",
        describe: "In the WITHDRAW flow. Waiting for a bank selection.",
        rePrompt: "🏦 Please tap above and pick your bank.",
      },
      ENTER_AMOUNT: {
        expecting: "amount",
        describe:
          "In the WITHDRAW flow. Waiting for the amount of USDT the user wants to cash out.",
        rePrompt: "💰 Please enter the amount of *USDT* you want to withdraw:",
      },
      ENTER_ACCOUNT_NUMBER: {
        expecting: "account_number",
        describe:
          "In the WITHDRAW flow. Waiting for the 10-digit bank account number.",
        rePrompt: "🏦 Please enter your *10-digit account number*:",
      },
      ENTER_ACCOUNT_NUMBER_OTHER: {
        expecting: "account_number",
        describe:
          "In the WITHDRAW flow. Waiting for the destination account or mobile money number.",
        rePrompt: "🏦 Please enter the account / mobile money number:",
      },
      ENTER_ACCOUNT_NAME: {
        expecting: "account_name",
        describe:
          "In the WITHDRAW flow. Waiting for the account holder's full name.",
        rePrompt: "👤 Please enter the *account holder's full name*:",
      },
      AWAITING_QUOTE_CONFIRM: {
        expecting: "confirmation",
        committed: true,
        describe:
          "In the WITHDRAW flow. A quote has been shown and we are waiting for the user to accept or reject it.",
        rePrompt: "Please tap *Yes* or *No* above to continue.",
      },
      AWAITING_ACCOUNT_CONFIRM: {
        expecting: "confirmation",
        committed: true,
        describe:
          "In the WITHDRAW flow. Waiting for the user to confirm the resolved bank account name.",
        rePrompt: "Please confirm the account details above to continue.",
      },
      ENTER_QUOTE_PIN: {
        expecting: "pin",
        sealed: true,
        committed: true,
        pinContext: "WITHDRAW_QUOTE",
        describe:
          "In the WITHDRAW flow. Waiting for the PIN that locks in the quote.",
        rePrompt: "🔐 Enter your *4-digit PIN* to continue this withdrawal.",
      },
      ENTER_EXECUTE_PIN: {
        expecting: "pin",
        sealed: true,
        committed: true,
        pinContext: "WITHDRAW_EXECUTE",
        describe:
          "In the WITHDRAW flow. Waiting for the PIN that actually sends the money out.",
        rePrompt: "🔐 Enter your *4-digit PIN* to execute this withdrawal.",
      },
    };
    return state({
      flow: "WITHDRAW",
      step: d.withdraw.step,
      ...(map[d.withdraw.step] || {}),
    });
  }

  // ── Receive ────────────────────────────────────────────────────
  if (d.receive?.step) {
    const map = {
      SELECT_COIN: {
        expecting: "selection",
        describe:
          "In the RECEIVE flow. Waiting for the user to pick which coin they want a receiving address for.",
        rePrompt: "📥 Please tap above and pick the coin you want to receive.",
      },
      SELECT_CHAIN: {
        expecting: "selection",
        describe: "In the RECEIVE flow. Waiting for a network/chain selection.",
        rePrompt: "Please tap above and pick the network.",
      },
    };
    return state({
      flow: "RECEIVE",
      step: d.receive.step,
      ...(map[d.receive.step] || {}),
    });
  }

  // ── PIN change ─────────────────────────────────────────────────
  if (d.changePin?.step) {
    const map = {
      ENTER_CURRENT_PIN: {
        expecting: "pin",
        sealed: true,
        pinContext: "CHANGE_PIN_CURRENT",
        describe: "In the CHANGE PIN flow. Waiting for the current PIN.",
        rePrompt: "🔐 Enter your *current PIN* to begin the change:",
      },
      ENTER_OTP: {
        expecting: "otp",
        sealed: true,
        describe:
          "In the CHANGE PIN flow. An OTP was emailed; waiting for the user to type it. They can also type 'resend'.",
        rePrompt:
          "✉️ Please type the OTP sent to your email, or type *resend* for a new one.",
      },
      ENTER_NEW_PIN: {
        expecting: "pin",
        sealed: true,
        pinContext: "CHANGE_PIN_NEW",
        describe: "In the CHANGE PIN flow. Waiting for the new 4-digit PIN.",
        rePrompt: "🔐 Enter your *new 4-digit PIN*:",
      },
      ENTER_CONFIRM_PIN: {
        expecting: "pin",
        sealed: true,
        pinContext: "CHANGE_PIN_CONFIRM",
        describe: "In the CHANGE PIN flow. Waiting for the new PIN again.",
        rePrompt: "🔐 Re-enter your *new 4-digit PIN* to confirm:",
      },
    };
    return state({
      flow: "CHANGE_PIN",
      step: d.changePin.step,
      ...(map[d.changePin.step] || {}),
    });
  }

  // ── Lock / unlock ──────────────────────────────────────────────
  if (d.lockWallet?.step) {
    const map = {
      ENTER_REASON: {
        expecting: "text",
        describe:
          "In the LOCK WALLET flow. Waiting for the user's free-text reason for locking. Treat almost anything they type here as the reason.",
        rePrompt:
          "🔒 Please tell us why you want to lock your wallet (e.g. lost phone, suspicious activity):",
      },
      ENTER_PIN: {
        expecting: "pin",
        sealed: true,
        committed: true,
        pinContext: "LOCK_WALLET",
        describe: "In the LOCK WALLET flow. Waiting for the confirming PIN.",
        rePrompt: "🔐 Enter your *4-digit PIN* to lock your wallet.",
      },
    };
    return state({
      flow: "LOCK_WALLET",
      step: d.lockWallet.step,
      ...(map[d.lockWallet.step] || {}),
    });
  }

  if (d.unlockWallet?.step) {
    const map = {
      ENTER_OTP: {
        expecting: "otp",
        sealed: true,
        describe:
          "In the UNLOCK WALLET flow. An OTP was emailed; waiting for the user to type it.",
        rePrompt: "✉️ Please type the OTP sent to your email:",
      },
      ENTER_PIN: {
        expecting: "pin",
        sealed: true,
        committed: true,
        pinContext: "UNLOCK_WALLET",
        describe: "In the UNLOCK WALLET flow. Waiting for the confirming PIN.",
        rePrompt: "🔐 Enter your *4-digit PIN* to unlock your wallet.",
      },
    };
    return state({
      flow: "UNLOCK_WALLET",
      step: d.unlockWallet.step,
      ...(map[d.unlockWallet.step] || {}),
    });
  }

  return { ...UNKNOWN_STATE };
}

/** Wipe every in-progress flow. One list, so no flow is ever left half-set. */
export function clearedFlowState(sessionData) {
  return {
    ...(sessionData || {}),
    pendingDeposit: false,
    awaitingDepositPin: false,
    awaitingDepositConfirmation: false,
    depositAmount: null,
    swap: null,
    send: null,
    withdraw: null,
    receive: null,
    lockWallet: null,
    unlockWallet: null,
    changePin: null,
    pendingSwitch: null,
    pendingVoiceAmount: null,
  };
}

/**
 * Steps where a voice note must be refused.
 *
 *   pin / otp      — sealed. resolveIntent guarantees these never reach
 *                    OpenAI; transcribing first would break that guarantee
 *                    before the router ever runs.
 *   address / tag  — one wrong character sends funds nowhere, permanently.
 *   account_number — "8"/"H" and "5"/"9" are the classic confusions.
 *   account_name   — sits in FREE_TEXT_EXPECTATIONS, so it is passed through
 *                    unvalidated and handed straight to executeWithdrawal.
 *
 * Keyed on `expecting`, not step name, so new steps inherit the policy.
 */
export const VOICE_BLOCKED_EXPECTATIONS = new Set([
  "pin",
  "otp",
  "address",
  "tag",
  "account_number",
  "account_name",
]);

export function voiceAllowed(state) {
  if (!state) return true;
  if (state.sealed) return false;
  return !VOICE_BLOCKED_EXPECTATIONS.has(state.expecting);
}
