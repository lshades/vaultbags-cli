// Remote text is printed without control characters (src/io.js terminalSafe).
//
// An escape sequence in a string the API or the chain returned could move the
// cursor, hide the lines after it, or paint a green VERIFIED this tool never
// printed. The verdict and the exit code never depend on printed text; this
// keeps what a person reads honest.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { terminalSafe } from "../src/io.js";

const ESC = String.fromCharCode(27);
const CSI = String.fromCharCode(0x9b);

test("escape and control sequences are removed", () => {
  assert.equal(terminalSafe(`${ESC}[8mhidden${ESC}[0m`), "[8mhidden[0m");
  assert.equal(terminalSafe(`${CSI}32mVERIFIED`), "32mVERIFIED");
  assert.equal(terminalSafe(`FAIL\r${ESC}[32mVERIFIED`), "FAIL[32mVERIFIED", "a carriage return cannot overwrite the line");
  assert.equal(terminalSafe("a" + String.fromCharCode(7) + "b" + String.fromCharCode(127) + "c"), "abc");
});

test("the Unicode bidirectional controls are removed", () => {
  for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.equal(terminalSafe(`ab${String.fromCharCode(cp)}cd`), "abcd", `U+${cp.toString(16)}`);
  }
});

test("ordinary text, newlines and tabs are kept", () => {
  assert.equal(terminalSafe("line one\nline two\tend"), "line one\nline two\tend");
  assert.equal(terminalSafe("gold 34%   ñ ✓ $VAULT"), "gold 34%   ñ ✓ $VAULT");
  assert.equal(terminalSafe(12.5), "12.5");
  assert.equal(terminalSafe(null), "");
  assert.equal(terminalSafe(undefined), "");
});

test("the pattern is written as escapes, never as the invisible characters themselves", () => {
  // A bidi control typed literally into the source is itself the hazard this
  // guards against: invisible in review, and able to reorder what a reader sees.
  const src = readFileSync(new URL("../src/io.js", import.meta.url), "utf8");
  const hidden = [...src].filter((ch) => {
    const cp = ch.codePointAt(0);
    return cp === 0x061c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
  });
  assert.equal(hidden.length, 0);
});

test("the human printers pass remote values through it", () => {
  const bin = readFileSync(new URL("../bin/vaultbags.js", import.meta.url), "utf8");
  assert.match(bin, /\$\{t\(ch\.label\)\}/);
  assert.match(bin, /c\.dim\(t\(ch\.detail\)\)/);
  assert.match(bin, /json\?\.answer \? t\(json\.answer\)/);
  assert.match(bin, /t\(d\.rationale\)/);
  assert.match(bin, /t\(err\?\.message/);
});
