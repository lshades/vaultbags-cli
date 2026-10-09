// The text of a file the caller saved (a response body, a question), decoded
// from its bytes. Pure, no IO, tested in test/saved-file.test.mjs.
//
// UTF-8, or UTF-16 when the file starts with that byte-order mark, which is
// what Windows PowerShell 5 writes with `>` or Out-File. Bytes that are
// neither are refused rather than decoded into a text nobody saved, which
// would only ever fail the comparison for a reason no one could see.

export function decodeSavedFile(buf) {
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return { ok: true, text: new TextDecoder("utf-16le", { fatal: true }).decode(buf.subarray(2)) };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const body = Buffer.from(buf.subarray(2));
      if (body.length % 2 !== 0) return { ok: false, reason: "is not UTF-8 or UTF-16 text" };
      body.swap16();
      return { ok: true, text: new TextDecoder("utf-16le", { fatal: true }).decode(body) };
    }
    // A UTF-8 byte-order mark is dropped by the decoder.
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(buf) };
  } catch {
    return { ok: false, reason: "is not UTF-8 or UTF-16 text" };
  }
}
