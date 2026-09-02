// A paid call's receipt, decoded and checked without trusting it.
//
// The receipt is a JWT: three base64url parts, header.claims.signature. Every
// decision here is made from the bytes, never from what the token says about
// itself. The one thing the token is allowed to influence is WHICH published
// key is tried (its kid), and even that only selects among keys the issuer
// published; it cannot supply one. The algorithm is pinned before any key is
// touched, which closes the two classic JWT holes: "alg":"none" (a token with
// no signature at all) and HS256 with the public key used as the secret.
//
// Pure: node:crypto only, no IO, so every branch is testable offline. The
// signature proves who ISSUED the receipt. What the receipt SAYS is checked
// against the chain in verify.js; nothing here counts as proof of payment.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const RECEIPT_ISSUER = "vaultbags.app";
export const RECEIPT_AUDIENCE = "vaultbags:x402-receipt";
export const RECEIPT_ALG = "RS256";

// A real receipt is a few hundred bytes. Anything an order of magnitude larger
// is not one, and decoding it would be work done on an attacker's behalf.
export const MAX_RECEIPT_BYTES = 8192;

// RSA below this is not considered safe to sign anything with. A key that size
// is refused even if the issuer's set carries it: a verifier that accepts a
// weak key because it was published has delegated its judgement.
const MIN_MODULUS_BITS = 2048;

// Clock skew allowed before a receipt reads as issued in the future.
const IAT_TOLERANCE_SEC = 300;

const B64URL = /^[A-Za-z0-9_-]+$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isSignature = (s) => typeof s === "string" && s.length >= 64 && s.length <= 88 && BASE58.test(s);
const isAddress = (s) => typeof s === "string" && s.length >= 32 && s.length <= 44 && BASE58.test(s);

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

// Split and decode, nothing more. A receipt that fails here was never a
// receipt; one that passes has said nothing yet about who signed it.
export function decodeReceipt(jwt) {
  if (typeof jwt !== "string" || !jwt) return { ok: false, reason: "no receipt given" };
  if (Buffer.byteLength(jwt, "utf8") > MAX_RECEIPT_BYTES) {
    return { ok: false, reason: `longer than any receipt (${MAX_RECEIPT_BYTES} bytes)` };
  }
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "a receipt has three dot-separated parts" };
  if (!parts.every((p) => p.length > 0 && B64URL.test(p))) {
    return { ok: false, reason: "a part is not base64url" };
  }
  const [h, p, s] = parts;
  const header = decodePart(h);
  const claims = decodePart(p);
  if (!isObject(header) || !isObject(claims)) {
    return { ok: false, reason: "header or claims are not a JSON object" };
  }
  return { ok: true, header, claims, signingInput: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

// Check the signature against the issuer's published keys. Returns
// { ok: true, kid } or { ok: false, reason }. The header's alg is compared
// before anything else, and only the RSA public parameters of the chosen key
// are handed to the crypto layer, so nothing else in a published key object
// can influence the result.
export function verifyReceiptSignature(decoded, keys) {
  const { header, signingInput, signature } = decoded;
  if (header.alg !== RECEIPT_ALG) {
    return { ok: false, reason: `alg is ${JSON.stringify(header.alg ?? null)}; only ${RECEIPT_ALG} is accepted` };
  }
  if (typeof header.kid !== "string" || !header.kid) {
    return { ok: false, reason: "the header names no key (kid)" };
  }
  const list = Array.isArray(keys) ? keys : [];
  const jwk = list.find((k) => isObject(k) && k.kid === header.kid);
  if (!jwk) return { ok: false, reason: `the issuer publishes no key with id ${header.kid}` };
  if (jwk.kty !== "RSA") return { ok: false, reason: "the published key is not RSA" };
  if (jwk.use !== undefined && jwk.use !== "sig") {
    return { ok: false, reason: "the published key is not for signatures" };
  }
  if (jwk.alg !== undefined && jwk.alg !== RECEIPT_ALG) {
    return { ok: false, reason: `the published key is for ${jwk.alg}, not ${RECEIPT_ALG}` };
  }
  let key;
  try {
    key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch {
    return { ok: false, reason: "the published key could not be parsed" };
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_MODULUS_BITS) {
    return { ok: false, reason: `the published key is ${bits}-bit RSA; ${MIN_MODULUS_BITS} is the floor` };
  }
  let good = false;
  try {
    good = cryptoVerify("RSA-SHA256", Buffer.from(signingInput), key, signature);
  } catch {
    good = false;
  }
  return good ? { ok: true, kid: header.kid } : { ok: false, reason: "the signature does not verify against that key" };
}

// The claims, held to their own rules. Each entry is one line a reader sees;
// every one must pass before the chain is asked anything, because a receipt
// whose own fields are malformed has nothing coherent to check on-chain.
export function checkReceiptClaims(claims, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const out = [];
  const add = (label, ok, detail) => out.push({ label, ok, detail: detail || null });

  add(
    `issued by ${RECEIPT_ISSUER}`,
    claims.iss === RECEIPT_ISSUER,
    claims.iss === RECEIPT_ISSUER ? null : `iss is ${JSON.stringify(claims.iss ?? null)}`
  );
  add(
    "addressed to receipt verifiers",
    claims.aud === RECEIPT_AUDIENCE,
    claims.aud === RECEIPT_AUDIENCE ? null : `aud is ${JSON.stringify(claims.aud ?? null)}`
  );
  add(
    "records a settled payment",
    claims.event === "payment.succeeded" && claims.status === "settled",
    `event ${JSON.stringify(claims.event ?? null)}, status ${JSON.stringify(claims.status ?? null)}`
  );

  const expOk = Number.isInteger(claims.exp) && nowSec <= claims.exp;
  add(
    "not expired",
    expOk,
    expOk
      ? null
      : Number.isInteger(claims.exp)
        ? `expired ${nowSec - claims.exp}s ago; a receipt is a time-boxed proof, the payment itself can still be read on-chain`
        : "no expiry"
  );
  const iatOk =
    Number.isInteger(claims.iat) &&
    claims.iat <= nowSec + IAT_TOLERANCE_SEC &&
    (!Number.isInteger(claims.exp) || claims.iat <= claims.exp);
  add("issued in the past", iatOk, iatOk ? null : "iat is missing, in the future, or after exp");

  const jtiOk = typeof claims.jti === "string" && claims.jti.length >= 8 && claims.jti.length <= 128;
  add("carries a unique id", jtiOk, jtiOk ? null : "jti is missing or malformed");

  add("names a transaction", isSignature(claims.tx_hash), isSignature(claims.tx_hash) ? null : "tx_hash is not a Solana signature");

  const amountOk = typeof claims.amount === "string" && /^\d{1,30}$/.test(claims.amount) && BigInt(claims.amount) > 0n;
  const currencyOk = claims.currency === "USDC";
  add(
    "names a positive amount in USDC",
    amountOk && currencyOk,
    amountOk && currencyOk ? null : `amount ${JSON.stringify(claims.amount ?? null)} ${JSON.stringify(claims.currency ?? null)}`
  );

  const destOk = isAddress(claims.pay_to) && isAddress(claims.asset);
  add("names the destination wallet and the asset", destOk, destOk ? null : "pay_to or asset is not a Solana address");

  const payerOk = claims.payer_wallet === null || claims.payer_wallet === undefined || isAddress(claims.payer_wallet);
  add(
    "names the payer, or says it could not",
    payerOk,
    payerOk ? (claims.payer_wallet ? null : "no payer recorded; the chain check rests on the transfer alone") : "payer_wallet is not a Solana address"
  );

  // Against the constant, not against the token's own iss: a forged iss must
  // not get to redefine whose resource counts as the issuer's.
  let resourceOk = false;
  try {
    const u = new URL(claims.resource);
    resourceOk = u.protocol === "https:" && u.host === RECEIPT_ISSUER;
  } catch {
    resourceOk = false;
  }
  add("names a resource of the issuer", resourceOk, resourceOk ? null : `resource is ${JSON.stringify(claims.resource ?? null)}`);

  const networkOk = typeof claims.network === "string" && claims.network.length > 0 && claims.network.length <= 64;
  add("names the network", networkOk, networkOk ? null : "network is missing");

  return out;
}
