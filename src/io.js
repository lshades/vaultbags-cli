// The two places data comes from: vaultbags.app, and Solana.
//
// The split matters. Anything read from vaultbags.app is a CLAIM. Anything read
// from the chain is EVIDENCE. Every verdict this tool prints rests on the second
// kind, and the code keeps them in separate functions so it stays obvious which
// is which.
//
// The RPC is user-choosable for exactly that reason: a verification that reads
// the anchor through the operator's own node is not independent of the operator.

export const DEFAULT_BASE = "https://vaultbags.app";
// A public endpoint so the tool works with no configuration. Anyone who does not
// want to trust it points VB_RPC at their own.
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export const base = () => (process.env.VB_BASE || DEFAULT_BASE).replace(/\/+$/, "");
export const rpc = () => process.env.VB_RPC || DEFAULT_RPC;

// A named identity in the User-Agent so the traffic this tool generates is
// observable on our side instead of looking like anonymous scraping.
function headers(version) {
  return {
    accept: "application/json",
    "user-agent": `vaultbags-cli/${version} (+https://github.com/lshades/vaultbags-cli)`,
  };
}

// Long opaque values are shortened before they can reach a message.
//
// A transaction signature and a 64-byte secret key are the same length in
// base58 and cannot be told apart by looking, so the signature argument has to
// be accepted as given. If someone pastes a key there by mistake, the last
// thing that should happen is this tool printing it back at full length into
// the terminal and from there into logs and screenshots. Printing the ends is
// enough to recognise what was passed; the middle earns nothing.
export function redact(value) {
  const s = String(value ?? "");
  return s.length > 24 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}

const redactPath = (path) => String(path ?? "").split("/").map(redact).join("/");

export class HttpError extends Error {
  constructor(status, path) {
    super(`${redactPath(path)} responded ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

// Nothing waits forever. A server that accepts a connection and then goes quiet
// would otherwise hang the command with no output and no way to tell whether it
// is working, which is how a CLI earns a reputation for being broken.
const TIMEOUT_MS = 20_000;
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);

// A dead socket reads as a stack trace unless it is named, and "fetch failed"
// tells a reader nothing about which of the two endpoints went quiet.
function asReadable(error, what) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new Error(`${what} did not answer within ${TIMEOUT_MS / 1000}s`);
  }
  return new Error(`${what} could not be reached: ${error?.message || error}`);
}

// One read from the API. 429 is surfaced as itself rather than as a generic
// failure, because "you are being rate limited" is advice and "something went
// wrong" is not.
export async function apiGet(path, { version = "0.0.0" } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, { headers: headers(version), signal: timeout() });
  } catch (e) {
    throw asReadable(e, base());
  }
  if (res.status === 429) throw new HttpError(429, path);
  if (!res.ok) throw new HttpError(res.status, path);
  // A body that is not JSON means something other than the API answered: a
  // captive portal, a proxy, an error page. Saying so beats a parser error.
  try {
    return await res.json();
  } catch {
    throw new Error(`${redactPath(path)} did not return JSON; is VB_BASE pointing at the API?`);
  }
}

export async function apiPost(path, body, { version = "0.0.0" } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { ...headers(version), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeout(),
    });
  } catch (e) {
    throw asReadable(e, base());
  }
  if (res.status === 429) throw new HttpError(429, path);
  // 402 carries the payment terms and is a legitimate answer, not a failure.
  if (!res.ok && res.status !== 402) throw new HttpError(res.status, path);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// A GET whose 402 is the answer: a paid resource called bare describes its
// terms in that status, so it is returned with the body rather than thrown.
export async function apiGetTerms(path, { version = "0.0.0" } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, { headers: headers(version), signal: timeout() });
  } catch (e) {
    throw asReadable(e, base());
  }
  if (res.status === 429) throw new HttpError(429, path);
  if (!res.ok && res.status !== 402) throw new HttpError(res.status, path);
  return { status: res.status, json: await res.json().catch(() => null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One RPC call, retried while the failure still looks temporary.
//
// Retrying invents nothing: it gives the same question another chance to be
// answered, and when the answer never comes the caller still reports that it
// could not be read. Only transport failures qualify, meaning a throw, a 429 or
// a 5xx. An endpoint that answers with an error object HAS answered, and asking
// again would just be arguing with it.
//
// The delays are measured, not guessed. The default endpoint starts refusing at
// around a dozen calls of one method and stays that way for roughly fifteen
// seconds. Two short retries cover a passing blip; the long one exists because
// checking the reserves honestly means reading every published wallet, and on a
// shared endpoint that is more calls than it will allow in one window.
//
// Waiting it out is the right trade for THIS command. The alternative was to
// check fewer wallets, which would produce a faster answer to a weaker
// question. The wait is adaptive, so it only ever happens on an endpoint that
// actually refuses: a private RPC never reaches it.
const RETRY_DELAYS = [400, 1600, 15_000];

// Said once, on stderr, so a pause of that length is explained rather than
// looking like a hang. Not on stdout: piping to jq must stay clean.
let throttleNoticeShown = false;
function noticeThrottleWait(seconds) {
  if (throttleNoticeShown) return;
  throttleNoticeShown = true;
  process.stderr.write(
    `  the public RPC is rate limiting; waiting ~${seconds}s for it to clear (VB_RPC=<your node> skips this)\n`
  );
}

// Throttling can arrive as an HTTP status or inside a 200 body, so both are
// treated as the same fact.
const isThrottled = (status, body) => status === 429 || body?.error?.code === 429;

async function rpcCall(method, params) {
  let throttled = false;
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    if (i > 0) {
      const delay = RETRY_DELAYS[i - 1];
      // The long wait is only ever spent on a throttle. A plain network blip
      // retries twice and gives up quickly, as it should.
      if (delay >= 10_000) {
        if (!throttled) break;
        noticeThrottleWait(Math.round(delay / 1000));
      }
      await sleep(delay);
    }
    let res;
    try {
      res = await fetch(rpc(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: timeout(),
      });
    } catch {
      continue; // network-level failure or timeout: worth another attempt
    }
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (isThrottled(res.status, body)) {
      throttled = true;
      continue;
    }
    if (res.ok) return { body, status: res.status, throttled: false };
    if (res.status < 500) return { body: null, status: res.status, throttled: false };
  }
  return { body: null, status: throttled ? 429 : 0, throttled };
}

// Which token program each mint belongs to, read from the mint account itself.
//
// Not assumed. The vault holds mints under BOTH programs (the classic one and
// Token-2022), and hardcoding either would silently read zero for the other
// half, which here would look like a shortfall rather than like a bug.
//
// One cheap account read answers it for every mint at once.
export async function getMintPrograms(mints) {
  const { body } = await rpcCall("getMultipleAccounts", [mints, { encoding: "jsonParsed" }]);
  if (!body || body.error) return null;
  const values = body.result?.value || [];
  const out = new Map();
  mints.forEach((mint, i) => {
    const owner = values[i]?.owner;
    if (owner) out.set(mint, owner);
  });
  return out.size === mints.length ? out : null;
}

// Every token balance one wallet holds under one token program, as a map of
// mint to amount.
//
// Asked per wallet rather than per wallet AND mint on purpose. The public
// Solana endpoint rate-limits this particular call hard, per method, and
// checking a handful of wallets against a handful of assets multiplies into
// enough requests to get itself throttled. Reading a wallet once returns every
// mint it holds, so the same answer costs a third of the requests.
//
// Every account of a mint is summed, because a wallet can hold more than one
// and reading only the first would understate it.
//
// Returns { totals } when answered, and { throttled } when not. A missing
// totals map must never be read as a balance of zero: "could not read" and
// "holds nothing" are different facts, and confusing them is how a healthy
// vault gets reported as short. Whether the refusal was a throttle travels with
// it, because that is a wait-and-retry, not a reason to doubt the vault.
export async function getOwnerBalances(owner, programId) {
  const { body, throttled } = await rpcCall("getTokenAccountsByOwner", [
    owner,
    { programId },
    { encoding: "jsonParsed" },
  ]);
  if (!body || body.error) return { throttled };
  const totals = new Map();
  for (const a of body.result?.value || []) {
    const info = a?.account?.data?.parsed?.info;
    const mint = info?.mint;
    // Summed in the token's own whole units, never as decimals. Adding
    // 0.039645 to itself in binary floating point invents digits that were
    // never on the chain, and a tool whose whole claim is exactness must not
    // print an amount the ledger does not contain.
    const decimals = info?.tokenAmount?.decimals;
    // uiAmountString, not `amount`. For most tokens they say the same thing,
    // and for one of the assets held here they do not: it carries the
    // scaled-ui-amount extension, where a multiplier sits between the stored
    // integer and the balance, and grows as the underlying pays out. Reading
    // the integer and dividing by the decimals therefore reports a real holding
    // as smaller than it is, which on a reserves check looks like the vault is
    // short. The chain already does that arithmetic and hands back the answer;
    // taking it is both simpler and correct for every extension, including ones
    // that do not exist yet.
    //
    // Still summed as whole units, never as decimals: the string is parsed into
    // the token's own smallest unit and added there, because a tool whose whole
    // claim is exactness must not print an amount that floating point invented.
    const ui = info?.tokenAmount?.uiAmountString;
    if (!mint || typeof ui !== "string" || !Number.isInteger(decimals)) continue;
    const scaled = parseUnits(ui, decimals);
    if (scaled === null) continue;
    const prev = totals.get(mint);
    totals.set(mint, {
      raw: (prev?.raw ?? 0n) + scaled,
      decimals: prev?.decimals ?? decimals,
    });
  }
  return { totals };
}

// A decimal amount as the exact integer of the token's smallest unit. Returns
// null on anything it cannot read exactly, so a malformed answer is skipped
// rather than guessed at.
export function parseUnits(str, decimals) {
  const s = String(str ?? "").trim();
  if (!/^\d+(\.\d*)?$/.test(s)) return null;
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > d) return null; // more precision than the token has
  try {
    return BigInt(whole + frac.padEnd(d, "0"));
  } catch {
    return null;
  }
}

// A whole-unit amount as the exact decimal it is, with no trailing noise.
export function formatUnits(raw, decimals) {
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
  const s = raw.toString().padStart(d + 1, "0");
  const int = s.slice(0, s.length - d);
  const frac = d ? s.slice(s.length - d).replace(/0+$/, "") : "";
  return frac ? `${int}.${frac}` : int;
}

// Read a transaction from Solana: the memo it carries and who signed it.
// Returns null when the RPC does not have it, which is different from a
// transaction that exists and failed (that comes back with failed: true).
// The status of many signatures in one call, from the caller's own node.
//
// getTransaction pulls a whole transaction to answer a yes-or-no question, and
// checking a day of payouts one at a time that way is both slow and enough
// calls to trip a shared endpoint. This asks the one thing that matters.
//
// searchTransactionHistory is required: a node's recent-status cache only
// covers the last couple of days, and payouts older than that would come back
// absent, which reads as "missing" when it means "not in the cache".
//
// null in the returned array means the node does not carry that signature. That
// is a fact about the node, never a failed payout, and every caller must keep
// the two apart.
export async function getSignatureStatuses(signatures) {
  if (!signatures.length) return [];
  const out = [];
  for (let i = 0; i < signatures.length; i += 200) {
    const batch = signatures.slice(i, i + 200);
    const { body, status } = await rpcCall("getSignatureStatuses", [batch, { searchTransactionHistory: true }]);
    if (!body) throw new Error(status ? `RPC responded ${status}` : "RPC could not be reached");
    if (body.error) throw new Error(`RPC: ${body.error.message}`);
    const values = body.result?.value;
    if (!Array.isArray(values) || values.length !== batch.length) {
      throw new Error("RPC returned a malformed status list");
    }
    for (const v of values) {
      out.push(v == null ? { known: false, failed: false } : { known: true, failed: !!v.err });
    }
  }
  return out;
}

export async function getTransaction(signature) {
  const { body, status } = await rpcCall("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!body) throw new Error(status ? `RPC responded ${status}` : "RPC could not be reached");
  if (body.error) throw new Error(`RPC: ${body.error.message}`);
  const tx = body.result;
  if (!tx) return null;

  const logs = tx.meta?.logMessages || [];
  let memo = null;
  for (const line of logs) {
    const m = line.match(/Memo \(len \d+\): "(.*)"$/);
    if (m) memo = m[1];
  }
  if (memo === null) {
    for (const ix of tx.transaction?.message?.instructions || []) {
      if (ix.program === "spl-memo" && typeof ix.parsed === "string") memo = ix.parsed;
    }
  }
  const signers = (tx.transaction?.message?.accountKeys || [])
    .filter((k) => k.signer)
    .map((k) => k.pubkey);

  // The names of the instructions the transaction actually RAN, as the programs
  // themselves logged them. A caller checking that a specific operation happened
  // needs this: that a signature exists and succeeded says only that SOMETHING
  // succeeded, which is a far weaker claim than the one usually made about it.
  const instructions = logs
    .map((line) => (typeof line === "string" ? line.match(/Instruction: (\w+)/) : null))
    .filter(Boolean)
    .map((m) => m[1]);

  return {
    memo,
    signers,
    instructions,
    failed: !!tx.meta?.err,
    slot: tx.slot ?? null,
    tokenDeltas: tokenDeltasFromMeta(tx.meta),
  };
}

// How much of each token each owner gained or lost in a transaction, read from
// the balances the chain recorded before and after it ran. Summed per (owner,
// mint), because one owner can hold a token in more than one account and a
// payment is judged by what the owner received, not by which account took it.
// An account created by the transaction has no "before" and counts from zero.
// Amounts stay exact (BigInt in, decimal string out); a balance the node did
// not fully describe is left out rather than guessed.
export function tokenDeltasFromMeta(meta) {
  const pre = new Map();
  const post = new Map();
  const decimals = new Map();
  const fold = (into, list) => {
    for (const b of Array.isArray(list) ? list : []) {
      const amount = b?.uiTokenAmount?.amount;
      if (typeof b?.owner !== "string" || typeof b?.mint !== "string") continue;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
      const key = `${b.owner}|${b.mint}`;
      into.set(key, (into.get(key) ?? 0n) + BigInt(amount));
      if (Number.isInteger(b.uiTokenAmount.decimals)) decimals.set(key, b.uiTokenAmount.decimals);
    }
  };
  fold(pre, meta?.preTokenBalances);
  fold(post, meta?.postTokenBalances);
  const keys = new Set([...pre.keys(), ...post.keys()]);
  return [...keys].map((key) => {
    const [owner, mint] = key.split("|");
    return {
      owner,
      mint,
      delta: ((post.get(key) ?? 0n) - (pre.get(key) ?? 0n)).toString(),
      decimals: decimals.get(key) ?? null,
    };
  });
}
