// The status line's cache on disk (src/statusline.js decides what goes in it).
//
// One small JSON file per (API base, wallet) pair, named by a hash so the file
// name does not carry the address, in a folder of the user's own under the
// system's temp folder. On a shared machine that folder is the point: the temp
// folder is open to every account, so the cache lives in one that only this
// user can open (created 0700, and refused if it is a link, someone else's, or
// open to others), and a file is written to a fresh name created exclusively
// (it cannot be a link someone left there) and renamed, so a reader never sees
// half a file. A lock file keeps one refresh at a time: Claude Code may run the
// status line many times a minute, and each run that finds the cache old would
// otherwise start its own. The lock carries a token of its own refresh, which
// is the only one that removes it; one older than a minute is a refresh that
// died, and is taken over.

import { randomBytes, createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const LOCK_STALE_MS = 60 * 1000;
export const CACHE_VERSION = 2;

// This user's own folder. A uid where the platform has one; elsewhere (Windows,
// where the temp folder is already the user's own) a hash of the user name.
function userTag() {
  if (typeof process.getuid === "function") return String(process.getuid());
  let name = "";
  try {
    name = userInfo().username || "";
  } catch {
    /* no user name: the tag below still separates nothing worse than before */
  }
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}
export const cacheDir = () => join(tmpdir(), `vaultbags-statusline-${userTag()}`);

/** The folder, made if missing; null when it is not one only this user can open. */
export function ownDir() {
  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (typeof process.getuid === "function") {
      if (st.uid !== process.getuid()) return null;
      if ((st.mode & 0o077) !== 0) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

const file = (dir, key) => join(dir, `${key}.json`);
const lockFile = (dir, key) => join(dir, `${key}.lock`);

export function readCache(key) {
  const dir = ownDir();
  if (!dir) return null;
  try {
    const parsed = JSON.parse(readFileSync(file(dir, key), "utf8"));
    return parsed && parsed.v === CACHE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

// Written to a name nobody could have prepared ("wx": created here or not at
// all), then renamed over the cache. A write that fails leaves no stray file.
export function writeCache(key, cache) {
  const dir = ownDir();
  if (!dir) return false;
  const tmp = `${file(dir, key)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, JSON.stringify({ ...cache, v: CACHE_VERSION }));
    closeSync(fd);
    fd = null;
    renameSync(tmp, file(dir, key));
    return true;
  } catch {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* closing what is already broken */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
    return false;
  }
}

export function isLocked(key, nowMs = Date.now()) {
  const dir = ownDir();
  if (!dir) return true;
  try {
    return nowMs - statSync(lockFile(dir, key)).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Takes the refresh lock: its token, or null when a live refresh holds it. */
export function tryLock(key, nowMs = Date.now()) {
  const dir = ownDir();
  if (!dir) return null;
  const path = lockFile(dir, key);
  const token = randomBytes(12).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (e) {
      if (e?.code !== "EEXIST") return null;
      if (isLocked(key, nowMs)) return null;
      // A lock a dead refresh left. Two runs taking it over at once can both
      // end up refreshing, which costs one extra read; the cache is written
      // whole either way, and each removes only its own lock afterwards.
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Releases the lock if it is still this refresh's own. */
export function releaseLock(key, token) {
  const dir = ownDir();
  if (!dir || !token) return;
  try {
    if (readFileSync(lockFile(dir, key), "utf8") === token) unlinkSync(lockFile(dir, key));
  } catch {
    /* already gone */
  }
}
