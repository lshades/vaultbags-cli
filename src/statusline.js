// One line about the vault, for Claude Code's status line or a shell prompt:
// what a wallet has waiting to be claimed, in real units, the vault's total,
// today's buy, and when the agent runs next.
//
// A status line runs on every event of a session, is cancelled when the next
// one arrives, and holds the bar still while it runs, so the line is printed
// from a local cache and never waits on the network. When the cache is old, a
// separate background process refreshes it and the NEXT run shows the new
// figures. The public claim preview allows 200 reads a day per IP (one network,
// whoever shares it), so a wallet is read at most every fifteen minutes and the
// vault's public figures at most every five; a read that fails waits the same
// before it is tried again, and a refused one an hour. A figure that could not
// be read is left out, never shown as zero, and a cache older than an hour says
// when it was read.
//
// Read-only and public data: the wallet is an address, never a key. The cache
// keeps a hash of it, not the address.

import { createHash } from "node:crypto";

export const VAULT_TTL_MS = 5 * 60 * 1000;
export const WALLET_TTL_MS = 15 * 60 * 1000;
// After a refusal (the network is at its daily allowance), the wallet waits this long.
export const WALLET_BACKOFF_MS = 60 * 60 * 1000;
export const SHOW_AGE_AFTER_MS = 60 * 60 * 1000;
// The agent runs on every quarter hour UTC; the minute after reads as due.
export const AGENT_RUN_EVERY_MS = 15 * 60 * 1000;
export const AGENT_RUNNING_MS = 60 * 1000;
const GRAMS_PER_TROY_OUNCE = 31.1034768;
const SEP = " | ";

const finite = (n) => n != null && Number.isFinite(Number(n));
const positive = (n) => finite(n) && Number(n) > 0;
// A stored time more than this far ahead of the clock (the clock was set back,
// or the file was edited) is no time at all: kept, it would hold every refresh
// off until the clock caught up.
export const FUTURE_SLACK_MS = 5 * 60 * 1000;
const past = (x, nowMs) => (finite(x) && Number(x) <= nowMs + FUTURE_SLACK_MS ? Number(x) : null);

export const isWalletAddress = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Where a (base, wallet) pair keeps its cache: a hash, so the file name does not carry the address. */
export function cacheKey(base, wallet) {
  return createHash("sha256").update(`${base}\n${wallet || ""}`).digest("hex").slice(0, 24);
}

/** How the cache names a wallet: a hash, so the file does not carry the address. */
export const walletId = (wallet) => createHash("sha256").update(`vaultbags-statusline\n${wallet}`).digest("hex").slice(0, 32);
const sameWallet = (entry, wallet) => !!(entry && wallet && entry.id === walletId(wallet));

export function nextRun(nowMs) {
  const elapsed = ((nowMs % AGENT_RUN_EVERY_MS) + AGENT_RUN_EVERY_MS) % AGENT_RUN_EVERY_MS;
  if (elapsed < AGENT_RUNNING_MS) return { running: true, minutes: 0 };
  return { running: false, minutes: Math.ceil((AGENT_RUN_EVERY_MS - elapsed) / 60000) };
}

// Dollars to the cent, and a positive amount under a cent as under a cent.
const fmtUsd = (n) => {
  const v = Number(n);
  if (v > 0 && v < 0.005) return "<$0.01";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// An amount in its own unit: enough digits to see it, never "0" for a sliver.
function fmtAmount(n) {
  const v = Number(n);
  if (v > 0 && v < 0.0001) return "<0.0001";
  const digits = v >= 100 ? 2 : v >= 1 ? 3 : 4;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/**
 * What a wallet has waiting, in real units: gold in grams, SPYx as SPY shares
 * (by the mint's multiplier; without it, as SPYx), USDY as itself. null when
 * the preview is unread.
 */
export function claimableText(wallet, refs) {
  const p = wallet?.preview;
  if (!p) return null;
  const parts = [];
  if (positive(p.gold)) parts.push(`${fmtAmount(Number(p.gold) * GRAMS_PER_TROY_OUNCE)} g gold`);
  if (positive(p.spyx)) {
    const per = refs?.spyxSharesPerToken;
    parts.push(positive(per) ? `${fmtAmount(Number(p.spyx) * Number(per))} SPY shares` : `${fmtAmount(p.spyx)} SPYx`);
  }
  if (positive(p.usdy)) parts.push(`${fmtAmount(p.usdy)} USDY`);
  if (!parts.length) return "nothing waiting to claim";
  return `to claim: ${parts.join(", ")}${finite(p.totalUsd) ? ` (${fmtUsd(p.totalUsd)})` : ""}`;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// When an old read was made: the time, and the day too when it is not today's.
function ageText(atMs, nowMs) {
  const d = new Date(atMs);
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  return utcDay(atMs) === utcDay(nowMs) ? `as of ${time}` : `as of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${time}`;
}

/** The line, from the cache alone. */
export function statusLineText(cache, { wallet = null, nowMs = Date.now() } = {}) {
  const parts = ["VaultBags"];
  const w = sameWallet(cache?.wallet, wallet) ? cache.wallet : null;
  const mine = wallet ? claimableText(w, cache?.vault?.refs) : null;
  if (mine) parts.push(mine);
  const v = cache?.vault;
  if (v) {
    if (finite(v.totalUsd)) parts.push(`vault ${v.allPriced === false ? "at least " : ""}${fmtUsd(v.totalUsd)}`);
    const wt = v.weights;
    // Today's buy only on the day it was decided: a decision kept from a
    // read on another UTC day is not today's.
    if (wt && v.weightsDate === utcDay(nowMs) && ["gold", "spyx", "usdy"].every((k) => finite(wt[k]))) {
      parts.push(`buying ${wt.gold}/${wt.spyx}/${wt.usdy} today (UTC)`);
    }
    if (v.queue && positive(v.queue.thresholdSol) && finite(v.queue.sol)) {
      const pct = Math.min(100, Math.floor((Number(v.queue.sol) / Number(v.queue.thresholdSol)) * 100));
      parts.push(`next purchase ${pct}% queued`);
    }
  }
  // The schedule is known; whether the run started is not, so the minute it
  // is due reads as due, not as running.
  const run = nextRun(nowMs);
  parts.push(run.running ? "agent run due" : `next run in ${run.minutes}m`);
  const oldest = [past(v?.at, nowMs), wallet ? past(w?.at, nowMs) : null].filter(finite);
  if (!v && !w?.preview) parts.push(cache?.failedAt ? "could not be read" : "reading...");
  else if (oldest.length && nowMs - Math.min(...oldest) > SHOW_AGE_AFTER_MS) parts.push(ageText(Math.min(...oldest), nowMs));
  return parts.join(SEP);
}

// Due when the last read is older than its life AND the last attempt, read or
// not, is too: a read that keeps failing is tried on the same schedule, never
// on every run of the line.
const dueBy = (at, triedAt, ttl, nowMs) => {
  const last = Math.max(past(at, nowMs) ?? -Infinity, past(triedAt, nowMs) ?? -Infinity);
  return nowMs - last >= ttl;
};

/** Which parts the cache needs read again. */
export function dueParts(cache, { wallet = null, nowMs = Date.now() } = {}) {
  const vault = dueBy(cache?.vault?.at, cache?.tried?.vault, VAULT_TTL_MS, nowMs);
  let mine = false;
  if (wallet) {
    const w = sameWallet(cache?.wallet, wallet) ? cache.wallet : null;
    // A wait is at most the backoff from now; a longer one is a clock set back.
    const waitUntil = finite(w?.retryAfter) && Number(w.retryAfter) <= nowMs + WALLET_BACKOFF_MS + FUTURE_SLACK_MS ? Number(w.retryAfter) : 0;
    const tried = cache?.tried?.walletId === walletId(wallet) ? cache.tried.wallet : null;
    mine = nowMs >= waitUntil && dueBy(w?.at, tried, WALLET_TTL_MS, nowMs);
  }
  return { vault, wallet: mine };
}

const num = (x) => (finite(x) ? Number(x) : null);

/**
 * The cache after one refresh. `get(path)` returns the API's JSON or throws
 * (an error with `status` 429 is a refusal). A part that could not be read
 * keeps what the cache had, with its old time; nothing is ever set to zero
 * for want of a read. Every attempt is recorded in `tried`, so the next one
 * waits its turn.
 */
export async function refreshCache(cache, { wallet = null, nowMs = Date.now(), get }) {
  const due = dueParts(cache, { wallet, nowMs });
  const id = wallet ? walletId(wallet) : null;
  const next = {
    v: 2,
    vault: cache?.vault ?? null,
    wallet: wallet && sameWallet(cache?.wallet, wallet) ? cache.wallet : null,
    tried: {
      vault: cache?.tried?.vault ?? null,
      walletId: id,
      wallet: id && cache?.tried?.walletId === id ? cache.tried.wallet ?? null : null,
    },
  };
  let failed = false;
  if (due.vault) {
    next.tried.vault = nowMs;
    const since = new Date(nowMs - 60_000).toISOString();
    const [stats, today, pulse, refs] = await Promise.allSettled([
      get("/api/agent/treasury-stats"),
      get("/api/agent/todays-allocation"),
      get(`/api/vault/pulse?since=${encodeURIComponent(since)}`),
      get("/api/rwa-refs"),
    ]);
    const val = (r) => (r.status === "fulfilled" ? r.value : null);
    const s = val(stats);
    if (s && finite(s.totalValueUsd)) {
      const t = val(today);
      const p = val(pulse);
      const r = val(refs);
      const readWeights = t?.weights && typeof t.date === "string" && ["gold", "spyx", "usdy"].every((k) => finite(t.weights[k]));
      const weights = readWeights ? { gold: num(t.weights.gold), spyx: num(t.weights.spyx), usdy: num(t.weights.usdy) } : null;
      next.vault = {
        at: nowMs,
        totalUsd: num(s.totalValueUsd),
        allPriced: s.allPriced === false ? false : true,
        // An allocation read that failed keeps the last one, with its own date.
        weights: readWeights ? weights : t ? null : next.vault?.weights ?? null,
        weightsDate: readWeights ? t.date : t ? null : next.vault?.weightsDate ?? null,
        queue: p?.queue && finite(p.queue.sol) && positive(p.queue.thresholdSol) ? { sol: num(p.queue.sol), thresholdSol: num(p.queue.thresholdSol) } : null,
        refs: positive(r?.spyxSharesPerToken) ? { spyxSharesPerToken: num(r.spyxSharesPerToken) } : next.vault?.refs ?? null,
      };
    } else failed = true;
  }
  if (due.wallet) {
    next.tried.wallet = nowMs;
    try {
      const pv = await get(`/api/claim/preview?wallet=${encodeURIComponent(wallet)}`);
      // found: false is the preview saying it cannot answer for this vault
      // right now (not "this wallet holds nothing"): unread, like any other
      // read that did not come back.
      const c = pv?.found === true ? pv?.claimable : null;
      const tokens = (k) => num(c?.[k]?.tokens);
      if (c && ["gold", "spyx", "usdy"].every((k) => tokens(k) !== null)) {
        next.wallet = { id, at: nowMs, preview: { gold: tokens("gold"), spyx: tokens("spyx"), usdy: tokens("usdy"), totalUsd: num(pv.totalClaimableUsd) } };
      } else failed = true;
    } catch (e) {
      failed = true;
      if (e?.status === 429) next.wallet = { ...(next.wallet || { id, at: null, preview: null }), retryAfter: nowMs + WALLET_BACKOFF_MS };
    }
  }
  if (failed && !next.vault && !next.wallet?.preview) next.failedAt = nowMs;
  return next;
}
