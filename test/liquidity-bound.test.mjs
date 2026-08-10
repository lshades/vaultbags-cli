// How much work a remote answer can ask of your node.
//
// `verify liquidity` reads a transaction for every lock the record names, so the
// side being checked is the side that decides how much your machine does. That
// is fine when the record is honest and about a hundred and fifty entries long.
// It is not fine as an open-ended promise: a compromised or hostile endpoint
// could name a hundred thousand and turn a verification into a long, quiet
// hammering of whichever node you pointed the tool at.
//
// So there is a ceiling, and the interesting part is what happens at it. It does
// NOT trim the list and check what fits: a partial pass over a record that size
// would print like a full one, and the entry left out is exactly the entry a
// forger would choose. It stops and says the record is larger than it will read.
//
// This test proves both halves: the refusal happens, and no node is touched on
// the way to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyLiquidity, VERDICT } from "../src/verify.js";

const realFetch = global.fetch;

function stubApi(depositCount) {
  const rpcCalls = [];
  const deposits = Array.from({ length: depositCount }, (_, i) => ({
    addTx: `add${i}`,
    lockTx: `lock${i}`,
  }));

  global.fetch = async (url, init) => {
    const u = String(url);
    // Anything that is not the record read is a node call, which is the thing
    // that must not happen once the ceiling is hit.
    if (init?.method === "POST") {
      rpcCalls.push(u);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        available: true,
        wallet: "TestWa11etAddressForVerificationOnly1111111",
        complete: true,
        deposits,
        claims: [],
        totals: { deposits: deposits.length },
        lock: { allLocked: true, unlockedLiquidity: "0" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  return rpcCalls;
}

test("an oversized record is refused, not trimmed to fit", async () => {
  const rpcCalls = stubApi(100000);
  try {
    const result = await verifyLiquidity({ version: "0.0.0" });
    assert.equal(result.verdict, VERDICT.UNRESOLVED);
    assert.match(result.checks[0].label, /more than this command will read/);
    assert.equal(rpcCalls.length, 0, "it reached for a node before deciding it would not read the record");
  } finally {
    global.fetch = realFetch;
  }
});

test("a record of ordinary size is not refused by the ceiling", async () => {
  // The real record is around 150 transactions. This is well inside, so the
  // ceiling must be invisible here: whatever verdict comes back, it is not the
  // refusal above.
  const rpcCalls = stubApi(60);
  try {
    const result = await verifyLiquidity({ version: "0.0.0" });
    assert.notEqual(
      result.checks[0].label.includes("more than this command will read"),
      true,
      "the ceiling fired on a record it should never see"
    );
    assert.ok(rpcCalls.length > 0, "it never asked a node anything");
  } finally {
    global.fetch = realFetch;
  }
});
