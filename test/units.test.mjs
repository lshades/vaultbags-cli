// Reading a balance exactly, including the asset whose stored integer is not
// its balance. These are the numbers the tool's whole claim rests on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, formatUnits } from "../src/io.js";

test("a decimal amount becomes the exact integer of its smallest unit", () => {
  assert.equal(parseUnits("1", 6), 1000000n);
  assert.equal(parseUnits("0.000001", 6), 1n);
  assert.equal(parseUnits("240.214992", 6), 240214992n);
  assert.equal(parseUnits("0", 8), 0n);
  assert.equal(parseUnits("0.37603864", 8), 37603864n);
});

test("a scaled balance is taken as given, not recomputed from the stored integer", () => {
  // The case that matters: the chain reports 91044 stored and 0.00091564 held,
  // because a multiplier sits between them. Reading the balance keeps the
  // holding whole; recomputing it from the integer loses part of it.
  const held = parseUnits("0.00091564", 8);
  assert.equal(held, 91564n);
  assert.notEqual(held, 91044n, "the stored integer is not the balance");
  assert.equal(formatUnits(held, 8), "0.00091564");
});

test("adding balances stays exact, with no digits arithmetic invented", () => {
  const a = parseUnits("0.1", 8);
  const b = parseUnits("0.2", 8);
  assert.equal(formatUnits(a + b, 8), "0.3", "0.1 + 0.2 is 0.3 here, as it is on the ledger");
});

test("anything it cannot read exactly is refused, never guessed", () => {
  for (const bad of ["", " ", "abc", "-1", "1.2.3", "1e5", null, undefined, {}]) {
    assert.equal(parseUnits(bad, 6), null, `${JSON.stringify(bad)} must be refused`);
  }
  // More precision than the token has is a refusal too: rounding it would print
  // an amount the chain does not hold.
  assert.equal(parseUnits("0.1234567", 6), null);
});

test("formatting drops trailing zeros without dropping value", () => {
  assert.equal(formatUnits(1000000n, 6), "1");
  assert.equal(formatUnits(1100000n, 6), "1.1");
  assert.equal(formatUnits(1n, 6), "0.000001");
  assert.equal(formatUnits(0n, 6), "0");
});

test("parse and format are inverses across the amounts these assets use", () => {
  for (const [amount, decimals] of [["0.061249", 6], ["0.3764021", 8], ["240.424758", 6], ["0.00091564", 8]]) {
    assert.equal(formatUnits(parseUnits(amount, decimals), decimals), amount);
  }
});
