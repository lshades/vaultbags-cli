// How much work a remote answer can ask of your machine.
//
// Every verify command is handed a list by the side being checked and then does
// a piece of work per entry: a balance read per wallet, a status lookup per
// signature, a round trip per transaction, a hash per leaf. That shape is right
// for a verifier, and it means the list decides the workload. Honest lists are
// small. As an open-ended promise it is something else: a compromised endpoint
// could answer with a hundred thousand entries and turn a verification into a
// long, quiet hammering of whichever node you pointed the tool at, on your
// bandwidth and your rate limit.
//
// The interesting part is not that a ceiling exists but what happens at it. It
// does NOT trim the list and check what fits: a partial pass prints exactly
// like a full one, and the entry left out is the one a forger would choose. It
// stops and says the answer was bigger than it will read.
//
// Each test below proves both halves for one command: the refusal happens, and
// no node is touched on the way to it. The last one proves the ceilings stay
// invisible at real sizes, which is what stops them being a regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyLiquidity, verifyReserves, verifyPayouts, VERDICT } from "../src/verify.js";

const realFetch = global.fetch;
const OPTS = { version: "0.0.0" };
const REFUSAL = /more than this command will read/;

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// Counts anything that is not the API read. Every RPC call in this tool is a
// POST, so a POST reaching the stub means a node was contacted.
function install(routes) {
  const rpcCalls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST") {
      rpcCalls.push(u);
      return json({ jsonrpc: "2.0", id: 1, result: { value: [] } });
    }
    for (const [match, body] of routes) {
      if (u.includes(match)) return json(body);
    }
    return json({});
  };
  return rpcCalls;
}

const liquidityRecord = (n) => ({
  available: true,
  wallet: "TestWa11etAddressForVerificationOnly1111111",
  complete: true,
  lock: { allLocked: true, unlockedLiquidity: "0" },
  claims: [],
  totals: { deposits: n },
  deposits: Array.from({ length: n }, (_, i) => ({ addTx: `add${i}`, lockTx: `lock${i}` })),
});

const reservesAnswer = (n) => ({
  reserves: [{ mint: "So11111111111111111111111111111111111111112", symbol: "X", valueUsd: 1 }],
  custody: {
    vault: {
      reservePools: Array.from({ length: n }, (_, i) => ({ address: `wallet${i}`, role: "reserve" })),
    },
  },
});

const claimsDay = (n) => ({
  period: "2026-08-09",
  leaves: Array.from({ length: n }, (_, i) => ({ tx: `sig${i}`, wallet: `w${i}` })),
});

test("liquidity: an oversized record is refused, not trimmed to fit", async () => {
  const rpc = install([["/api/liquidity", liquidityRecord(100000)]]);
  try {
    const r = await verifyLiquidity(OPTS);
    assert.equal(r.verdict, VERDICT.UNRESOLVED);
    assert.match(r.checks[0].label, REFUSAL);
    assert.equal(rpc.length, 0, "it reached for a node before deciding it would not read the record");
  } finally {
    global.fetch = realFetch;
  }
});

test("reserves: a custody map naming too many wallets is refused", async () => {
  const rpc = install([["/api/agent/proof-of-reserves", reservesAnswer(50000)]]);
  try {
    const r = await verifyReserves(OPTS);
    assert.equal(r.verdict, VERDICT.UNRESOLVED);
    assert.match(r.checks[0].label, REFUSAL);
    assert.equal(rpc.length, 0, "it started reading balances before checking how many there were");
  } finally {
    global.fetch = realFetch;
  }
});

test("payouts: a day naming too many claims is refused", async () => {
  const rpc = install([
    ["/api/proof/claims/", claimsDay(200000)],
    ["/api/proof/claims", { roots: [{ period: "2026-08-09" }] }],
  ]);
  try {
    const r = await verifyPayouts(null, OPTS);
    assert.equal(r.verdict, VERDICT.UNRESOLVED);
    assert.match(r.checks[0].label, REFUSAL);
    assert.equal(rpc.length, 0, "it asked a node for statuses before checking how many it had been given");
  } finally {
    global.fetch = realFetch;
  }
});

test("at real sizes the ceilings are invisible", async () => {
  // The live record is about 150 transactions, custody about a dozen wallets, a
  // day a handful of claims. None of these may trip a ceiling, or the fix would
  // have broken the thing it was protecting.
  const cases = [
    ["liquidity", () => install([["/api/liquidity", liquidityRecord(60)]]), () => verifyLiquidity(OPTS)],
    ["reserves", () => install([["/api/agent/proof-of-reserves", reservesAnswer(12)]]), () => verifyReserves(OPTS)],
    [
      "payouts",
      () =>
        install([
          ["/api/proof/claims/", claimsDay(40)],
          ["/api/proof/claims", { roots: [{ period: "2026-08-09" }] }],
        ]),
      () => verifyPayouts(null, OPTS),
    ],
  ];

  for (const [name, setup, run] of cases) {
    const rpc = setup();
    try {
      const r = await run();
      assert.ok(
        !r.checks.some((c) => REFUSAL.test(c.label)),
        `${name}: a ceiling fired on an answer of ordinary size`
      );
      assert.ok(rpc.length > 0, `${name}: it never asked a node anything`);
    } finally {
      global.fetch = realFetch;
    }
  }
});
