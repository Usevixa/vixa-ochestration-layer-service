/**
 * Two users, one server, overlapping messages: each user's API calls must
 * carry that user's own token.
 *
 * The balance check makes two API calls in a row (/auth/me, then
 * /wallet/get-balances). The fake API below holds user A's /auth/me open
 * while user B's whole balance check runs. With a shared, module-level token,
 * A's second call went out with B's token — and A was shown B's balance.
 *
 * Same rule as webhook.integration.mjs: imports are DYNAMIC and come after
 * the env is rewritten, so nothing can reach production.
 */
import http from "node:http";

process.env.WHATSAPP_TOKEN = "";
delete process.env.WHATSAPP_TOKEN;
process.env.OPENAI_API_KEY = "";

const TOKENS = {
  "+2348000000001": { token: "token-user-A", name: "Ada", balance: "111" },
  "+2348000000002": { token: "token-user-B", name: "Bola", balance: "222" },
};
const byToken = Object.fromEntries(
  Object.values(TOKENS).map((u) => [u.token, u]),
);

// ── Fake VIXA API ────────────────────────────────────────────────
const apiCalls = [];
let releaseA;
const aIsWaiting = new Promise((r) => (releaseA = r));
let aArrived;
const aHasArrived = new Promise((r) => (aArrived = r));

const api = http.createServer(async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const path = req.url.split("?")[0].replace("/api/v1", "");
  apiCalls.push({ path, token });
  const user = byToken[token];

  if (path === "/auth/me" && token === TOKENS["+2348000000001"].token) {
    aArrived();
    await aIsWaiting; // hold A here until B is completely done
  }

  res.setHeader("Content-Type", "application/json");
  if (!user) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ message: "bad token" }));
  }
  if (path === "/auth/me") {
    return res.end(JSON.stringify({ firstName: user.name }));
  }
  if (path === "/wallet/get-balances") {
    return res.end(
      JSON.stringify({
        success: true,
        data: {
          coins: [
            {
              coin: "USDT",
              decimals: 6,
              total: user.balance,
              pending: "0",
              available: user.balance,
              networks: [
                { network: "solana", total: user.balance, pending: "0", available: user.balance },
              ],
            },
          ],
          asOf: new Date().toISOString(),
        },
      }),
    );
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => api.listen(0, r));
process.env.VIXA_API_BASE = `http://127.0.0.1:${api.address().port}/api/v1`;

const express = (await import("express")).default;
const router = (await import("../src/routes/webhook.js")).default;
const { updateSession } = await import("../src/services/session.service.js");

if (process.env.WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN still set!");

// ── Capture what the bot sends, per recipient ────────────────────
const sentTo = {};
const errors = [];
const realLog = console.log;
console.log = (...a) => {
  if (String(a[0]).startsWith("[MOCK send]")) {
    (sentTo[a[1]] ||= []).push(String(a[2]));
  }
};
console.error = (...a) => errors.push(a.map(String).join(" "));

const app = express();
app.use(express.json());
app.use("/", router);
const server = app.listen(0);
const port = server.address().port;

async function seed(phone) {
  await updateSession(phone, {
    data: {
      authenticated: true,
      firstName: TOKENS[phone].name,
      phone_number_id: "TEST_PNID",
      token: TOKENS[phone].token,
      tokenExpiresAt: Date.now() + 3_600_000,
    },
  });
}

function post(phone, text) {
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "TEST_PNID" },
                messages: [
                  {
                    from: phone.replace("+", ""),
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
    }),
  });
}

async function waitFor(cond, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const A = "+2348000000001";
const B = "+2348000000002";
const balanceMsg = (phone) =>
  (sentTo[phone] || []).find((m) => m.includes("Your Wallet Balances"));

await seed(A);
await seed(B);

// 1. A asks for a balance; the fake API parks A on /auth/me.
await post(A, "check my balance");
await aHasArrived;

// 2. B's whole balance check runs while A is parked.
await post(B, "check my balance");
const bDone = await waitFor(() => balanceMsg(B));

// 3. Let A continue — its NEXT call is the one the old code got wrong.
releaseA();
const aDone = await waitFor(() => balanceMsg(A));

// ── Assertions ───────────────────────────────────────────────────
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

check("B's balance check finished while A was waiting", bDone);
check("A's balance check finished", aDone);

for (const [phone, u] of Object.entries(TOKENS)) {
  const mine = apiCalls.filter((c) => c.token === u.token).map((c) => c.path);
  check(
    `${u.name}'s token used for exactly /auth/me + /wallet/get-balances`,
    mine.length === 2 &&
      mine.includes("/auth/me") &&
      mine.includes("/wallet/get-balances"),
    JSON.stringify(mine),
  );
  const msg = balanceMsg(phone) || "";
  check(
    `${u.name} was shown their own name and balance`,
    msg.includes(`Hi ${u.name}`) && msg.includes(`USDT: ${u.balance}`),
    JSON.stringify(msg.split("\n").slice(0, 4).join(" | ")),
  );
}

check(
  "no API call went out with a missing or unknown token",
  apiCalls.every((c) => byToken[c.token]),
  JSON.stringify(apiCalls),
);
check(
  "no 'outside a user context' errors",
  !errors.some((e) => e.includes("outside a user context")),
  errors.filter((e) => e.includes("context")).join(" / "),
);
check(
  "webhook handler did not throw",
  !errors.some((e) => e.includes("Error processing webhook")),
  errors.join(" / "),
);

console.log = realLog;
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n   ${r.detail}`}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);

server.close();
api.close();
process.exit(failed ? 1 : 0);
