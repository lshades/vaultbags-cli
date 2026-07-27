// The guard that refuses secrets.
//
// Two failure modes, and they are not symmetric. A false positive costs one
// clear message and a re-run. A false negative means a private key was accepted
// by a tool, written into shell history, and possibly echoed back in an error.
// The tests are weighted accordingly: broad on what must be refused, and precise
// about the one long base58 value that must NOT be, since a claim signature is
// the argument of the core command.

import test from "node:test";
import assert from "node:assert/strict";
import { refuseSecretArgs, warnSecretEnv, looksLikeSecret, looksLikeMnemonic } from "../src/keyguard.js";

// Structurally shaped like the real things, generated for this test, never used.
const FAKE_BASE58_KEY = "5".repeat(88);
const FAKE_HEX_KEY = "a1b2c3d4".repeat(8);
const FAKE_BYTE_ARRAY = "[" + Array.from({ length: 64 }, (_, i) => (i * 3) % 256).join(",") + "]";
const FAKE_MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const CLAIM_SIGNATURE = "4agYGZ" + "b".repeat(82); // long base58, but a signature

test("refuses a base58 secret key", () => {
  assert.equal(looksLikeSecret(FAKE_BASE58_KEY), true);
  assert.equal(refuseSecretArgs(["verify", "claim", FAKE_BASE58_KEY]).refuse, true);
});

test("refuses a hex secret key, with or without 0x", () => {
  assert.equal(looksLikeSecret(FAKE_HEX_KEY), true);
  assert.equal(looksLikeSecret("0x" + FAKE_HEX_KEY), true);
});

test("refuses a keypair byte array", () => {
  assert.equal(looksLikeSecret(FAKE_BYTE_ARRAY), true);
});

test("refuses a seed phrase, and names it as one", () => {
  assert.equal(looksLikeMnemonic(FAKE_MNEMONIC), true);
  const r = refuseSecretArgs(["ask", FAKE_MNEMONIC]);
  assert.equal(r.refuse, true);
  assert.match(r.reason, /seed phrase/i);
});

test("refuses every mnemonic length BIP39 uses", () => {
  const w = FAKE_MNEMONIC.split(" ");
  for (const n of [12, 15, 18, 21, 24]) {
    const phrase = Array.from({ length: n }, (_, i) => w[i % w.length]).join(" ");
    assert.equal(looksLikeMnemonic(phrase), true, `${n} words should be refused`);
  }
});

test("refuses a flag that offers a key, whatever its value", () => {
  for (const flag of ["--private-key=x", "--privateKey=x", "--keypair=./id.json", "--mnemonic=x", "--seed-phrase=x", "--secret_key=x"]) {
    assert.equal(refuseSecretArgs([flag]).refuse, true, `${flag} should be refused`);
  }
});

test("refuses a key passed as a flag value", () => {
  assert.equal(refuseSecretArgs(["get", "treasury", `--wallet=${FAKE_BASE58_KEY}`]).refuse, true);
});

test("warns about a key in the environment, naming the variable", () => {
  // A warning, not a refusal: the variable belongs to some other project, this
  // tool never reads it, and refusing to run would break a read-only command on
  // exactly the machines most likely to run it.
  const r = warnSecretEnv({ SOLANA_PRIVATE_KEY: FAKE_BASE58_KEY });
  assert.equal(r.warn, true);
  assert.match(r.reason, /SOLANA_PRIVATE_KEY/);
});

test("an empty secret variable says nothing", () => {
  // Unset-but-declared is common in shells and means nothing was offered.
  assert.equal(warnSecretEnv({ WALLET_PRIVATE_KEY: "" }).warn, false);
});

test("the environment never blocks a command", () => {
  // The guard for the environment has no way to stop anything: it reports, and
  // the decision to keep going is not its to make.
  assert.equal(warnSecretEnv({ SOLANA_PRIVATE_KEY: FAKE_BASE58_KEY }).refuse, undefined);
});

test("a signature or a hash passed by name is not mistaken for a key", () => {
  // Both are 64 bytes, exactly like a secret key, and both are things this tool
  // exists to look up. Refusing them would make its own commands unusable.
  for (const flag of [`--tx=${CLAIM_SIGNATURE}`, `--signature=${CLAIM_SIGNATURE}`, `--hash=${FAKE_HEX_KEY}`, `--root=${FAKE_HEX_KEY}`]) {
    assert.equal(refuseSecretArgs(["get", "verify-claim", flag]).refuse, false, flag);
  }
});

test("naming a flag does not launder a secret into an unrelated field", () => {
  // The allowance is for fields that legitimately carry 64 bytes. A wallet is
  // 32, so an over-long one stays suspicious.
  assert.equal(refuseSecretArgs(["get", "x", `--wallet=${FAKE_BASE58_KEY}`]).refuse, true);
  assert.equal(refuseSecretArgs(["get", "x", `--mint=${FAKE_BASE58_KEY}`]).refuse, true);
});

test("a refused seed phrase admits it might have been a question", () => {
  // A dozen short lowercase words with no punctuation is also the shape of a
  // sentence, and without the wordlist the two cannot be told apart. Refusing
  // is right; accusing someone of pasting a key is not.
  const r = refuseSecretArgs(["ask", "explain what the vault bought today and why gold fell hard again"]);
  assert.equal(r.refuse, true);
  assert.match(r.reason, /if it was a question/i);
});

test("a claim signature is NOT refused when it is the signature argument", () => {
  // The whole tool would be unusable if its core argument tripped the guard.
  const r = refuseSecretArgs(["verify", "claim", CLAIM_SIGNATURE], { signatureArgs: [CLAIM_SIGNATURE] });
  assert.equal(r.refuse, false);
});

test("the same value IS refused where a signature has no business being", () => {
  // Nothing marks it as a signature here, so a long base58 blob is treated as
  // what it more likely is: something that should never have been typed.
  assert.equal(refuseSecretArgs(["ask", CLAIM_SIGNATURE]).refuse, true);
});

test("ordinary arguments pass untouched", () => {
  for (const argv of [
    ["verify", "allocation", "2026-07-27"],
    ["verify", "report", "2026-06-01"],
    ["treasury"],
    ["get", "rwa", "--query=HOODx"],
    ["ask", "what did the vault buy today"],
    ["tools"],
  ]) {
    assert.equal(refuseSecretArgs(argv).refuse, false, argv.join(" "));
  }
});

test("a mint address is not mistaken for a key", () => {
  // Mints are base58 but well short of a 64-byte secret.
  assert.equal(looksLikeSecret("4iCRYJHvwUcAJHrfEBQZ8mkPzRhcvW3rXk9AWuNPuMPS"), false);
});

test("non-strings never trip it", () => {
  assert.equal(looksLikeSecret(null), false);
  assert.equal(looksLikeSecret(undefined), false);
  assert.equal(looksLikeSecret(12345), false);
  assert.equal(refuseSecretArgs([null, undefined, 5]).refuse, false);
});
