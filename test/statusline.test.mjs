// The status line: one line from the cache, never a guess.
//
// What these hold: the line is built from the cache alone; a figure that was
// not read is left out, never printed as zero; amounts are in real units
// (grams of gold, SPY shares by the mint's multiplier); today's buy is shown
// only on its own day; an old cache says when it was read; a refresh reads a
// wallet at most every fifteen minutes, waits the same after a failed read
// and backs off for an hour after a refusal; a part that could not be read
// keeps what the cache had; a preview that cannot answer is unread; the cache
// on disk keeps a hash of the address, in a folder of the user's own, and a
// refresh removes only its own lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  statusLineText,
  dueParts,
  refreshCache,
  nextRun,
  isWalletAddress,
  cacheKey,
  claimableText,
  walletId,
  VAULT_TTL_MS,
  WALLET_TTL_MS,
  WALLET_BACKOFF_MS,
} from "../src/statusline.js";

// Synthetic address, the right shape, not a real wallet.
const W = "TestWa11etAddressForStatusLine1111111111111";
const DAY = "2026-10-29";
const NOW = Date.parse(`${DAY}T12:07:30Z`);
const MULT = 1.005714560286254;

const vault = (over = {}) => ({
  at: NOW - 60_000,
  totalUsd: 1208.28,
  allPriced: true,
  weights: { gold: 30, spyx: 35, usdy: 35 },
  weightsDate: DAY,
  queue: { sol: 0.0134, thresholdSol: 0.03 },
  refs: { spyxSharesPerToken: MULT },
  ...over,
});
const mine = (preview, over = {}) => ({ id: walletId(W), at: NOW - 60_000, preview: { totalUsd: 1.23, ...preview }, ...over });

test("the line from a full cache", () => {
  const line = statusLineText({ v: 1, vault: vault(), wallet: mine({ gold: 0.001, spyx: 0.002, usdy: 0.42 }) }, { wallet: W, nowMs: NOW });
  assert.equal(
    line,
    "VaultBags | to claim: 0.0311 g gold, 0.002 SPY shares, 0.42 USDY ($1.23) | vault $1,208.28 | buying 30/35/35 today (UTC) | next purchase 44% queued | next run in 8m"
  );
  assert.ok(!line.includes("\n"), "one line");
});

test("real units: grams of gold, SPY shares by the multiplier, and without it SPYx", () => {
  assert.match(claimableText(mine({ gold: 1, spyx: 0, usdy: 0 }), {}), /31\.103 g gold/);
  assert.match(claimableText(mine({ gold: 0, spyx: 1, usdy: 0 }), { spyxSharesPerToken: MULT }), /1\.006 SPY shares/);
  assert.match(claimableText(mine({ gold: 0, spyx: 1, usdy: 0 }), {}), /1 SPYx/, "no multiplier: the index token, never the stored amount called shares");
  assert.match(claimableText(mine({ gold: 0.000000001, spyx: 0, usdy: 0 }), {}), /<0\.0001 g gold/, "a sliver is shown as a sliver, never 0");
});

test("nothing waiting, and an unread preview", () => {
  assert.equal(claimableText(mine({ gold: 0, spyx: 0, usdy: 0 }), {}), "nothing waiting to claim");
  assert.equal(claimableText(null, {}), null);
  assert.match(claimableText(mine({ gold: 0, spyx: 0, usdy: 0.0001, totalUsd: 0.0001 }), {}), /\(<\$0\.01\)$/, "under a cent is under a cent, never $0.00");
  const line = statusLineText({ v: 1, vault: vault() }, { wallet: W, nowMs: NOW });
  assert.ok(!/claim/.test(line), "a wallet not read yet says nothing about it");
});

test("a cache for another wallet is never shown for this one", () => {
  const other = { ...mine({ gold: 1, spyx: 1, usdy: 1 }), id: walletId("TestWa11etAddressForStatusLine2222222222222") };
  assert.ok(!/to claim/.test(statusLineText({ v: 1, vault: vault(), wallet: other }, { wallet: W, nowMs: NOW })));
});

test("left out, never zero: a total that is a floor, a missing buy, a missing queue", () => {
  assert.match(statusLineText({ v: 1, vault: vault({ allPriced: false }) }, { nowMs: NOW }), /vault at least \$1,208\.28/);
  const bare = statusLineText({ v: 1, vault: vault({ totalUsd: null, weights: null, queue: null }) }, { nowMs: NOW });
  assert.equal(bare, "VaultBags | next run in 8m");
});

test("today's buy only on its own day", () => {
  const line = statusLineText({ v: 1, vault: vault({ weightsDate: "2026-10-28" }) }, { nowMs: NOW });
  assert.ok(!/buying/.test(line), "yesterday's decision is not today's");
});

test("the agent's clock: every quarter hour UTC, the first minute running", () => {
  assert.deepEqual(nextRun(Date.parse(`${DAY}T12:00:20Z`)), { running: true, minutes: 0 });
  assert.deepEqual(nextRun(Date.parse(`${DAY}T12:01:00Z`)), { running: false, minutes: 14 });
  assert.deepEqual(nextRun(Date.parse(`${DAY}T12:14:01Z`)), { running: false, minutes: 1 });
  assert.match(statusLineText(null, { nowMs: Date.parse(`${DAY}T12:00:20Z`) }), /agent run due/, "due, not running: whether it started is not known");
});

test("an empty cache reads, a failed one says so, an old one says when", () => {
  assert.equal(statusLineText(null, { nowMs: NOW }), "VaultBags | next run in 8m | reading...");
  assert.match(statusLineText({ v: 1, vault: null, wallet: null, failedAt: NOW }, { nowMs: NOW }), /could not be read$/);
  const old = statusLineText({ v: 1, vault: vault({ at: Date.parse(`${DAY}T09:05:00Z`) }) }, { nowMs: NOW });
  assert.match(old, /as of 09:05 UTC$/);
  const yesterday = statusLineText({ v: 1, vault: vault({ at: Date.parse("2026-10-28T23:50:00Z") }) }, { nowMs: NOW });
  assert.match(yesterday, /as of Oct 28 23:50 UTC$/, "a read from another day says the day too");
  assert.ok(!/as of/.test(statusLineText({ v: 1, vault: vault() }, { nowMs: NOW })), "a fresh cache shows no age");
});

test("what is due: the vault every five minutes, a wallet every fifteen, backed off after a refusal", () => {
  assert.deepEqual(dueParts(null, { wallet: W, nowMs: NOW }), { vault: true, wallet: true });
  const fresh = { v: 1, vault: vault({ at: NOW - VAULT_TTL_MS + 1000 }), wallet: mine({}, { at: NOW - WALLET_TTL_MS + 1000 }) };
  assert.deepEqual(dueParts(fresh, { wallet: W, nowMs: NOW }), { vault: false, wallet: false });
  const stale = { v: 1, vault: vault({ at: NOW - VAULT_TTL_MS }), wallet: mine({}, { at: NOW - WALLET_TTL_MS }) };
  assert.deepEqual(dueParts(stale, { wallet: W, nowMs: NOW }), { vault: true, wallet: true });
  const refused = { v: 1, vault: vault(), wallet: mine({}, { at: NOW - 2 * WALLET_TTL_MS, retryAfter: NOW + 1000 }) };
  assert.equal(dueParts(refused, { wallet: W, nowMs: NOW }).wallet, false);
  assert.equal(dueParts({ v: 1, vault: vault() }, { nowMs: NOW }).wallet, false, "no wallet, nothing to read for it");
  // A read that failed waits its turn too: never one per run of the line,
  // which can be many a minute.
  const triedVault = { v: 2, vault: null, tried: { vault: NOW - 60_000 } };
  assert.equal(dueParts(triedVault, { nowMs: NOW }).vault, false);
  assert.equal(dueParts(triedVault, { nowMs: NOW + VAULT_TTL_MS }).vault, true);
  const triedWallet = { v: 2, vault: vault(), wallet: null, tried: { walletId: walletId(W), wallet: NOW - 60_000 } };
  assert.equal(dueParts(triedWallet, { wallet: W, nowMs: NOW }).wallet, false);
  assert.equal(dueParts(triedWallet, { wallet: W, nowMs: NOW + WALLET_TTL_MS }).wallet, true);
  assert.equal(dueParts(triedWallet, { wallet: "TestWa11etAddressForStatusLine2222222222222", nowMs: NOW }).wallet, true, "another wallet's attempt is not this one's");
});

// A fake API: each path answers what the map says, or throws.
const api = (answers) => async (path) => {
  const key = Object.keys(answers).find((k) => path.startsWith(k));
  const a = key ? answers[key] : undefined;
  if (a instanceof Error) throw a;
  if (a === undefined) throw new Error(`unexpected ${path}`);
  return a;
};
const LIVE = {
  "/api/agent/treasury-stats": { totalValueUsd: 1208.28, allPriced: true },
  "/api/agent/todays-allocation": { date: DAY, weights: { gold: 30, spyx: 35, usdy: 35 } },
  "/api/vault/pulse": { queue: { sol: 0.0134, thresholdSol: 0.03 } },
  "/api/rwa-refs": { spyxSharesPerToken: MULT },
  "/api/claim/preview": { found: true, claimable: { gold: { tokens: 0.001 }, spyx: { tokens: 0.002 }, usdy: { tokens: 0.42 } }, totalClaimableUsd: 1.23 },
};

test("a refresh reads what is due and keeps the figures it was given", async () => {
  const next = await refreshCache(null, { wallet: W, nowMs: NOW, get: api(LIVE) });
  assert.equal(next.vault.totalUsd, 1208.28);
  assert.deepEqual(next.vault.weights, { gold: 30, spyx: 35, usdy: 35 });
  assert.equal(next.vault.weightsDate, DAY);
  assert.deepEqual(next.wallet.preview, { gold: 0.001, spyx: 0.002, usdy: 0.42, totalUsd: 1.23 });
  assert.equal(next.wallet.at, NOW);
  assert.ok(!JSON.stringify(next).includes(W), "the cache keeps a hash of the address, never the address");
});

test("a preview that cannot answer is unread, never 'nothing' and never zero", async () => {
  const before = { v: 2, vault: vault(), wallet: mine({ gold: 0.5, spyx: 0, usdy: 0 }, { at: NOW - 2 * WALLET_TTL_MS }) };
  const next = await refreshCache(before, { wallet: W, nowMs: NOW, get: api({ ...LIVE, "/api/claim/preview": { found: false, reason: "not set up" } }) });
  assert.deepEqual(next.wallet, before.wallet, "the last good read stays, with its old time");
  assert.equal(next.tried.wallet, NOW, "and the attempt is recorded, so it waits its turn");
  const fresh = await refreshCache(null, { wallet: W, nowMs: NOW, get: api({ ...LIVE, "/api/claim/preview": { found: false } }) });
  assert.equal(fresh.wallet, null);
  assert.ok(!/claim/.test(statusLineText(fresh, { wallet: W, nowMs: NOW })), "nothing said about the wallet");
  const escrow = await refreshCache(null, { wallet: W, nowMs: NOW, get: api({ ...LIVE, "/api/claim/preview": { found: true, isEscrow: true } }) });
  assert.equal(escrow.wallet, null, "an escrow address has no claimable of its own: unread");
});

test("a part that could not be read keeps what the cache had", async () => {
  const before = { v: 1, vault: vault({ at: NOW - 2 * VAULT_TTL_MS }), wallet: mine({ gold: 0.5, spyx: 0, usdy: 0 }, { at: NOW - 2 * WALLET_TTL_MS }) };
  const down = api({ ...LIVE, "/api/agent/treasury-stats": new Error("down"), "/api/claim/preview": new Error("down") });
  const next = await refreshCache(before, { wallet: W, nowMs: NOW, get: down });
  assert.deepEqual(next.vault, before.vault, "the vault keeps its old figures and its old time");
  assert.deepEqual(next.wallet, before.wallet);
  assert.equal(next.failedAt, undefined, "something is still known");
  const nothing = await refreshCache(null, { wallet: W, nowMs: NOW, get: down });
  assert.equal(nothing.failedAt, NOW);
});

test("an allocation that could not be read keeps the last one with its date; a malformed one is dropped", async () => {
  const before = { v: 1, vault: vault({ at: NOW - 2 * VAULT_TTL_MS, weightsDate: "2026-10-28" }) };
  const next = await refreshCache(before, { nowMs: NOW, get: api({ ...LIVE, "/api/agent/todays-allocation": new Error("down") }) });
  assert.equal(next.vault.weightsDate, "2026-10-28");
  assert.ok(!/buying/.test(statusLineText(next, { nowMs: NOW })), "and the line does not call it today's");
  const bad = await refreshCache(before, { nowMs: NOW, get: api({ ...LIVE, "/api/agent/todays-allocation": { date: DAY, weights: { gold: 30 } } }) });
  assert.equal(bad.vault.weights, null);
});

test("a refused wallet read backs off an hour; a malformed preview is not read as zero", async () => {
  const refusal = Object.assign(new Error("429"), { status: 429 });
  const next = await refreshCache(null, { wallet: W, nowMs: NOW, get: api({ ...LIVE, "/api/claim/preview": refusal }) });
  assert.equal(next.wallet.retryAfter, NOW + WALLET_BACKOFF_MS);
  assert.ok(!JSON.stringify(next).includes(W), "a refusal keeps the hash, not the address");
  assert.equal(next.wallet.preview, null);
  assert.equal(dueParts(next, { wallet: W, nowMs: NOW + 60_000 }).wallet, false);
  const odd = await refreshCache(null, { wallet: W, nowMs: NOW, get: api({ ...LIVE, "/api/claim/preview": { found: true, claimable: { gold: { tokens: 1 } } } }) });
  assert.equal(odd.wallet, null, "a preview missing an asset is unread, not zero");
});

test("a fresh cache reads nothing", async () => {
  const fresh = { v: 1, vault: vault(), wallet: mine({ gold: 0, spyx: 0, usdy: 0 }) };
  const next = await refreshCache(fresh, { wallet: W, nowMs: NOW, get: api({}) });
  assert.deepEqual(next.vault, fresh.vault);
  assert.deepEqual(next.wallet, fresh.wallet);
});

test("addresses and cache names", () => {
  assert.ok(isWalletAddress(W));
  assert.ok(!isWalletAddress("0x1234"), "not base58");
  assert.ok(!isWalletAddress("short"));
  assert.ok(!isWalletAddress("O".repeat(44)), "O is not base58");
  const k = cacheKey("https://vaultbags.app", W);
  assert.match(k, /^[0-9a-f]{24}$/);
  assert.ok(!k.includes(W), "the file name does not carry the address");
  assert.notEqual(k, cacheKey("https://vaultbags.app", null));
  assert.notEqual(k, cacheKey("http://localhost:3000", W));
});

// The cache on disk, in a temporary folder of this test's own.
test("on disk: a folder of the user's own, a whole file, and only its own lock removed", async () => {
  const { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const os = await import("node:os");
  const root = mkdtempSync(join(os.tmpdir(), "vb-statusline-test-"));
  const env = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = root;
  try {
    const c = await import("../src/statuslineCache.js?" + Date.now());
    const dir = c.ownDir();
    assert.ok(dir && dir.startsWith(root), "the folder is under the temp folder");
    if (typeof process.getuid === "function") assert.equal(statSync(dir).mode & 0o077, 0, "and only its owner can open it");
    assert.equal(c.writeCache("k1", { vault: { at: 1 } }), true);
    assert.equal(c.readCache("k1").vault.at, 1);
    assert.equal(c.readCache("k1").v, c.CACHE_VERSION);
    assert.ok(!readdirSync(dir).some((n) => n.endsWith(".tmp")), "no temporary file is left behind");
    writeFileSync(join(dir, "k2.json"), "{not json");
    assert.equal(c.readCache("k2"), null, "a broken file reads as no cache");
    const token = c.tryLock("k1");
    assert.ok(token, "the lock is taken");
    assert.equal(c.tryLock("k1"), null, "and held");
    c.releaseLock("k1", "someone-else");
    assert.equal(c.isLocked("k1"), true, "another refresh's token does not remove it");
    c.releaseLock("k1", token);
    assert.equal(c.isLocked("k1"), false, "its own does");
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
