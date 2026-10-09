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
// Pure: node:crypto and the canonical JSON only, no IO, so every branch is
// testable offline. The signature proves who ISSUED the receipt. What the
// receipt SAYS is checked against the chain in verify.js; nothing here counts
// as proof of payment.

import { createPublicKey, createHash, verify as cryptoVerify } from "node:crypto";
import { canonicalStringify } from "./canonical.js";

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
        ? `expired ${nowSec - claims.exp}s ago; a receipt is a time-boxed proof, so it no longer stands on its own, and its signature and the payment it names are still checked`
        : "no expiry"
  );
  // Past its expiry is not the same as malformed: the receipt was still issued
  // and the payment still happened or did not. `expired` marks that one case,
  // so a caller can keep checking the chain and settle on "partly verified"
  // instead of reading a lapsed time box as a forgery. A receipt with no expiry
  // at all is malformed and stays a failure.
  if (!expOk && Number.isInteger(claims.exp)) out[out.length - 1].expired = true;
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

// --- What the payment bought ---------------------------------------------------
//
// A receipt can also name what the call delivered (`delivery`): for an answer,
// the sha256 of the question as the agent read it, of the answer exactly as
// served, and the tools whose results it read; for an export, the sha256 of the
// served JSON body, canonicalized. Signed with the payment, that lets whoever
// holds the text show it is what the vault delivered for that payment.
//
// What this proves is narrow and stated that way: the issuer signed these
// hashes. Whether the answer is RIGHT is a different question, and nothing
// here speaks to it. An answer checked without its question proves which
// answer was delivered and nothing about what it answered, so that check is
// reported as not settled rather than passed.
//
// The rules a reimplementation needs, in full:
//   question_sha256  sha256 of the question's UTF-8 bytes after removing the
//                    whitespace JavaScript's String.prototype.trim removes at
//                    both ends (Unicode White_Space, line terminators and
//                    U+FEFF). Through the OpenAI-compatible endpoint, the
//                    question is the last message with role "user" (its text
//                    parts joined with a line feed), trimmed the same way.
//   answer_sha256    sha256 of the answer's UTF-8 bytes exactly as served.
//   content_sha256   sha256 of the export body's canonical JSON: object keys
//                    sorted by UTF-16 code unit, arrays in order, no
//                    whitespace, strings and numbers written as JSON.stringify
//                    writes them (numbers in their shortest round-trip form).
//                    For any JSON a response can carry, that is the canonical
//                    form RFC 8785 defines.
// The question hash is not salted: anyone can hash a guess and compare, so a
// receipt does not keep its question secret from someone who can guess it.

const HEX64 = /^[0-9a-f]{64}$/;
// The tool names a receipt carries: the agent's analyst tools are camelCase
// (getMarketOverview), its public surface snake_case (get_market_signals).
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_DELIVERY_TOOLS = 16;
const DELIVERY_VERSION = 1;
const ANSWER_KEYS = new Set(["v", "kind", "question_sha256", "answer_sha256", "tools", "tools_incomplete"]);
const EXPORT_KEYS = new Set(["v", "kind", "content_sha256"]);
const sha256Utf8 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// A byte-order mark is something an editor or a shell adds when saving, never
// part of what was served.
const withoutBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// "ok", "malformed", or "newer": a delivery written in a version or a kind
// this verifier does not know, or carrying fields it does not read. Newer is
// not a failure: the issuer signed something this version cannot check, and
// the honest answer is "update and check again", never "forged".
function deliveryShape(d) {
  if (!isObject(d)) return "malformed";
  if (Number.isInteger(d.v) && d.v > DELIVERY_VERSION) return "newer";
  if (d.v !== DELIVERY_VERSION) return "malformed";
  if (d.kind === "answer") {
    const known =
      HEX64.test(d.question_sha256 || "") &&
      HEX64.test(d.answer_sha256 || "") &&
      Array.isArray(d.tools) &&
      d.tools.length <= MAX_DELIVERY_TOOLS &&
      d.tools.every((t) => typeof t === "string" && TOOL_NAME.test(t)) &&
      new Set(d.tools).size === d.tools.length &&
      (d.tools_incomplete === undefined || d.tools_incomplete === true);
    if (!known) return "malformed";
    return Object.keys(d).every((k) => ANSWER_KEYS.has(k)) ? "ok" : "newer";
  }
  if (d.kind === "export") {
    if (!HEX64.test(d.content_sha256 || "")) return "malformed";
    return Object.keys(d).every((k) => EXPORT_KEYS.has(k)) ? "ok" : "newer";
  }
  return typeof d.kind === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(d.kind) ? "newer" : "malformed";
}

// The question as the agent hashed it. A file saved on Windows may carry
// carriage returns the question never had, so that spelling is tried too.
function questionMatches(questionText, expected) {
  const plain = withoutBom(questionText);
  if (sha256Utf8(plain.trim()) === expected) return { match: true, note: null };
  const lf = plain.replace(/\r\n/g, "\n");
  if (lf !== plain && sha256Utf8(lf.trim()) === expected) return { match: true, note: "matched once the file's Windows line endings were read as line feeds" };
  return { match: false, note: null };
}

// The answer text out of a saved response body: the vault's own shape
// (`answer`) or the OpenAI-compatible one (`choices[0].message.content`).
function answerFromBody(json) {
  if (isObject(json) && typeof json.answer === "string") return json.answer;
  const content = isObject(json) && Array.isArray(json.choices) ? json.choices[0]?.message?.content : undefined;
  return typeof content === "string" ? content : null;
}

// bodyText: the saved response body, exactly as received. questionText: the
// question as sent; surrounding whitespace is removed before hashing, as the
// agent does before reading it. Either may be null (not given).
export function checkDelivery(claims, { bodyText = null, questionText = null } = {}) {
  const out = [];
  const add = (label, state, detail) => out.push({ label, state, detail: detail || null });
  const d = claims?.delivery;
  const given = bodyText !== null || questionText !== null;

  if (d === undefined) {
    if (given) {
      add(
        "says what the payment bought",
        "unresolved",
        "this receipt names the payment only (issued before receipts named their delivery), so the text you hold cannot be matched to it"
      );
    }
    return out;
  }
  const shape = deliveryShape(d);
  if (shape === "newer") {
    const v = Number.isInteger(d.v) ? `v${d.v}` : "an unknown version";
    const kind = typeof d.kind === "string" ? `, kind ${JSON.stringify(d.kind)}` : "";
    add(
      "says what the payment bought",
      "unresolved",
      `it is written in a format newer than this verifier reads (${v}${kind}); update and check again: npx vaultbags-cli@latest verify receipt <jwt>`
    );
    return out;
  }
  if (shape === "malformed") {
    add("says what the payment bought", "fail", "its delivery field is malformed");
    return out;
  }

  let json;
  if (bodyText !== null) {
    try {
      json = JSON.parse(withoutBom(bodyText));
    } catch {
      json = undefined;
    }
  }

  if (d.kind === "answer") {
    const incomplete = d.tools_incomplete ? " (the list is incomplete: at least one read could not be named)" : "";
    const read = d.tools.length
      ? `an answer, after reading ${d.tools.length} tool${d.tools.length === 1 ? "" : "s"}${incomplete}: ${d.tools.join(", ")}`
      : d.tools_incomplete
        ? "an answer, after reading tools this receipt could not name"
        : "an answer, without reading any tool";
    add("says what the payment bought", "ok", read);
    if (bodyText !== null) {
      const answer = json === undefined ? null : answerFromBody(json);
      if (answer === null) {
        add(
          "the answer you hold is the one it delivered",
          "fail",
          isObject(json) && !Array.isArray(json.choices) && json.answer === undefined
            ? "the saved body has no answer in it (an export's body is checked against an export's receipt)"
            : "the saved body is not a response with an answer in it"
        );
      } else {
        const match = sha256Utf8(answer) === d.answer_sha256;
        add("the answer you hold is the one it delivered", match ? "ok" : "fail", match ? null : "its sha256 differs from the one the receipt names");
      }
      if (questionText === null) {
        add(
          "the question it answered",
          "unresolved",
          "not checked: without the question as sent (--question=<file>) this shows which answer was delivered, not what it was the answer to"
        );
      }
    }
    if (questionText !== null) {
      const q = questionMatches(questionText, d.question_sha256);
      add("the question you hold is the one it answered", q.match ? "ok" : "fail", q.match ? q.note : "its sha256 differs from the one the receipt names");
    }
    return out;
  }

  add("says what the payment bought", "ok", `an export, sha256 ${d.content_sha256}`);
  if (bodyText !== null) {
    if (json === undefined) {
      add("the export you hold is the one it delivered", "fail", "the saved body is not JSON");
    } else {
      const match = sha256Utf8(canonicalStringify(json)) === d.content_sha256;
      add("the export you hold is the one it delivered", match ? "ok" : "fail", match ? null : "its canonical sha256 differs from the one the receipt names");
    }
  }
  if (questionText !== null) {
    add("the question you hold is the one it answered", "unresolved", "this receipt is for an export, which has no question");
  }
  return out;
}
