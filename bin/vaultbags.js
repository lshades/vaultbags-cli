#!/usr/bin/env node
// vaultbags: read the VaultBags treasury, and check it against the chain.
//
// Every protocol ships a dashboard that asks you to believe it. This ships a
// command that lets you check it: `vaultbags verify claim <tx>` recomputes the
// accounting on your machine and reads the anchor off Solana itself, so the
// verdict never passes through anyone's servers.
//
// It never signs and never accepts a private key. See src/keyguard.js for why
// that refusal is active rather than merely absent.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { refuseSecretArgs, warnSecretEnv, REFUSAL_ADVICE } from "../src/keyguard.js";
import { verifyClaim, verifyAllocation, verifyReport, verifyReserves, verifyLatestDay, latestClosedMonth, VERDICT } from "../src/verify.js";
import { apiGet, apiPost, base, rpc, HttpError, DEFAULT_RPC } from "../src/io.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
);
const V = { version: pkg.version };

// `vaultbags tools | head` closes the pipe while this is still writing, and the
// default reaction to that is a crash report about a broken pipe, which looks
// like the tool failed when it did exactly what was asked. Piping into head,
// less or grep is normal use, so it exits quietly instead.
//
// Both streams, not just stdout: errors go to stderr, so a piped command that
// fails was still crashing on the way out until this covered it too. Nothing
// here forces an exit, for the reason explained at the bottom of this file.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code !== "EPIPE") throw e;
  });
}

// Colour only when a human is watching. Piping into jq or a log should get
// clean text, not escape codes.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
};

const MARK = { ok: c.green("ok"), fail: c.red("FAIL"), pending: c.yellow("pending"), unresolved: c.yellow("unresolved") };

// Machine-readable form of a verdict. Exists so this can sit inside a monitor
// or a CI step: a human reads the lines, a script reads the exit code and this.
// The verdict string is the same token the code uses internally, so a consumer
// never has to parse prose to learn what happened.
function printJson(result) {
  console.log(
    JSON.stringify(
      {
        verdict: result.verdict,
        ok: result.verdict === VERDICT.VERIFIED,
        checks: result.checks.map((c) => ({ label: c.label, state: c.state, detail: c.detail })),
        // Whatever a human is told about an unsettled result, a script is told
        // too. Output modes that disagree about the facts are a trap.
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.extra ? { details: result.extra } : {}),
      },
      null,
      2
    )
  );
  // Exit codes mirror the human path exactly, so switching to --json never
  // changes whether a pipeline passes.
  return result.verdict === VERDICT.VERIFIED ||
    result.verdict === VERDICT.NO_ANCHOR ||
    result.verdict === VERDICT.PARTIAL
    ? 0
    : 1;
}

function printChecks(result) {
  for (const ch of result.checks) {
    console.log(`  ${MARK[ch.state] || ch.state}  ${ch.label}`);
    if (ch.detail) console.log(`        ${c.dim(ch.detail)}`);
  }
  console.log("");
  switch (result.verdict) {
    case VERDICT.VERIFIED:
      console.log(c.green(c.bold("VERIFIED")) + " against the chain, not against our word.");
      return 0;
    case VERDICT.NO_ANCHOR:
      // Deliberately not called verified. The records agree with each other,
      // which is not the same as agreeing with Solana.
      console.log(
        c.yellow(c.bold("CONSISTENT, NOT YET ANCHORED")) +
          " the records agree with each other, but nothing is stamped on-chain to check them against yet."
      );
      return 0;
    case VERDICT.PARTIAL:
      console.log(
        c.yellow(c.bold("PARTLY VERIFIED")) +
          " everything public data can prove held. What it cannot reach is named above, not counted as a pass."
      );
      return 0;
    case VERDICT.UNRESOLVED:
      // Deliberately not a fixed sentence. This verdict covers everything from
      // a throttled endpoint to a figure public data cannot settle, and naming
      // the wrong one sends the reader to fix a problem they do not have. Each
      // check supplies its own reason; this only says what it means.
      console.log(
        c.yellow(c.bold("UNRESOLVED")) +
          " something above could not be settled either way, so it counts as neither pass nor fail."
      );
      if (result.hint) console.log(c.dim("  " + result.hint));
      return 1;
    default:
      console.log(c.red(c.bold("VERIFICATION FAILED")));
      return 1;
  }
}

const fmtUsd = (n) =>
  Number.isFinite(Number(n)) ? `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "n/a";

// --- queries ---------------------------------------------------------------
// Only these are coupled to response shape. Everything else goes through `get`,
// so adding a tool to the agent exposes it here with no release.

async function cmdAllocation() {
  const d = await apiGet("/api/agent/todays-allocation", V);
  console.log(c.bold(`Today's buy, ${d.date || "today"}`));
  console.log(`  gold ${d.weights?.gold}%   SPYx ${d.weights?.spyx}%   USDY ${d.weights?.usdy}%`);
  if (d.band) console.log(c.dim(`  band ${d.band.min}-${d.band.max}% per asset`));
  if (d.rationale) console.log(`\n  ${d.rationale}`);
  if (d.receiptTx) console.log(c.dim(`\n  receipt ${d.receiptTx}`));
  console.log(c.dim(`  verify it: vaultbags verify allocation ${d.date || ""}`.trimEnd()));
  return 0;
}

async function cmdTreasury() {
  const d = await apiGet("/api/agent/treasury-stats", V);
  console.log(c.bold("Treasury"));
  for (const a of d.assets || []) {
    const label = String(a.name || a.symbol || "").replace(/^\$/, "");
    console.log(`  ${label.padEnd(6)} ${fmtUsd(a.valueUsd).padStart(12)}  ${c.dim(String(a.balance ?? ""))}`);
  }
  if (d.totalValueUsd != null) console.log(`  ${"total".padEnd(6)} ${c.bold(fmtUsd(d.totalValueUsd).padStart(12))}`);
  if (d.totalPaidToHoldersUsd != null) console.log(c.dim(`\n  paid to holders ${fmtUsd(d.totalPaidToHoldersUsd)}`));
  if (d.cyclesCount != null) console.log(c.dim(`  cycles ${d.cyclesCount}   holders ${d.holdersCount ?? "?"}`));
  return 0;
}

async function cmdReserves() {
  const d = await apiGet("/api/agent/proof-of-reserves", V);
  const reserves = d.reserves || [];
  console.log(c.bold(`Proof of Reserves  ${fmtUsd(d.totalReservesUsd)}`));
  for (const r of reserves) {
    const label = String(r.name || r.symbol || "").replace(/^\$/, "");
    console.log(`  ${label.padEnd(6)} ${fmtUsd(r.valueUsd).padStart(12)}  ${c.dim(r.mint || "")}`);
  }
  console.log(c.dim("\n  Every mint and wallet here is public. Check any of them on Solscan yourself."));
  return 0;
}

async function cmdBrainVsFlat() {
  const d = await apiGet("/api/agent/brain-vs-flat", V);
  if (!d.available) {
    console.log("Not enough measured history yet.");
    return 0;
  }
  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "n/a");
  const days = d.daysMeasured ?? d.nDays;
  console.log(c.bold(`The daily line vs an even split${days != null ? `, ${days} days` : ""}`));
  console.log(`  brain ${pct(d.brainReturn)}   even ${pct(d.flatReturn)}   edge ${pct(d.edge)}`);
  if (d.hasVerdict === false && d.daysNeededForVerdict) {
    console.log(c.dim(`  Still accumulating; a verdict is held until ${d.daysNeededForVerdict} days.`));
  }
  console.log(c.dim("  Reported win or lose."));
  return 0;
}

async function cmdAsk(question) {
  const { status, json } = await apiPost("/api/agent/ask", { question }, V);
  if (status === 402) {
    console.log(c.yellow("The free allowance for today is used up."));
    console.log(c.dim("  This tool does not pay: it never handles keys. Ask again tomorrow, or use the site."));
    return 1;
  }
  console.log(json?.answer || "(no answer)");
  if (json?.lane) console.log(c.dim(`\n  lane: ${json.lane}`));
  return 0;
}

// --- discovery -------------------------------------------------------------

async function cmdTools() {
  const spec = await apiGet("/api/openapi", V);
  const paths = Object.keys(spec?.paths || {}).filter((p) => p.startsWith("/api/agent/"));
  console.log(c.bold(`${paths.length} tools, read live from the spec`));
  for (const p of paths) {
    const op = spec.paths[p].get || spec.paths[p].post || {};
    const name = p.replace("/api/agent/", "");
    console.log(`  ${name.padEnd(24)} ${c.dim((op.summary || "").slice(0, 70))}`);
  }
  console.log(c.dim("\n  Any of them: vaultbags get <tool> [--param=value]"));
  return 0;
}

async function cmdGet(tool, params) {
  const qs = new URLSearchParams(params).toString();
  const data = await apiGet(`/api/agent/${encodeURIComponent(tool)}${qs ? `?${qs}` : ""}`, V);
  console.log(JSON.stringify(data, null, 2));
  return 0;
}

// verify all: the four checks in one run, for a cron job or a doubter.
//
// Each section renders exactly as its standalone command would, so the output
// teaches the individual commands. The combined verdict is the WORST of the
// four: one failed check fails the run, one unresolved read keeps it from
// claiming success. A summary that averaged instead would be a summary that
// hid things.
async function cmdVerifyAll(render) {
  const sections = [
    ["today's decision", () => verifyAllocation(new Date().toISOString().slice(0, 10), V)],
    ["latest claims day", () => verifyLatestDay(V)],
    [`monthly report ${latestClosedMonth()}`, () => verifyReport(latestClosedMonth(), V)],
    ["reserves", () => verifyReserves(V)],
  ];

  const results = [];
  for (const [name, run] of sections) {
    let result;
    try {
      result = await run();
    } catch (err) {
      // One section erroring must not stop the others: the whole point of
      // `all` is a complete picture, including which parts could not answer.
      result = {
        verdict: VERDICT.UNRESOLVED,
        checks: [{ label: "could not run", state: "unresolved", detail: err?.message || String(err) }],
      };
    }
    results.push({ name, result });
  }

  if (render === printJson) {
    const codes = results.map(({ result }) => printableCode(result.verdict));
    console.log(
      JSON.stringify(
        {
          verdict: worstVerdict(results.map((r) => r.result.verdict)),
          ok: codes.every((c) => c === 0),
          sections: results.map(({ name, result }) => ({
            name,
            verdict: result.verdict,
            checks: result.checks,
            ...(result.hint ? { hint: result.hint } : {}),
          })),
        },
        null,
        2
      )
    );
    return codes.every((c) => c === 0) ? 0 : 1;
  }

  let code = 0;
  for (const { name, result } of results) {
    console.log(c.bold(`
${name}`));
    const sectionCode = printChecks(result);
    if (sectionCode !== 0) code = 1;
  }
  return code;
}

// Exit-code mapping shared with the single commands: verified, not-yet-anchored
// and partial pass; unresolved and failed do not.
function printableCode(verdict) {
  return verdict === VERDICT.VERIFIED || verdict === VERDICT.NO_ANCHOR || verdict === VERDICT.PARTIAL ? 0 : 1;
}

const VERDICT_RANK = [VERDICT.VERIFIED, VERDICT.NO_ANCHOR, VERDICT.PARTIAL, VERDICT.UNRESOLVED, VERDICT.FAILED];
function worstVerdict(verdicts) {
  let worst = VERDICT.VERIFIED;
  for (const v of verdicts) {
    if (VERDICT_RANK.indexOf(v) > VERDICT_RANK.indexOf(worst)) worst = v;
  }
  return worst;
}

// --- entry -----------------------------------------------------------------

function usage() {
  console.log(`vaultbags ${pkg.version}

  Read the VaultBags treasury, and check it against the chain.

${c.bold("Verify")} (recomputed here, anchor read from Solana)
  verify claim <tx>              a holder payout, against the day's on-chain root
  verify allocation [date]       what the agent chose to buy, against its receipt
  verify report <YYYY-MM-01>     a month's closed books, against their receipt
  verify reserves                what the vault says it holds, against the chain
  verify all                     the four checks in one run, worst verdict wins

  --json                         any verify command, as machine-readable output

${c.bold("Read")}
  allocation                     today's buy proportions and why
  treasury                       balances and value
  reserves                       the wallets holding them
  brain-vs-flat                  the daily line vs an even split, win or lose
  ask "<question>"               the agent's free lane

${c.bold("Everything else")}
  tools                          list what the agent exposes, live
  get <tool> [--k=v]             call any of them, raw JSON

${c.bold("Environment")}
  VB_RPC     Solana RPC for the anchor reads (default ${DEFAULT_RPC})
             Point it at your own node if you would rather not trust that one.
  VB_BASE    API base (default https://vaultbags.app)
  NO_COLOR   plain output

  This tool never signs and never accepts a private key.`);
}

async function main() {
  const argv = process.argv.slice(2);

  // Flags are removed before positional arguments are read, so `verify
  // allocation --json` does not mistake the flag for the date. Options are
  // parsed separately below; nothing here needs a value that starts with a dash.
  const words = argv.filter((a) => !a.startsWith("-"));
  const cmd = argv[0];
  const sub = words[1];
  const arg = words[2];
  // A claim signature is legitimately long base58; it is the argument of the
  // core command and must not be mistaken for a secret.
  const signatureArgs = cmd === "verify" && sub === "claim" && arg ? [arg] : [];
  // The refusal runs before anything else, including help, so a mistyped paste
  // is caught by the first thing that reads it.
  const refusal = refuseSecretArgs(argv, { signatureArgs });
  if (refusal.refuse) {
    console.error(c.red(c.bold("Refused.")) + " " + refusal.reason);
    for (const line of REFUSAL_ADVICE) console.error(c.dim("  " + line));
    return 2;
  }

  // A key in the environment is mentioned, not obeyed and not fatal. It was
  // almost certainly put there by another project, and refusing to run a
  // read-only command over it would break the tool for the people most likely
  // to use it while protecting nobody.
  const envWarning = warnSecretEnv(process.env);
  if (envWarning.warn) console.error(c.yellow(envWarning.reason));

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(pkg.version);
    return 0;
  }

  const params = {};
  for (const a of argv) {
    const m = a.match(/^--([A-Za-z0-9_]+)=(.*)$/);
    if (m) params[m[1]] = m[2];
  }

  switch (cmd) {
    case "verify": {
      const render = params.json !== undefined || argv.includes("--json") ? printJson : printChecks;
      if (sub === "claim") {
        if (!arg) return usageError("verify claim needs a transaction signature");
        return render(await verifyClaim(arg, V));
      }
      if (sub === "allocation") {
        const date = arg || new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return usageError("the date must look like 2026-07-27");
        return render(await verifyAllocation(date, V));
      }
      if (sub === "reserves") {
        return render(await verifyReserves(V));
      }
      if (sub === "all") {
        return cmdVerifyAll(render);
      }
      if (sub === "report") {
        if (!arg) return usageError("verify report needs a month, like 2026-06-01");
        return render(await verifyReport(arg, V));
      }
      return usageError(`unknown: verify ${sub || ""}`.trim());
    }
    case "allocation":
      return cmdAllocation();
    case "treasury":
      return cmdTreasury();
    case "reserves":
      return cmdReserves();
    case "brain-vs-flat":
      return cmdBrainVsFlat();
    case "ask": {
      const q = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
      if (!q) return usageError('ask needs a question, in quotes');
      return cmdAsk(q);
    }
    case "tools":
      return cmdTools();
    case "get": {
      if (!sub) return usageError("get needs a tool name; run `vaultbags tools` to list them");
      return cmdGet(sub, params);
    }
    default:
      return usageError(`unknown command: ${cmd}`);
  }
}

function usageError(msg) {
  console.error(`${msg}\n`);
  usage();
  return 2;
}

// The exit code is set, and then the process is left to end on its own.
//
// Calling process.exit() here looked harmless and was not: on Windows, exiting
// while an HTTP connection is still pooled aborts the runtime with a libuv
// assertion, so every failed command ended in a crash report that had nothing
// to do with the failure it was reporting. Measured rather than assumed: the
// natural exit costs about a second, which was the entire reason for forcing
// it. Nothing is gained by hurrying, and correctness is lost.
function finish(code) {
  process.exitCode = code;
}

main()
  .then((code) => finish(code ?? 0))
  .catch((err) => {
    if (err instanceof HttpError && err.status === 429) {
      console.error(c.yellow("Rate limited.") + " Wait a moment and try again.");
      finish(1);
      return;
    }
    // A shape change upstream should say "upgrade" rather than print a stack
    // trace or, worse, garbage that looks like data.
    console.error(c.red("Error:") + " " + (err?.message || String(err)));
    console.error(c.dim("  If this looks like a response-shape problem, upgrade: npm i -g vaultbags-cli@latest"));
    finish(1);
  });
