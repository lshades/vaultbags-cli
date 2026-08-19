// v2 leaf spec (generalized ledger): era by row shape, asset-order
// independence, malformed/duplicate rejection, v1/v2 domain separation.
// Mirrors the checks the app's own merkle sim runs, so the two copies of the
// spec cannot drift apart without one suite going red.
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalAssets, canonicalLeaf, hashLeaf, strategyPayload, canonicalStringify, sha256 } from "../src/canonical.js";

const M1 = "1".repeat(32);
const M2 = "2".repeat(32);
const base = {
  wallet: "W".repeat(32),
  tokenMint: "T".repeat(32),
  tx: "TX1" + "a".repeat(29),
};

test("v2 leaf: assets sorted by mint, amounts canonicalized, v2 tag", () => {
  const leaf = { ...base, assets: [{ mint: M2, amount: "5.500" }, { mint: M1, amount: "0100" }] };
  const s = canonicalLeaf(leaf);
  assert.ok(s.startsWith("v2|"));
  assert.ok(s.includes(`a:${M1}=100,${M2}=5.5`));
});

test("v2 leaf: independent of asset input order", () => {
  const a = { ...base, assets: [{ mint: M2, amount: "5.5" }, { mint: M1, amount: "100" }] };
  const b = { ...base, assets: [{ mint: M1, amount: "100" }, { mint: M2, amount: "5.5" }] };
  assert.equal(hashLeaf(a), hashLeaf(b));
});

test("canonicalAssets rejects empty, malformed mint, duplicate mint, junk amount", () => {
  assert.throws(() => canonicalAssets([]));
  assert.throws(() => canonicalAssets([{ mint: "not-base58!", amount: "1" }]));
  assert.throws(() => canonicalAssets([{ mint: M1, amount: "1" }, { mint: M1, amount: "2" }]));
  assert.throws(() => canonicalAssets([{ mint: M1, amount: "1e9" }]));
});

test("v1 and v2 leaves live in different hash spaces", () => {
  const v1 = { ...base, gold: "100", spyx: "5.5", usdy: "0" };
  const v2 = { ...base, assets: [{ mint: M1, amount: "100" }, { mint: M2, amount: "5.5" }] };
  assert.notEqual(hashLeaf(v1), hashLeaf(v2));
});

test("v1 leaf stays byte-identical (no assets key = old path)", () => {
  const v1 = { ...base, gold: "0100", spyx: "5.500", usdy: "0" };
  assert.equal(
    canonicalLeaf(v1),
    `v1|w:${base.wallet}|m:${base.tokenMint}|g:100|s:5.5|u:0|t:${base.tx}`
  );
});

// Cross-implementation vector: this hash was produced by the app's own
// receiptCore (strategyReceiptPayload + receiptHash) over this exact fixture,
// so the two copies of the strategy-receipt spec cannot drift without this
// test going red.
test("strategy payload hashes to the app's reference vector", () => {
  const d = {
    date: "2026-08-20",
    strategyKey: "ab".repeat(32),
    selection: [
      { mint: "1".repeat(32), base: 60 },
      { mint: "2".repeat(32), base: 40 },
    ],
    weights: { ["1".repeat(32)]: 55, ["2".repeat(32)]: 45 },
    convictions: { ["1".repeat(32)]: 0.25, ["2".repeat(32)]: -0.25 },
  };
  assert.equal(
    sha256(canonicalStringify(strategyPayload(d))),
    "c7f06f664b03e61acad2b46e88174afae26ec86a174c85a0f78b840ab22f1a61"
  );
});
