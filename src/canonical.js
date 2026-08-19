// The entire trust-critical spec, on purpose in one short file.
//
// These functions are deliberately NOT imported from VaultBags. A verifier that
// used the operator's own library to check the operator's own numbers would be
// asking the accused to mark their own exam. They are copied so they can be read
// in one sitting, audited in isolation, and reimplemented in any language.
//
// If any of this ever disagrees with what vaultbags.app publishes, this file is
// what a reader should trust, and the disagreement is the finding.

import crypto from "node:crypto";

export const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// Objects with keys sorted recursively (a database does not preserve insertion
// order, so a verifier reading a record back would otherwise serialize a
// different byte stream than the publisher did), arrays in order, primitives via
// JSON.stringify, undefined skipped.
export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalStringify(value[key]));
  }
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Claim ledger (Merkle)

// Amounts are compared as canonical decimals so "1.50", "1.5" and "01.5" cannot
// produce three different leaves for one payout.
export function canonicalDecimal(input) {
  const s = String(input == null ? "" : input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`not a plain decimal: ${input}`);
  let neg = false;
  let body = s;
  if (body[0] === "-") {
    neg = true;
    body = body.slice(1);
  }
  const dot = body.indexOf(".");
  let int = dot === -1 ? body : body.slice(0, dot);
  let frac = dot === -1 ? "" : body.slice(dot + 1);
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  const out = frac ? `${int}.${frac}` : int;
  return neg && out !== "0" ? `-${out}` : out;
}

// A leaf carrying `assets` ([{mint, amount}]) is v2: entries sorted by mint
// (base58 ascending), each `mint=amount`, joined by ",". Unambiguous because
// "=" and "," cannot appear in base58 or a plain decimal. Anything else is the
// original v1 trio, byte-identical to always, so every root ever stamped stays
// reproducible with this one file.
export function canonicalAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("assets must be a non-empty array");
  const entries = assets.map((a) => {
    if (typeof a?.mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.mint)) {
      throw new Error(`not a base58 mint: ${a?.mint}`);
    }
    return { mint: a.mint, amount: canonicalDecimal(a.amount) };
  });
  entries.sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].mint === entries[i - 1].mint) throw new Error(`duplicate mint ${entries[i].mint}`);
  }
  return entries.map((e) => `${e.mint}=${e.amount}`).join(",");
}

export function canonicalLeaf({ wallet, tokenMint, gold, spyx, usdy, assets, tx }) {
  if (assets != null) {
    return ["v2", `w:${wallet}`, `m:${tokenMint}`, `a:${canonicalAssets(assets)}`, `t:${tx}`].join("|");
  }
  return [
    "v1",
    `w:${wallet}`,
    `m:${tokenMint}`,
    `g:${canonicalDecimal(gold)}`,
    `s:${canonicalDecimal(spyx)}`,
    `u:${canonicalDecimal(usdy)}`,
    `t:${tx}`,
  ].join("|");
}

// Domain separation: a leaf hash and a node hash must never be interchangeable,
// or a leaf could be passed off as an internal node.
export const hashLeaf = (leaf) => sha256("leaf:" + canonicalLeaf(leaf));
export const hashNode = (l, r) => sha256("node:" + l + r);

export function foldProof(leaf, proof) {
  let acc = hashLeaf(leaf);
  for (const step of proof || []) {
    acc = step.side === "left" ? hashNode(step.hash, acc) : hashNode(acc, step.hash);
  }
  return acc;
}

// Rebuild a whole day's root from the published set: leaves sorted by tx,
// pairwise, odd node carried up unchanged.
export function buildRoot(leaves) {
  const sorted = [...leaves].sort((a, b) => (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0));
  let level = sorted.map(hashLeaf);
  if (level.length === 0) return null;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashNode(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

// ---------------------------------------------------------------------------
// Daily decision receipt

// Rebuilt from named fields rather than hashing whatever object arrived, so a
// server that padded its payload with an extra key gains nothing by it.
// `d` is the decision-proof response. The signals live INSIDE its published
// payload, not beside it, and reading them from the wrong level silently hashes
// null instead of the market data the receipt actually commits to. The fields
// are named explicitly rather than spread, so the response cannot smuggle an
// extra key into the digest.
export function decisionPayload(d) {
  return {
    v: 1,
    date: d?.date,
    weights: { gold: d?.weights?.gold, spyx: d?.weights?.spyx, usdy: d?.weights?.usdy },
    signals: d?.payload?.signals ?? null,
  };
}

// ---------------------------------------------------------------------------
// Monthly report receipt

export function monthlyPayload({ period, metrics }) {
  return { v: 1, kind: "monthly-report", period, metrics: metrics ?? null };
}

// The hash is always the last colon-separated field of the memo, whatever the
// memo's shape, so reading it does not depend on counting fields.
export function hashFromMemo(memo) {
  if (typeof memo !== "string" || !memo) return null;
  const last = memo.split(":").pop();
  return /^[0-9a-f]{64}$/.test(last) ? last : null;
}
