// The receipt verifier, exercised with keys generated here and never used again.
//
// Weighted the way keyguard's tests are: broad on what must be REFUSED. A
// receipt verifier that lets one forged token through has told someone a
// payment happened that did not, which is the one thing it exists to prevent.
// The chain leg is not tested here (it is IO); everything before it is.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, createHash, sign as cryptoSign } from "node:crypto";
import {
  decodeReceipt,
  verifyReceiptSignature,
  checkReceiptClaims,
  RECEIPT_ISSUER,
  RECEIPT_AUDIENCE,
  MAX_RECEIPT_BYTES,
} from "../src/receipt.js";
import { tokenDeltasFromMeta } from "../src/io.js";
import { refuseSecretArgs } from "../src/keyguard.js";

// Throwaway RSA pairs, generated in memory for this run and gone when the
// process exits. NO key material is stored in this file or anywhere else in
// this repository; these exist only so a signature can be made and then
// refused. `signer` stands in for the issuer, `otherSigner` is an unrelated
// one, and `weakSigner` is deliberately too small to be accepted.
//
// The signing half is picked by asking the pair which member is not the public
// one, so the word that names it appears nowhere in this file. That is for the
// reader, not the code: a generated test fixture and a real secret look alike
// at a glance, and a glance is all a public repository usually gets.
function throwawaySigner(bits = 2048) {
  const pair = generateKeyPairSync("rsa", { modulusLength: bits });
  return Object.values(pair).find((k) => k.type !== "public");
}
const signer = throwawaySigner();
const otherSigner = throwawaySigner();
const weakSigner = throwawaySigner(1024);

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Mirrors how the issuer signs: RS256 over header.claims, kid derived from the
// public key. The verifier does not depend on HOW kid is derived, only that the
// header's kid selects a published key.
function issue(claims, key = signer, { header = {} } = {}) {
  const pub = createPublicKey(key);
  const jwk = pub.export({ format: "jwk" });
  const kid = createHash("sha256").update(`${jwk.n}.${jwk.e}`).digest("base64url").slice(0, 16);
  const h = { alg: "RS256", typ: "JWT", kid, ...header };
  const input = `${enc(h)}.${enc(claims)}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), key);
  return { jwt: `${input}.${sig.toString("base64url")}`, kid, keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] };
}

// Structurally shaped like the real things, never real.
const TX = "4agYGZ" + "b".repeat(82);
const PAY_TO = "A".repeat(44);
const ASSET = "B".repeat(43);
const PAYER = "C".repeat(40);
const NOW = 1_800_000_000;

const goodClaims = (over = {}) => ({
  iss: RECEIPT_ISSUER,
  aud: RECEIPT_AUDIENCE,
  event: "payment.succeeded",
  resource: "https://vaultbags.app/api/agent/ask",
  amount: "50000",
  currency: "USDC",
  tx_hash: TX,
  payer_wallet: PAYER,
  pay_to: PAY_TO,
  asset: ASSET,
  network: "solana:mainnet",
  status: "settled",
  iat: NOW - 10,
  exp: NOW + 3590,
  jti: "b3c2d1e0-0000-4000-8000-000000000001",
  ...over,
});

const allOk = (checks) => checks.every((c) => c.ok);
const failing = (checks) => checks.filter((c) => !c.ok).map((c) => c.label);

test("a receipt signed by the published key verifies, and its claims hold", () => {
  const { jwt, kid, keys } = issue(goodClaims());
  const d = decodeReceipt(jwt);
  assert.equal(d.ok, true);
  const sig = verifyReceiptSignature(d, keys);
  assert.deepEqual(sig, { ok: true, kid });
  assert.equal(allOk(checkReceiptClaims(d.claims, { nowSec: NOW })), true);
});

test("a different key does not verify it", () => {
  const { jwt } = issue(goodClaims());
  const { keys } = issue(goodClaims(), otherSigner);
  const d = decodeReceipt(jwt);
  // Same kid lookup fails first (different key, different kid); and even with
  // the kid forced to match, the signature must not verify.
  assert.equal(verifyReceiptSignature(d, keys).ok, false);
  const forced = keys.map((k) => ({ ...k, kid: d.header.kid }));
  assert.equal(verifyReceiptSignature(d, forced).ok, false);
});

test("editing one claim under a valid signature breaks the signature", () => {
  // The attack that matters: keep the header and signature of a real receipt,
  // change one claim (here, the amount by one atomic unit) and re-encode. The
  // token still decodes as a well-formed receipt; the signature no longer holds.
  const { jwt, keys } = issue(goodClaims());
  const [h, , s] = jwt.split(".");
  const d = decodeReceipt(`${h}.${enc(goodClaims({ amount: "50001" }))}.${s}`);
  assert.equal(d.ok, true);
  assert.equal(verifyReceiptSignature(d, keys).ok, false);
  // And the same with a single header byte: kid stays, typ changes.
  const d2 = decodeReceipt(`${enc({ ...d.header, typ: "JWS" })}.${jwt.split(".")[1]}.${s}`);
  assert.equal(d2.ok, true);
  assert.equal(verifyReceiptSignature(d2, keys).ok, false);
});

test('"alg":"none" and HS256 are refused before any key is consulted', () => {
  const { keys } = issue(goodClaims());
  for (const alg of ["none", "HS256", "RS512", "PS256", undefined]) {
    const h = { alg, typ: "JWT", kid: keys[0].kid };
    const jwt = `${enc(h)}.${enc(goodClaims())}.${enc({})}`;
    const d = decodeReceipt(jwt);
    const r = verifyReceiptSignature(d, keys);
    assert.equal(r.ok, false, `alg ${alg}`);
    assert.match(r.reason, /only RS256/);
  }
});

test("a kid the issuer never published is refused", () => {
  const { jwt, keys } = issue(goodClaims(), signer, { header: { kid: "nope" } });
  const r = verifyReceiptSignature(decodeReceipt(jwt), keys);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no key with id nope/);
});

test("a published key that is weak, not RSA, or not for signing is refused", () => {
  const weakIssue = issue(goodClaims(), weakSigner);
  assert.match(verifyReceiptSignature(decodeReceipt(weakIssue.jwt), weakIssue.keys).reason, /1024-bit/);

  const { jwt, keys } = issue(goodClaims());
  const d = decodeReceipt(jwt);
  assert.match(verifyReceiptSignature(d, [{ ...keys[0], kty: "EC" }]).reason, /not RSA/);
  assert.match(verifyReceiptSignature(d, [{ ...keys[0], use: "enc" }]).reason, /not for signatures/);
  assert.match(verifyReceiptSignature(d, [{ ...keys[0], alg: "RS512" }]).reason, /RS512/);
  assert.match(verifyReceiptSignature(d, [{ ...keys[0], n: "AAAA" }]).reason, /could not be parsed|floor/);
  assert.equal(verifyReceiptSignature(d, []).ok, false);
  assert.equal(verifyReceiptSignature(d, null).ok, false);
});

test("malformed tokens are refused at decode, with a reason", () => {
  assert.equal(decodeReceipt("").ok, false);
  assert.equal(decodeReceipt(null).ok, false);
  assert.equal(decodeReceipt("a.b").ok, false);
  assert.equal(decodeReceipt("a.b.c.d").ok, false);
  assert.equal(decodeReceipt("a.b.").ok, false);
  assert.equal(decodeReceipt("a.b.c=").ok, false, "padding is not base64url");
  assert.equal(decodeReceipt(`${enc([1])}.${enc({})}.x`).ok, false, "header must be an object");
  assert.equal(decodeReceipt(`${enc({})}.${enc("s")}.x`).ok, false, "claims must be an object");
  const huge = `${enc({ alg: "RS256" })}.${enc({ pad: "x".repeat(MAX_RECEIPT_BYTES) })}.x`;
  const r = decodeReceipt(huge);
  assert.equal(r.ok, false);
  assert.match(r.reason, /longer than any receipt/);
});

test("expired, future-dated, and mis-addressed receipts fail their own rules", () => {
  const at = (over) => failing(checkReceiptClaims(goodClaims(over), { nowSec: NOW }));
  assert.deepEqual(at({ exp: NOW - 1 }), ["not expired"]);
  assert.deepEqual(at({ exp: undefined }), ["not expired"]);
  assert.deepEqual(at({ iat: NOW + 301 }), ["issued in the past"]);
  assert.deepEqual(at({ iat: NOW + 299 }), [], "small skew is tolerated");
  assert.deepEqual(at({ iss: "vaultbags.app.evil.example" }), [`issued by ${RECEIPT_ISSUER}`]);
  assert.deepEqual(at({ aud: "something-else" }), ["addressed to receipt verifiers"]);
  assert.deepEqual(at({ aud: [RECEIPT_AUDIENCE] }), ["addressed to receipt verifiers"], "an array aud is not ours");
  assert.deepEqual(at({ status: "pending" }), ["records a settled payment"]);
  assert.deepEqual(at({ event: "payment.failed" }), ["records a settled payment"]);
});

test("the facts the chain leg depends on must be well-formed", () => {
  const at = (over) => failing(checkReceiptClaims(goodClaims(over), { nowSec: NOW }));
  assert.deepEqual(at({ tx_hash: "short" }), ["names a transaction"]);
  assert.deepEqual(at({ tx_hash: "0".repeat(80) }), ["names a transaction"], "0 is not base58");
  assert.deepEqual(at({ amount: 50000 }), ["names a positive amount in USDC"], "a number is lossy; the amount is a string");
  assert.deepEqual(at({ amount: "0" }), ["names a positive amount in USDC"]);
  assert.deepEqual(at({ amount: "-5" }), ["names a positive amount in USDC"]);
  assert.deepEqual(at({ currency: "USDT" }), ["names a positive amount in USDC"]);
  assert.deepEqual(at({ pay_to: null }), ["names the destination wallet and the asset"]);
  assert.deepEqual(at({ asset: "l".repeat(40) }), ["names the destination wallet and the asset"], "l is not base58");
  assert.deepEqual(at({ payer_wallet: "not-an-address" }), ["names the payer, or says it could not"]);
  assert.deepEqual(at({ payer_wallet: null }), [], "an unknown payer is allowed and said");
  assert.deepEqual(at({ resource: "http://vaultbags.app/api/agent/ask" }), ["names a resource of the issuer"], "https only");
  assert.deepEqual(at({ resource: "https://evil.example/api/agent/ask" }), ["names a resource of the issuer"]);
  assert.deepEqual(at({ resource: "not a url" }), ["names a resource of the issuer"]);
  assert.deepEqual(at({ jti: "short" }), ["carries a unique id"]);
  assert.deepEqual(at({ network: "" }), ["names the network"]);
});

test("token deltas are summed per owner and mint from the balances the chain recorded", () => {
  const bal = (accountIndex, owner, mint, amount, decimals = 6) => ({
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: amount },
  });
  const meta = {
    preTokenBalances: [bal(1, "payer", "usdc", "1000000"), bal(2, "vault", "usdc", "250000")],
    postTokenBalances: [
      bal(1, "payer", "usdc", "950000"),
      bal(2, "vault", "usdc", "290000"),
      // an account created in this transaction: absent before, present after
      bal(3, "vault", "usdc", "10000"),
      bal(4, "someone", "other", "7"),
    ],
  };
  const deltas = tokenDeltasFromMeta(meta);
  const byKey = Object.fromEntries(deltas.map((d) => [`${d.owner}|${d.mint}`, d]));
  assert.equal(byKey["payer|usdc"].delta, "-50000");
  assert.equal(byKey["vault|usdc"].delta, "50000", "two accounts of one owner sum");
  assert.equal(byKey["vault|usdc"].decimals, 6);
  assert.equal(byKey["someone|other"].delta, "7");
  assert.deepEqual(tokenDeltasFromMeta(null), []);
  assert.deepEqual(tokenDeltasFromMeta({ preTokenBalances: [{ owner: "x" }] }), [], "a balance with no mint or amount is ignored");
});

test("a receipt is not mistaken for a secret, and a bare key given as one still is", () => {
  // A real RS256 signature is 342 base64url characters, and a run of 80+ that
  // happens to be all base58 is not rare. The guard tests whole arguments today,
  // so the dots already keep a token from matching a key pattern; the exemption
  // by SHAPE pins that a receipt stays allowed even if the guard ever learns to
  // scan inside an argument. Built so the signature part is exactly such a run.
  const jwt = `${enc({ alg: "RS256", kid: "k" })}.${enc(goodClaims())}.${"A".repeat(342)}`;
  const shaped = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt);
  assert.equal(shaped, true);
  const receiptArgs = shaped ? [jwt] : [];
  assert.equal(refuseSecretArgs(["verify", "receipt", jwt], { signatureArgs: receiptArgs }).refuse, false);
  // The exemption is by shape, and a key has no dots: it is still refused.
  const key = "5".repeat(88);
  const keyArgs = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key) ? [key] : [];
  assert.equal(refuseSecretArgs(["verify", "receipt", key], { signatureArgs: keyArgs }).refuse, true);
});
