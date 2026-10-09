// A saved response or question, read the way it was saved; a key saved to a
// file refused like one typed; and an option the verifier does not know
// refused instead of ignored.
//
// Run: node --test test/saved-file.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSavedFile } from "../src/savedFile.js";
import { looksLikeSecretFile } from "../src/keyguard.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vaultbags.js");
const TEXT = `{"answer":"Gold 38%, ${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f4c8)}"}`;

test("UTF-8, with or without its byte-order mark", () => {
  assert.deepEqual(decodeSavedFile(Buffer.from(TEXT, "utf8")), { ok: true, text: TEXT });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, "utf8")]);
  assert.deepEqual(decodeSavedFile(bom), { ok: true, text: TEXT });
});

test("UTF-16 as PowerShell writes it, in either byte order", () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, "utf16le")]);
  assert.deepEqual(decodeSavedFile(le), { ok: true, text: TEXT });
  const be = Buffer.from(TEXT, "utf16le");
  be.swap16();
  assert.deepEqual(decodeSavedFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), { ok: true, text: TEXT });
});

test("bytes that are not text are refused, never guessed", () => {
  assert.equal(decodeSavedFile(Buffer.from([0x7b, 0xc3, 0x28, 0x7d])).ok, false);
  assert.equal(decodeSavedFile(Buffer.from([0xfe, 0xff, 0x00])).ok, false);
  assert.equal(decodeSavedFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x00, 0xd8])])).ok, false);
});

// Synthetic shapes built at run time; none is a real key or phrase.
const keypairFile = `[${Array.from({ length: 64 }, (_, i) => (i * 7) % 256).join(",")}]`;
const base58Key = "1".repeat(44) + "z".repeat(44);
const hexKey = "ab".repeat(32);
const phrase = Array.from({ length: 12 }, () => "ability").join(" ");

test("a file that is a key or a seed phrase is recognised as one", () => {
  for (const secret of [keypairFile, `${keypairFile}\n`, base58Key, hexKey, phrase, `  ${phrase}\r\n`]) {
    assert.equal(looksLikeSecretFile(secret), true, secret.slice(0, 20));
  }
});

test("a saved answer or question is not mistaken for one", () => {
  for (const text of [TEXT, "What did the vault buy today, and why?", `{"answer":"${phrase} is what the guide said"}`, "x".repeat(5000), ""]) {
    assert.equal(looksLikeSecretFile(text), false, text.slice(0, 20));
  }
});

// The binary itself, offline: each case is refused before any request.
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, VB_BASE: "http://127.0.0.1:9", NO_COLOR: "1" } });
const JWT = "aaaa.bbbb.cccc";

test("an option verify does not know is refused, not ignored", () => {
  for (const args of [["verify", "receipt", JWT, "--bdy=response.json"], ["verify", "receipt", JWT, "--answer=x"], ["verify", "claim", "x", "--body=a.json"], ["verify", "reserves", "--rpc=x"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /unknown option --/);
  }
});

test("a key saved to a file and passed as the body or the question is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-saved-"));
  try {
    for (const [name, content] of [["id.json", keypairFile], ["q.txt", phrase]]) {
      const path = join(dir, name);
      writeFileSync(path, content);
      for (const flag of ["--body", "--question"]) {
        const r = run("verify", "receipt", JWT, `${flag}=${path}`);
        assert.equal(r.status, 2, `${flag} ${name}`);
        assert.match(r.stderr, /Refused\./);
        assert.ok(!r.stderr.includes(content.slice(0, 12)), "the file's content is never echoed");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
