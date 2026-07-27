// Refuse anything that looks like a secret. PURE (no IO), unit-simmed by
// test/keyguard.test.mjs.
//
// This tool never signs and never accepts a private key: not by flag, not by
// environment variable, not by file. Not implementing signing would already be
// enough to make it harmless, so this guard is not about protecting the tool.
// It is about the habit.
//
// A CLI that quietly accepts a pasted key teaches people that pasting keys into
// terminals is normal, and that habit is what produces the next drained wallet.
// When that happens near a project's name, the project wears it. So when a
// secret appears in the arguments, the answer is a refusal that says why, not a
// silent ignore.
//
// Detection is deliberately generous. A false positive costs one clear message
// and a re-run; a false negative means a secret was accepted, echoed into shell
// history, and possibly printed back in an error. The costs are not comparable.

// Base58 without the ambiguous characters, in the length range Solana secret
// keys land in. A 64-byte secret key encodes to about 87-88 characters; the
// range starts lower so a truncated or re-encoded paste is still caught.
const BASE58_SECRET = /^[1-9A-HJ-NP-Za-km-z]{80,120}$/;
// A 64-byte key as hex, with or without the 0x prefix.
const HEX_SECRET = /^(0x)?[0-9a-fA-F]{64,128}$/;
// A JSON byte array, which is how Solana keypair files are stored on disk.
const BYTE_ARRAY = /^\s*\[\s*\d{1,3}\s*(,\s*\d{1,3}\s*){31,}\]\s*$/;

// The BIP39 English wordlist is 2048 words; carrying it here would be a
// dependency and a distraction. A mnemonic is recognised by shape instead:
// several lowercase alphabetic words in the counts BIP39 actually uses.
const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);

export function looksLikeMnemonic(value) {
  if (typeof value !== "string") return false;
  const words = value.trim().toLowerCase().split(/\s+/);
  if (!MNEMONIC_LENGTHS.has(words.length)) return false;
  return words.every((w) => /^[a-z]{3,8}$/.test(w));
}

export function looksLikeSecret(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  if (looksLikeMnemonic(v)) return true;
  if (BYTE_ARRAY.test(v)) return true;
  // A transaction signature is also base58 and around this length, so the
  // check is scoped to values that are NOT being used as a signature argument.
  // The caller decides that; see refuseSecretArgs.
  if (BASE58_SECRET.test(v)) return true;
  if (HEX_SECRET.test(v)) return true;
  return false;
}

// Flags whose NAME alone says a secret is being offered, whatever the value is.
const SECRET_FLAG = /^--?(private[-_]?key|secret[-_]?key|keypair|mnemonic|seed([-_]?phrase)?|wallet[-_]?key)(=|$)/i;

// Environment variables that would be an attempt to hand this tool a key.
const SECRET_ENV = /(PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|SEED_PHRASE)/i;

// Flags whose NAME says the value is a public 64-byte identifier, which is the
// exact shape a secret key also has. A transaction signature and a sha256 root
// are things this tool exists to look up, so refusing them would make its own
// commands unusable. Deliberately narrow: a wallet or a mint is 32 bytes and
// never reaches the length that trips the guard, so neither is listed, and an
// over-long value in one of those stays suspicious.
const PUBLIC_ID_FLAG = /^--?(tx|txid|signature|sig|hash|root)(=|$)/i;

// Values that are legitimately long base58 and must NOT be refused: a claim's
// transaction signature is the core argument of the core command. The caller
// marks which positions are signatures so the guard can tell "the thing you are
// verifying" from "a secret you should never have typed".
export function refuseSecretArgs(argv = [], { signatureArgs = [] } = {}) {
  const allowed = new Set(signatureArgs);

  for (const raw of argv) {
    if (typeof raw !== "string") continue;

    if (SECRET_FLAG.test(raw)) {
      return {
        refuse: true,
        reason:
          "That flag offers a private key. This tool never accepts one, and never signs anything.",
      };
    }

    // --flag=value: judge the value on its own.
    const eq = raw.indexOf("=");
    const value = raw.startsWith("-") && eq > -1 ? raw.slice(eq + 1) : raw;
    if (allowed.has(value)) continue;
    if (PUBLIC_ID_FLAG.test(raw)) continue;
    if (looksLikeSecret(value)) {
      return {
        refuse: true,
        reason: looksLikeMnemonic(value)
          ? // A question can trip this: a dozen short lowercase words with no
            // punctuation is also the shape of a seed phrase, and the two cannot
            // be told apart without the wordlist. So the message covers both
            // readings rather than accusing someone of pasting a key.
            "That looks like a seed phrase. This tool never accepts one, and never signs anything. If it was a question, rephrase it or add punctuation."
          : "That looks like a private key. This tool never accepts one, and never signs anything.",
      };
    }
  }
  return { refuse: false };
}

// A key sitting in the environment is worth SAYING something about, and not
// worth refusing to run over.
//
// The distinction is who offered what. An argument is something the user typed
// at this tool, so it gets refused. An environment variable is something that
// was already there, usually belonging to another project entirely, and this
// tool never reads it: nothing here touches process.env beyond VB_BASE, VB_RPC
// and NO_COLOR. Blocking on it would protect nobody while making a read-only
// command unusable on any machine that does Solana work, which is most of the
// machines that would run this.
export function warnSecretEnv(env = {}) {
  for (const name of Object.keys(env)) {
    if (SECRET_ENV.test(name) && String(env[name] || "").trim()) {
      return {
        warn: true,
        reason: `Heads up: ${name} is set in this environment. This tool never reads it, and never signs anything.`,
      };
    }
  }
  return { warn: false };
}

// The advice printed after any refusal. Says where the secret should go instead
// of leaving someone stuck, and tells them to treat the pasted one as burned,
// because a value that reached a shell is in the history whether or not this
// tool read it.
export const REFUSAL_ADVICE = [
  "This tool only reads public data and verifies it against the chain. It has no command that needs a key.",
  "If you meant to move funds or claim, do it in your wallet at https://vaultbags.app.",
  "If you did paste a real key or seed phrase just now, treat it as compromised: it is in your shell history. Move the funds to a new wallet.",
];
