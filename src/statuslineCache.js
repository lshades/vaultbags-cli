// The status line's cache on disk (src/statusline.js decides what goes in it).
//
// One small JSON file per (API base, wallet) pair under the system's temp
// folder, named by a hash so the file name does not carry the address. Written
// to a temporary name and renamed, so a reader never sees half a file. A lock
// file keeps one refresh at a time: Claude Code may run the status line many
// times a minute, and each run that finds the cache old would otherwise start
// its own. A lock older than a minute is a refresh that died, and is taken over.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOCK_STALE_MS = 60 * 1000;
const dir = () => join(tmpdir(), "vaultbags-statusline");
const file = (key) => join(dir(), `${key}.json`);
const lockFile = (key) => join(dir(), `${key}.lock`);

export function readCache(key) {
  try {
    const parsed = JSON.parse(readFileSync(file(key), "utf8"));
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCache(key, cache) {
  mkdirSync(dir(), { recursive: true });
  const tmp = `${file(key)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file(key));
}

export function isLocked(key, nowMs = Date.now()) {
  try {
    return nowMs - statSync(lockFile(key)).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Takes the refresh lock, or returns false when a live refresh holds it. */
export function tryLock(key, nowMs = Date.now()) {
  mkdirSync(dir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockFile(key), "wx"));
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") return false;
      if (isLocked(key, nowMs)) return false;
      try {
        unlinkSync(lockFile(key));
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(key) {
  try {
    unlinkSync(lockFile(key));
  } catch {
    /* already gone */
  }
}
