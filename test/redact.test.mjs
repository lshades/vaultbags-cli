// Redaction of long opaque values.
//
// The signature argument has to be accepted as typed, because a transaction
// signature and a 64-byte secret key are the same length in base58 and cannot
// be told apart by looking. That makes the OUTPUT the last line of defence: a
// key pasted there by mistake must not be printed back at full length, from
// where it would reach shell history, logs and screenshots.

import test from "node:test";
import assert from "node:assert/strict";
import { redact, HttpError } from "../src/io.js";

test("a long value is never printed in full", () => {
  const secretish = "5".repeat(88);
  const out = redact(secretish);
  assert.ok(!out.includes(secretish), "the whole value must not survive");
  assert.ok(out.length < 24, "and what is left must be short");
  assert.match(out, /^555555…555555$/);
});

test("short values are left readable", () => {
  // A date, a period, a ticker: shortening these would only make errors worse.
  for (const v of ["2026-07-27", "2026-06-01", "GOLD", ""]) {
    assert.equal(redact(v), v);
  }
});

test("an http error never carries the full argument", () => {
  const secretish = "5".repeat(88);
  const e = new HttpError(404, `/api/proof/claim/${secretish}`);
  assert.ok(!e.message.includes(secretish), "the error message must not echo it");
  assert.match(e.message, /responded 404/);
  assert.equal(e.status, 404);
});

test("redaction survives a non-string", () => {
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
  assert.equal(redact(12345), "12345");
});
