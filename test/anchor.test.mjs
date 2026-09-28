// What makes an on-chain stamp prove a record, and what does not.
//
// An anchor proves a record when three things hold, all read from the chain:
// the transaction succeeded, the TREASURY signed it (pinned in this tool, never
// named by the API), and it carries exactly the memo the recomputed record
// implies. Each test below breaks one of those and expects the verdict to
// notice, including the cases an earlier version let through: a signer the API
// chose, a memo checked only by its trailing hash, a record for some other
// claim or day, and a lock "ran" because a log line said the word.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimsMemo,
  decisionMemo,
  strategyMemo,
  monthlyMemo,
  hashLeaf,
  buildRoot,
  sha256,
  canonicalStringify,
  decisionPayload,
} from "../src/canonical.js";
import { programInstructions, memosFromTx, getOwnerBalances } from "../src/io.js";
import { verifyAllocation, verifyClaim, verifyLiquidity, exitCodeFor, VERDICT } from "../src/verify.js";
import { TREASURY, DAMM_V2_PROGRAM } from "../src/pinned.js";

// Real anchors, read from mainnet on 2026-09-28 together with the fields
// vaultbags.app published for them. The memo is what the chain carries.
const REAL = {
  "claims": {
    "period": "2026-09-26",
    "count": 4,
    "root": "a78cfe328b3c87a2900bb5458fe01f3ff6ff53ecf6441d6a3b00fc1aac3ab17b",
    "memo": "vaultbags:claims:v1:2026-09-26:4:a78cfe328b3c87a2900bb5458fe01f3ff6ff53ecf6441d6a3b00fc1aac3ab17b"
  },
  "decision": {
    "date": "2026-09-27",
    "weights": {
      "gold": 31,
      "spyx": 34,
      "usdy": 35
    },
    "hash": "b512b97a060ef2d08c316d56e7bccefe1cf606d237b653efb27d8e7aec7e4484",
    "memo": "vaultbags:alloc:v1:2026-09-27:g31s34u35:b512b97a060ef2d08c316d56e7bccefe1cf606d237b653efb27d8e7aec7e4484"
  },
  "strategy": {
    "date": "2026-09-27",
    "strategyKey": "ee282e94dab2856df2d10660d7a92850dcf7d893ed6e949db652ee241f1df477",
    "hash": "fd576f4e990d9b5841ddb648e9231bf48a66fb4cfd2dfff4d24c09eda09725dc",
    "memo": "vaultbags:strategy:v1:2026-09-27:ee282e94dab2856df2d10660d7a92850dcf7d893ed6e949db652ee241f1df477:fd576f4e990d9b5841ddb648e9231bf48a66fb4cfd2dfff4d24c09eda09725dc"
  },
  "monthly": {
    "period": "2026-08-01",
    "hash": "6bc3d7afc7c2a9145c39b9426c0080b8ff283ea788b0c5c71f531698ae092d1c",
    "memo": "vaultbags:monthly:v1:2026-08-01:6bc3d7afc7c2a9145c39b9426c0080b8ff283ea788b0c5c71f531698ae092d1c"
  }
};

const OPTS = { version: "0.0.0" };
const realFetch = global.fetch;
const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// A fabricated program id and wallet, shaped like base58 so the log parser
// treats them as programs. They are not addresses of anything.
const FAKE_PROGRAM = "Fake" + "1".repeat(40);
const OTHER_SIGNER = "signer:someone-else";

function txResult({ signers = [TREASURY], memos = [], innerMemos = [], err = null, logs = [] } = {}) {
  return {
    slot: 1,
    meta: {
      err,
      logMessages: logs,
      innerInstructions: innerMemos.length
        ? [{ index: 0, instructions: innerMemos.map((m) => ({ program: "spl-memo", parsed: m })) }]
        : [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: {
      message: {
        accountKeys: signers.map((pubkey) => ({ pubkey, signer: true })),
        instructions: memos.map((m) => ({ program: "spl-memo", parsed: m })),
      },
    },
  };
}

// API routes are matched in order, so a longer path goes first. Every RPC call
// is a POST and is answered by `rpc(method, params)`.
function install(api, rpc) {
  global.fetch = async (url, init) => {
    if (init?.method === "POST") {
      const { method, params } = JSON.parse(init.body);
      return json({ jsonrpc: "2.0", id: 1, ...rpc(method, params) });
    }
    const u = String(url);
    for (const [match, body] of api) if (u.includes(match)) return json(body);
    return json({ error: "not found" });
  };
}
const restore = () => {
  global.fetch = realFetch;
};

// ---------------------------------------------------------------------------

test("each memo builder reproduces a real anchor character for character", () => {
  assert.equal(claimsMemo(REAL.claims), REAL.claims.memo);
  assert.equal(decisionMemo(REAL.decision), REAL.decision.memo);
  assert.equal(strategyMemo(REAL.strategy), REAL.strategy.memo);
  assert.equal(monthlyMemo(REAL.monthly), REAL.monthly.memo);
});

test("every memo in a transaction is read, top level and inner", () => {
  const tx = txResult({ memos: ["first", "second"], innerMemos: ["inner"] });
  assert.deepEqual(memosFromTx(tx), ["first", "second", "inner"]);
});

// --- decisions --------------------------------------------------------------

const decision = () => {
  const d = {
    date: "2026-09-27",
    weights: { gold: 31, spyx: 34, usdy: 35 },
    payload: { signals: { sample: 1 } },
    stamped: true,
    receiptTx: "tx:decision",
    expectedSigner: TREASURY,
  };
  d.storedHash = sha256(canonicalStringify(decisionPayload(d)));
  return d;
};
const decisionMemoFor = (d) => decisionMemo({ date: d.date, weights: d.weights, hash: d.storedHash });

async function runDecision(d, chain, date = d.date) {
  install([["/api/proof/decision/", d]], (method) => ({ result: method === "getTransaction" ? chain : null }));
  try {
    return await verifyAllocation(date, OPTS);
  } finally {
    restore();
  }
}

test("decision: the exact memo, signed by the treasury, verifies", async () => {
  const d = decision();
  const r = await runDecision(d, txResult({ memos: [decisionMemoFor(d)] }));
  assert.equal(r.verdict, VERDICT.VERIFIED);
});

test("decision: the signer comes from this tool, not from the API", async () => {
  const d = decision();
  // No expectedSigner published: still fully checked, against the pinned one.
  const quiet = { ...d, expectedSigner: undefined };
  assert.equal((await runDecision(quiet, txResult({ memos: [decisionMemoFor(d)] }))).verdict, VERDICT.VERIFIED);
  // The API naming its own signer, with a matching stamp from that signer:
  // the case a dishonest endpoint would build. It must fail.
  const named = { ...d, expectedSigner: OTHER_SIGNER };
  const r = await runDecision(named, txResult({ signers: [OTHER_SIGNER], memos: [decisionMemoFor(d)] }));
  assert.equal(r.verdict, VERDICT.FAILED);
});

test("decision: a stamp from any other wallet fails", async () => {
  const d = decision();
  const r = await runDecision(d, txResult({ signers: [OTHER_SIGNER], memos: [decisionMemoFor(d)] }));
  assert.equal(r.verdict, VERDICT.FAILED);
});

test("decision: the right hash under other weights is a different statement", async () => {
  const d = decision();
  const wrong = decisionMemo({ date: d.date, weights: { gold: 43, spyx: 34, usdy: 23 }, hash: d.storedHash });
  assert.equal((await runDecision(d, txResult({ memos: [wrong] }))).verdict, VERDICT.FAILED);
});

test("decision: the expected memo among others is found; absent, it fails", async () => {
  const d = decision();
  assert.equal((await runDecision(d, txResult({ memos: ["noise", decisionMemoFor(d)] }))).verdict, VERDICT.VERIFIED);
  assert.equal((await runDecision(d, txResult({ memos: ["noise"] }))).verdict, VERDICT.FAILED);
});

test("decision: another day's decision is not an answer", async () => {
  const d = decision();
  const r = await runDecision(d, txResult({ memos: [decisionMemoFor(d)] }), "2026-09-26");
  assert.equal(r.verdict, VERDICT.FAILED);
});

test("decision: a reverted stamp fails; a missing one is unresolved", async () => {
  const d = decision();
  assert.equal((await runDecision(d, txResult({ memos: [decisionMemoFor(d)], err: { x: 1 } }))).verdict, VERDICT.FAILED);
  assert.equal((await runDecision(d, null)).verdict, VERDICT.UNRESOLVED);
});

// --- claims -----------------------------------------------------------------

const leafA = { wallet: "w:a", tokenMint: "m:x", gold: "1.5", spyx: "0", usdy: "0", tx: "tx:a" };
const leafB = { wallet: "w:b", tokenMint: "m:x", gold: "0", spyx: "2", usdy: "0", tx: "tx:b" };
const PERIOD = "2026-09-26";
const ROOT = buildRoot([leafA, leafB]);

async function runClaim(asked, { leaf = leafA, memo = claimsMemo({ period: PERIOD, count: 2, root: ROOT }) } = {}) {
  const claim = {
    period: PERIOD,
    leaf,
    proof: [{ side: "right", hash: hashLeaf(leafB) }],
    root: ROOT,
    stamped: true,
    receiptTx: "tx:day",
    expectedSigner: TREASURY,
  };
  install(
    [
      ["/api/proof/claims/", { period: PERIOD, leaves: [leafA, leafB], root: ROOT }],
      ["/api/proof/claim/", claim],
    ],
    (method) => ({ result: method === "getTransaction" ? txResult({ memos: [memo] }) : null })
  );
  try {
    return await verifyClaim(asked, OPTS);
  } finally {
    restore();
  }
}

test("claim: the proof, the rebuilt day and the exact memo verify", async () => {
  const r = await runClaim("tx:a");
  assert.equal(r.verdict, VERDICT.VERIFIED, JSON.stringify(r.checks));
  assert.ok(r.checks.some((c) => /one of that day's published claims/.test(c.label) && c.state === "ok"));
});

test("claim: a valid proof for some OTHER payout is not an answer", async () => {
  // Every other check would pass: the proof is real, just not for this tx.
  const r = await runClaim("tx:c");
  assert.equal(r.verdict, VERDICT.FAILED);
  assert.match(r.checks[0].label, /the claim asked about/);
});

test("claim: the right root stamped with another count or day fails", async () => {
  assert.equal((await runClaim("tx:a", { memo: claimsMemo({ period: PERIOD, count: 3, root: ROOT }) })).verdict, VERDICT.FAILED);
  assert.equal(
    (await runClaim("tx:a", { memo: claimsMemo({ period: "2026-09-25", count: 2, root: ROOT }) })).verdict,
    VERDICT.FAILED
  );
});

test("claim: a malformed record fails as a check, not as a crash", async () => {
  const r = await runClaim("tx:a", { leaf: { ...leafA, gold: "one" } });
  assert.equal(r.verdict, VERDICT.FAILED);
});

// --- liquidity locks --------------------------------------------------------

const lockLogs = (program, extra = []) => [
  `Program ${program} invoke [1]`,
  "Program log: Instruction: PermanentLockPosition",
  ...extra,
  `Program ${program} consumed 1 of 2 compute units`,
  `Program ${program} success`,
];

test("the pool program's own log line is the only one that counts", () => {
  assert.deepEqual(programInstructions(lockLogs(DAMM_V2_PROGRAM), DAMM_V2_PROGRAM).names, ["PermanentLockPosition"]);
  // Any other program can print the same words.
  assert.deepEqual(programInstructions(lockLogs(FAKE_PROGRAM), DAMM_V2_PROGRAM).names, []);
  // A memo carrying the words is a memo.
  const memoEcho = [
    `Program ${FAKE_PROGRAM} invoke [1]`,
    'Program log: Memo (len 36): "Instruction: PermanentLockPosition"',
    `Program ${FAKE_PROGRAM} success`,
  ];
  assert.deepEqual(programInstructions(memoEcho, DAMM_V2_PROGRAM).names, []);
  // The pool program calling itself (how it emits events) keeps it on top.
  const nested = [
    `Program ${DAMM_V2_PROGRAM} invoke [1]`,
    "Program log: Instruction: PermanentLockPosition",
    `Program ${DAMM_V2_PROGRAM} invoke [2]`,
    `Program ${DAMM_V2_PROGRAM} success`,
    `Program ${DAMM_V2_PROGRAM} success`,
  ];
  const n = programInstructions(nested, DAMM_V2_PROGRAM);
  assert.deepEqual(n.names, ["PermanentLockPosition"]);
  assert.equal(n.readable, true);
});

test("a cut or unbalanced log is unreadable, never a 'did not run'", () => {
  assert.equal(programInstructions([`Program ${DAMM_V2_PROGRAM} invoke [1]`, "Log truncated"], DAMM_V2_PROGRAM).readable, false);
  assert.equal(programInstructions([`Program ${DAMM_V2_PROGRAM} invoke [1]`], DAMM_V2_PROGRAM).readable, false);
});

async function runLiquidity(logs) {
  const record = {
    available: true,
    wallet: "wallet:lp",
    complete: true,
    lock: { allLocked: true, unlockedLiquidity: "0" },
    deposits: [{ addTx: "add0", lockTx: "lock0" }],
  };
  install([["/api/liquidity", record]], (method, params) => {
    if (method === "getSignatureStatuses") return { result: { value: params[0].map(() => ({ err: null })) } };
    if (method === "getTransaction") return { result: txResult({ signers: ["wallet:lp"], logs }) };
    return { result: null };
  });
  try {
    return await verifyLiquidity(OPTS);
  } finally {
    restore();
  }
}

test("liquidity: a lock the pool program ran is as far as public data goes", async () => {
  assert.equal((await runLiquidity(lockLogs(DAMM_V2_PROGRAM))).verdict, VERDICT.PARTIAL);
});

test("liquidity: the words printed by another program are not a lock", async () => {
  assert.equal((await runLiquidity(lockLogs(FAKE_PROGRAM))).verdict, VERDICT.FAILED);
});

test("liquidity: a cut log leaves it unresolved, not failed", async () => {
  assert.equal((await runLiquidity([`Program ${DAMM_V2_PROGRAM} invoke [1]`, "Log truncated"])).verdict, VERDICT.UNRESOLVED);
});

// --- reserves unit ------------------------------------------------------------

test("a balance is compared in stored units, with the wallet display kept beside it", async () => {
  // Shaped like the asset with a display multiplier: 91044 stored, 0.00091564
  // displayed. vaultbags.app publishes the stored figure, so that is the one
  // compared; the display is only reported.
  const account = (amount, ui) => ({
    account: { data: { parsed: { info: { mint: "mint:s", tokenAmount: { amount, decimals: 8, uiAmountString: ui } } } } },
  });
  global.fetch = async () => json({ jsonrpc: "2.0", id: 1, result: { value: [account("91044", "0.00091564")] } });
  try {
    const { totals } = await getOwnerBalances("owner:x", "program:x");
    const held = totals.get("mint:s");
    assert.equal(held.raw, 91044n);
    assert.equal(held.display, 91564n);
  } finally {
    restore();
  }
  // An account whose stored amount is not a plain integer refuses the read
  // instead of being skipped, which would understate the holder.
  global.fetch = async () => json({ jsonrpc: "2.0", id: 1, result: { value: [account("9.1", "0.1")] } });
  try {
    const r = await getOwnerBalances("owner:x", "program:x");
    assert.equal(r.totals, undefined);
  } finally {
    restore();
  }
});

// --- exit codes -------------------------------------------------------------

test("only a verified result exits 0", () => {
  assert.equal(exitCodeFor(VERDICT.VERIFIED), 0);
  assert.equal(exitCodeFor(VERDICT.FAILED), 1);
  for (const v of [VERDICT.NO_ANCHOR, VERDICT.PARTIAL, VERDICT.UNRESOLVED]) assert.equal(exitCodeFor(v), 3, v);
});
