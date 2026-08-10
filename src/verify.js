// The three verifications.
//
// Each returns a list of checks and a verdict. The rule they all follow: a
// verdict of "verified" requires at least one check that did NOT come from
// vaultbags.app. Recomputing over data the operator handed you proves the
// response is internally consistent, which a dishonest operator can fake
// perfectly by returning a self-consistent fabrication. The anchor read from
// Solana is what makes the check independent, so the anchor is part of the
// verdict, never a footnote beside it.
//
// When there is no anchor, the tool says exactly that instead of stretching the
// word "verified" to cover it.

import {
  sha256,
  canonicalStringify,
  foldProof,
  buildRoot,
  decisionPayload,
  monthlyPayload,
  hashFromMemo,
} from "./canonical.js";
import { apiGet, getTransaction, getSignatureStatuses, getMintPrograms, getOwnerBalances, formatUnits } from "./io.js";

export const VERDICT = {
  VERIFIED: "verified",
  FAILED: "failed",
  NO_ANCHOR: "no-anchor",
  UNRESOLVED: "unresolved",
  // What public data supports was checked and held; something else was outside
  // what public data can prove. Deliberately not "verified": stretching that
  // word to cover an unproven remainder is how a verifier stops meaning
  // anything.
  PARTIAL: "partial",
};

const check = (label, state, detail) => ({ label, state, detail: detail || null });

// "0.00292100" -> "0.002921", and "1.000" -> "1". Display only.
const trimZeros = (s) => (s.includes(".") ? s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : s);

// Shared: read the anchoring transaction and confirm it says what the API said
// it says, and that the wallet that must have signed it did.
async function checkAnchor(checks, { receiptTx, expectedHash, expectedMemo, expectedSigner }) {
  let tx;
  try {
    tx = await getTransaction(receiptTx);
  } catch (e) {
    checks.push(check("anchor read from Solana", "unresolved", e.message));
    return VERDICT.UNRESOLVED;
  }
  if (!tx) {
    checks.push(
      check("anchor read from Solana", "unresolved", "this RPC does not have that transaction; try another with VB_RPC")
    );
    return VERDICT.UNRESOLVED;
  }
  if (tx.failed) {
    checks.push(check("anchor transaction succeeded", "fail", "it reverted on-chain"));
    return VERDICT.FAILED;
  }

  const onChainHash = hashFromMemo(tx.memo);
  const hashOk = onChainHash === expectedHash;
  checks.push(
    check(
      "hash in the on-chain memo matches the one computed here",
      hashOk ? "ok" : "fail",
      hashOk ? null : `chain says ${onChainHash || "no hash in memo"}`
    )
  );

  if (expectedMemo) {
    const memoOk = tx.memo === expectedMemo;
    checks.push(
      check("memo matches character for character", memoOk ? "ok" : "fail", memoOk ? null : tx.memo || "(no memo)")
    );
    if (!memoOk) return VERDICT.FAILED;
  }

  if (!expectedSigner) {
    // Silence here would be the dangerous option. A memo is free text that any
    // wallet can write, so an anchor whose author was never identified is
    // weaker than one that was, and printing VERIFIED for both would hide the
    // difference behind the same word.
    checks.push(
      check(
        "the wallet that stamped it could not be identified",
        "unresolved",
        "this response did not publish expectedSigner, so the signature was not checked"
      )
    );
    return hashOk ? VERDICT.PARTIAL : VERDICT.FAILED;
  }

  const signerOk = tx.signers.includes(expectedSigner);
  checks.push(
    check(
      "signed by the treasury that owns it",
      signerOk ? "ok" : "fail",
      signerOk ? expectedSigner : `signed by ${tx.signers.join(", ") || "nobody readable"}`
    )
  );
  if (!signerOk) return VERDICT.FAILED;

  return hashOk ? VERDICT.VERIFIED : VERDICT.FAILED;
}

// ---------------------------------------------------------------------------

export async function verifyClaim(tx, opts) {
  const checks = [];
  const claim = await apiGet(`/api/proof/claim/${encodeURIComponent(tx)}`, opts);
  if (claim?.error || claim?.found === false) {
    return { verdict: VERDICT.FAILED, checks: [check("claim is on record", "fail", claim?.error || claim?.note)] };
  }

  const folded = foldProof(claim.leaf, claim.proof);
  const proofOk = folded === claim.root;
  checks.push(check("your claim's proof folds to the day's root", proofOk ? "ok" : "fail", proofOk ? null : folded));

  // Rebuilding the whole day from the published set is what catches a claim
  // that was quietly dropped from the tree rather than altered inside it.
  const day = await apiGet(`/api/proof/claims/${encodeURIComponent(claim.period)}`, opts);
  const rebuilt = buildRoot(day.leaves || []);
  const rootOk = rebuilt === claim.root;
  checks.push(
    check(
      `the whole day's root, rebuilt here from all ${day.claimCount ?? "?"} claims`,
      rootOk ? "ok" : "fail",
      rootOk ? null : rebuilt
    )
  );

  if (!claim.stamped || !claim.receiptTx) {
    checks.push(check("anchor on-chain", "pending", "this day is not stamped yet; it stamps on the next daily cycle"));
    return { verdict: proofOk && rootOk ? VERDICT.NO_ANCHOR : VERDICT.FAILED, checks, extra: { period: claim.period } };
  }

  // The signer is checked here too, not only for the daily decision. A memo is
  // free text: anyone can stamp any hash from any wallet, so an anchor nobody
  // identified is an anchor that proves nothing.
  const anchor = await checkAnchor(checks, {
    receiptTx: claim.receiptTx,
    expectedHash: claim.root,
    expectedSigner: claim.expectedSigner || null,
  });
  const verdict = proofOk && rootOk ? anchor : VERDICT.FAILED;
  return { verdict, checks, extra: { period: claim.period, receiptTx: claim.receiptTx } };
}

export async function verifyAllocation(date, opts) {
  const checks = [];
  const d = await apiGet(`/api/proof/decision/${encodeURIComponent(date)}`, opts);
  if (d?.error) {
    return { verdict: VERDICT.FAILED, checks: [check("decision is on record", "fail", d.error)] };
  }

  const localHash = sha256(canonicalStringify(decisionPayload(d)));
  if (!d.stamped) {
    checks.push(check("decision is on record", "ok", `${d.date}: gold ${d.weights.gold}% / SPYx ${d.weights.spyx}% / USDY ${d.weights.usdy}%`));
    checks.push(check("anchor on-chain", "pending", "this day predates on-chain stamping, so there is nothing independent to check"));
    return { verdict: VERDICT.NO_ANCHOR, checks, extra: { date: d.date, localHash } };
  }

  const selfOk = localHash === d.storedHash;
  checks.push(
    check("the published decision hashes to the published digest", selfOk ? "ok" : "fail", selfOk ? null : localHash)
  );

  const anchor = await checkAnchor(checks, {
    receiptTx: d.receiptTx,
    expectedHash: localHash,
    expectedMemo: d.memoText,
    expectedSigner: d.expectedSigner,
  });
  return {
    verdict: selfOk ? anchor : VERDICT.FAILED,
    checks,
    extra: { date: d.date, weights: d.weights, receiptTx: d.receiptTx },
  };
}

// Does the vault actually hold what it says it holds?
//
// The other verifications check hashes. This one checks balances: it adds up
// every reserve wallet on Solana and compares the sum with the published total.
//
// Getting the SET of wallets right is the whole difficulty. The headline spans
// every project running on the protocol, not only $VAULT, so checking $VAULT's
// wallets alone finds a shortfall that is not one. A first version did exactly
// that and reported a healthy vault as FAILED, which is the worst thing a
// verification tool can do. The full set is public: the reserve pools and
// supporting wallets come from the proof endpoint, and every project's claim,
// lock and LP wallets come from the projects directory.

// Tolerance for reads taken at different instants: a claim or a distribution can
// land between the API read and the chain read. Small on purpose, so a real
// shortfall stays a shortfall.
const RESERVE_TOLERANCE = 0.01; // 1%

// Every wallet that can hold reserve assets, taken from the custody map that
// the proof endpoint already publishes.
//
// One source, and it has to be this one. An earlier version supplemented it
// from the public projects directory, which lists only projects that have been
// active RECENTLY and hides the quiet ones. The headline total counts every
// integrated project, so checking it against a set that had the quiet ones
// removed left a residual that could never be explained, and the flagship check
// reported UNRESOLVED on a vault that was perfectly fine. The custody map draws
// from the same set as the total it is being compared against, which is the
// only way the two can ever reconcile.
function reserveWallets(proof) {
  const custody = proof?.custody;
  if (!custody) return { wallets: [], complete: false };

  const seen = new Set();
  const out = [];
  const add = (address, role) => {
    if (!address || seen.has(address)) return;
    seen.add(address);
    out.push({ address, role });
  };

  for (const p of custody.vault?.reservePools || []) add(p.address, p.role || "reserve");
  for (const p of custody.vault?.supporting || []) add(p.address, p.role || "supporting");
  // Independent tokens whose creators integrated the protocol. Their holdings
  // are part of the published total, so they are part of what gets checked.
  for (const project of custody.external || []) {
    for (const w of project.wallets || []) add(w.address, `${project.ticker || "project"}:${w.role || "wallet"}`);
  }

  return { wallets: out, complete: true };
}

export async function verifyReserves(opts) {
  const checks = [];
  const d = await apiGet("/api/agent/proof-of-reserves", opts);
  const reserves = d?.reserves || [];
  const { wallets, complete } = reserveWallets(d);

  if (!reserves.length || !wallets.length) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check("reserves are published", "unresolved", "nothing to verify in the response")],
    };
  }
  checks.push(
    check(
      `${wallets.length} reserve wallets across the protocol, read directly from Solana`,
      complete ? "ok" : "unresolved",
      complete ? null : "the custody map was missing, so this wallet set may be incomplete"
    )
  );

  let unresolved = !complete;
  let failed = false;

  // Read each wallet once per token program instead of once per asset. The
  // public endpoint throttles this call per method, and the wallet-by-asset
  // version asked often enough to throttle itself, which surfaced as a healthy
  // vault reporting balances it "could not read".
  const mints = reserves.map((r) => r.mint);
  const programs = await getMintPrograms(mints);
  const onChainByMint = new Map();
  const unreadMints = new Set();
  let anyThrottled = false;

  if (!programs) {
    // Without knowing which program owns each mint there is nothing honest to
    // report: guessing one would read zero for everything under the other.
    for (const m of mints) unreadMints.add(m);
  } else {
    for (const w of wallets) {
      for (const programId of new Set(programs.values())) {
        const { totals, throttled } = await getOwnerBalances(w.address, programId);
        if (!totals) {
          // Only the assets this read covered are unknown. The rest stay
          // answerable, so one refused request does not blank the report.
          if (throttled) anyThrottled = true;
          for (const m of mints) if (programs.get(m) === programId) unreadMints.add(m);
          continue;
        }
        for (const m of mints) {
          if (programs.get(m) !== programId) continue;
          const held = totals.get(m);
          if (!held) continue;
          const prev = onChainByMint.get(m);
          onChainByMint.set(m, {
            raw: (prev?.raw ?? 0n) + held.raw,
            decimals: prev?.decimals ?? held.decimals,
          });
        }
      }
    }
  }

  for (const r of reserves) {
    if (unreadMints.has(r.mint)) {
      unresolved = true;
      // Being rate limited is a fact about the endpoint, not about the vault,
      // and saying which one it was is the difference between "wait a moment"
      // and "something is wrong here".
      checks.push(
        check(
          `${r.name}: balance could not be read from this RPC`,
          "unresolved",
          anyThrottled ? "the endpoint is rate limiting; wait a moment or set VB_RPC to your own" : null
        )
      );
      continue;
    }
    // Shown as the exact amount the chain holds, and compared as a number.
    // The comparison is a tolerance test, so a float is fine there; the printed
    // figure is what a reader will check by hand, so it is not.
    const held = onChainByMint.get(r.mint);
    const shown = held ? formatUnits(held.raw, held.decimals ?? r.decimals) : "0";
    const onChain = Number(shown);

    const published = Number(r.balance) || 0;
    const gap = onChain - published;
    // Trimmed to the asset's own precision. A difference reported as
    // 0.002921410000000013 invites the reader to chase digits that only exist
    // because two floats were subtracted.
    const gapShown = trimZeros(Math.abs(gap).toFixed(held?.decimals ?? r.decimals ?? 9));
    const within = published === 0 ? onChain === 0 : Math.abs(gap) / published <= RESERVE_TOLERANCE;

    if (within || gap > 0) {
      // At or above the headline: nothing is being overstated, which is the
      // claim that matters. Holding more is not an alarm; assets arrive
      // continuously and a headline is a moment in time.
      //
      // When the two numbers differ, say why this still passed. A verification
      // tool that prints two different figures and calls them ok is asking the
      // reader to work out the rule for themselves, and a reader who cannot see
      // the rule cannot tell a tolerated gap from an unnoticed one. Identical
      // figures need no explanation and get none.
      const matches = gapShown === "0";
      const note = matches
        ? null
        : gap > 0
          ? `holding ${gapShown} more than the headline`
          : `short by ${gapShown}, inside the ${(RESERVE_TOLERANCE * 100).toFixed(0)}% tolerance`;
      checks.push(check(`${r.name}: ${shown} on-chain against ${published} published`, "ok", note));
      continue;
    }

    // Short of the headline, against the full published wallet set. There is no
    // longer a category of holder that public data cannot reach, so this is a
    // finding rather than a caveat.
    failed = true;
    checks.push(
      check(
        `${r.name}: ${shown} on-chain against ${published} published`,
        "fail",
        `short by ${gapShown}, past the ${(RESERVE_TOLERANCE * 100).toFixed(0)}% tolerance`
      )
    );
  }

  // The moment the published figures describe. Comparing two chain reads without
  // it is comparing two unnamed instants, which is how a few seconds of drift
  // and a real gap end up looking the same. With it, a difference has somewhere
  // to come from.
  if (Number.isFinite(Number(d.slot))) {
    checks.push(
      check(
        `published figures read at slot ${d.slot}${Number.isFinite(Number(d.accountsRead)) ? ` across ${d.accountsRead} accounts` : ""}`,
        "ok",
        "this reading is later, so small differences above are the chain moving on"
      )
    );
  }

  if (failed) return { verdict: VERDICT.FAILED, checks };
  if (unresolved) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks,
      hint: anyThrottled || unreadMints.size
        ? "The endpoint would not answer every read. Wait a moment, or point VB_RPC at your own."
        : "The custody map did not arrive in full, so the wallet set checked may be incomplete.",
    };
  }
  return { verdict: VERDICT.VERIFIED, checks };
}

export async function verifyReport(period, opts) {
  const checks = [];
  const r = await apiGet(`/api/reports/${encodeURIComponent(period)}`, opts);
  if (r?.error) {
    return { verdict: VERDICT.FAILED, checks: [check("report is on record", "fail", r.error)] };
  }

  // Rebuilt from the named fields rather than hashing the object as received,
  // so a payload padded with an extra key gains nothing. The metrics are taken
  // out of the published payload and the envelope is rebuilt around them here.
  const monthPeriod = r.period ?? period;
  const localHash = sha256(
    canonicalStringify(monthlyPayload({ period: monthPeriod, metrics: r.payload?.metrics ?? null }))
  );
  const storedHash = r.receipt?.hash ?? null;
  const receiptTx = r.receipt?.tx ?? null;

  if (!storedHash || !receiptTx) {
    checks.push(check("books are closed for that month", "ok", monthPeriod));
    checks.push(check("anchor on-chain", "pending", "this month is not stamped yet"));
    return { verdict: VERDICT.NO_ANCHOR, checks, extra: { period: monthPeriod, localHash } };
  }

  const selfOk = localHash === storedHash;
  checks.push(check("the published books hash to the published digest", selfOk ? "ok" : "fail", selfOk ? null : localHash));

  const anchor = await checkAnchor(checks, {
    receiptTx,
    expectedHash: localHash,
    // The memo is published alongside, so it can be compared in full rather
    // than only through the hash it ends with.
    expectedMemo: r.memo ?? null,
    expectedSigner: r.expectedSigner ?? null,
  });
  return { verdict: selfOk ? anchor : VERDICT.FAILED, checks, extra: { period: monthPeriod } };
}


// The most recent stamped day of claims, verified end to end without needing a
// transaction signature in hand: rebuild the day's root from the published
// leaves, compare it with the stamped one, then check the anchor and who
// Did a day's payouts actually land? Asked of YOUR node, not of the protocol.
//
// `verify claim` proves one payout is inside the day's anchored root, and
// `verify allocation` proves a decision matches its receipt. Neither asks the
// question a holder actually cares about: did the transfer go through. A payout
// can sit in a perfectly valid Merkle tree and still name a transaction the
// chain rejected, and no proof in this tool would notice.
//
// So this takes the day's published claim set, pulls the signature out of each
// record, and asks the chain for the status of every one. The protocol reports
// its own count at /api/agent/payout-integrity; this deliberately does not use
// it, because a verifier that accepts the answer it was sent has verified
// nothing. Point VB_RPC at your own node and not one byte of the verdict comes
// from us.
//
// A signature the node does not carry is UNRESOLVED, never a failure. Nodes
// prune history, and reporting "your payout failed" because a node forgot it
// would be the worst kind of false alarm this tool could raise.
export async function verifyPayouts(period, opts) {
  const checks = [];

  let day;
  if (period) {
    day = await apiGet(`/api/proof/claims/${encodeURIComponent(period)}`, opts);
  } else {
    const idx = await apiGet("/api/proof/claims", opts);
    const latest = (idx?.roots || [])[0];
    if (!latest?.period) {
      return {
        verdict: VERDICT.UNRESOLVED,
        checks: [check("a published day exists", "unresolved", "no periods are published yet")],
      };
    }
    day = await apiGet(`/api/proof/claims/${encodeURIComponent(latest.period)}`, opts);
  }

  const leaves = day?.leaves || [];
  const signatures = leaves.map((l) => l?.tx).filter((t) => typeof t === "string" && t.length > 0);

  if (!leaves.length) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check(`day ${day?.period || period}: payouts to check`, "unresolved", "no payouts are published for that day")],
    };
  }
  if (signatures.length !== leaves.length) {
    checks.push(
      check(
        `${leaves.length - signatures.length} of ${leaves.length} records carry no transaction`,
        "unresolved",
        "a record with no signature cannot be checked against anything"
      )
    );
  }

  let statuses;
  try {
    statuses = await getSignatureStatuses(signatures);
  } catch (err) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check("the chain answered", "unresolved", err?.message || String(err))],
    };
  }

  const failed = statuses.filter((st) => st.known && st.failed).length;
  const unknown = statuses.filter((st) => !st.known).length;
  const landed = statuses.length - failed - unknown;

  checks.push(
    check(
      `day ${day.period}: ${landed} of ${signatures.length} payouts confirmed by the chain`,
      failed > 0 ? "fail" : unknown > 0 ? "unresolved" : "ok",
      failed > 0 ? `${failed} recorded as paid but rejected on-chain` : null
    )
  );
  if (unknown > 0) {
    checks.push(
      check(
        `${unknown} not carried by this node`,
        "unresolved",
        "the node has pruned them from its history; this says nothing about the payout"
      )
    );
  }

  const incomplete = signatures.length !== leaves.length;
  const verdict =
    failed > 0
      ? VERDICT.FAILED
      : unknown > 0 || incomplete
        ? VERDICT.UNRESOLVED
        : VERDICT.VERIFIED;

  return { verdict, checks };
}

// The protocol's own liquidity, checked against the chain.
//
// The claim being tested is the one that matters most to anyone deciding
// whether to touch a token: that the liquidity cannot be pulled. Three separate
// things are asked of the chain, and none of them is taken from the API:
//
//   1. every deposit the record names really happened and was accepted
//   2. every lock the record names really RAN, by reading the instruction the
//      transaction executed rather than settling for its existence
//   3. those transactions are signed by the wallet the record says built it
//
// What is NOT proven here is stated rather than glossed: whether the position
// holds withdrawable liquidity RIGHT NOW is a live account read that needs the
// pool program's account layout, which this tool does not carry. That figure is
// reported as the API's, labelled as such, and the verdict is PARTIAL when the
// rest holds. A verifier that quietly folded someone else's assertion into its
// own verdict would be worth less than no verifier.
//
// Lock instructions are read in full, not sampled: a sampled check would let
// exactly the unchecked one be the fabricated one.
const LOCK_INSTRUCTION = "PermanentLockPosition";

// How much remote-supplied work this command will do against YOUR node.
//
// Every transaction read here is named by the API, so the API decides how much
// work your node is asked to do. Today the record names about 150; these sit an
// order of magnitude above that, so an honest record never meets them. A record
// that does is not sampled down to fit: sampling is how the unchecked one gets
// to be the fabricated one. It stops and says so, which is the only answer that
// stays true.
const MAX_SIGNATURES = 5000;
const MAX_LOCK_READS = 500;

export async function verifyLiquidity(opts) {
  const checks = [];

  let record;
  try {
    record = await apiGet("/api/liquidity", opts);
  } catch (err) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check("the liquidity record could be read", "unresolved", err?.message || String(err))],
    };
  }

  if (!record?.available) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [
        check(
          "a complete liquidity record is published",
          "unresolved",
          "the record is rebuilt from the chain on each read and was not available; no partial version is served"
        ),
      ],
    };
  }

  const deposits = Array.isArray(record.deposits) ? record.deposits : [];
  const wallet = typeof record.wallet === "string" ? record.wallet : null;

  if (!deposits.length) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check("deposits to check", "unresolved", "the record names none")],
    };
  }

  // A record that walked only part of the wallet's history describes part of the
  // story, and a total over part of a history reads as a total.
  if (record.complete === false) {
    checks.push(
      check(
        "the record covers the whole history",
        "unresolved",
        "the walk behind it hit its page ceiling, so what follows is a floor rather than a total"
      )
    );
  }

  const addSigs = deposits.map((d) => d?.addTx).filter((t) => typeof t === "string" && t);
  const lockSigs = [...new Set(deposits.map((d) => d?.lockTx).filter((t) => typeof t === "string" && t))];

  if (addSigs.length + lockSigs.length > MAX_SIGNATURES || lockSigs.length > MAX_LOCK_READS) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [
        check(
          `the record names ${addSigs.length + lockSigs.length} transactions, more than this command will read`,
          "unresolved",
          "it is not checked in part: a partial pass over a record this size would report as though it covered all of it"
        ),
      ],
    };
  }

  let statuses;
  try {
    statuses = await getSignatureStatuses([...addSigs, ...lockSigs]);
  } catch (err) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check("the chain answered", "unresolved", err?.message || String(err))],
    };
  }

  const failed = statuses.filter((st) => st.known && st.failed).length;
  const unknown = statuses.filter((st) => !st.known).length;
  const landed = statuses.length - failed - unknown;

  checks.push(
    check(
      `${landed} of ${statuses.length} liquidity transactions confirmed by the chain`,
      failed > 0 ? "fail" : unknown > 0 ? "unresolved" : "ok",
      failed > 0 ? `${failed} named by the record but rejected on-chain` : null
    )
  );
  if (unknown > 0) {
    checks.push(
      check(
        `${unknown} not carried by this node`,
        "unresolved",
        "the node has pruned them from its history; this says nothing about the deposit"
      )
    );
  }

  // Existing is not the same as having run. Read what each lock transaction
  // actually executed.
  let locksRan = 0;
  let lockSignerOk = true;
  let lockReadFailed = 0;
  for (const sig of lockSigs) {
    let tx;
    try {
      tx = await getTransaction(sig);
    } catch {
      lockReadFailed += 1;
      continue;
    }
    if (!tx) {
      lockReadFailed += 1;
      continue;
    }
    if ((tx.instructions || []).includes(LOCK_INSTRUCTION)) locksRan += 1;
    if (wallet && !(tx.signers || []).includes(wallet)) lockSignerOk = false;
  }

  if (lockSigs.length) {
    checks.push(
      check(
        `${locksRan} of ${lockSigs.length} lock transactions executed ${LOCK_INSTRUCTION}`,
        locksRan === lockSigs.length ? "ok" : lockReadFailed > 0 ? "unresolved" : "fail",
        locksRan === lockSigs.length
          ? null
          : lockReadFailed > 0
            ? `${lockReadFailed} could not be read from this node`
            : "a transaction exists but did not run the instruction that makes a position permanent"
      )
    );
    if (wallet) {
      checks.push(
        check(
          `every lock was signed by ${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
          lockSignerOk ? "ok" : "fail",
          lockSignerOk ? null : "a lock the record attributes to that wallet was signed by someone else"
        )
      );
    }
  }

  // Reported, never folded into the verdict: this one is the API's word.
  const allLocked = record?.lock?.allLocked;
  const unlocked = record?.lock?.unlockedLiquidity;
  checks.push(
    check(
      allLocked === true
        ? "the position reports no withdrawable liquidity"
        : "the position's current lock state",
      "note",
      allLocked === true
        ? `unlocked liquidity ${unlocked ?? "0"}, read live from the pool by the API and not re-derived here`
        : "not asserted by this run"
    )
  );

  const anythingUnresolved =
    unknown > 0 || lockReadFailed > 0 || record.complete === false || addSigs.length !== deposits.length;

  const verdict =
    failed > 0 || !lockSignerOk || (lockSigs.length > 0 && locksRan < lockSigs.length && lockReadFailed === 0)
      ? VERDICT.FAILED
      : anythingUnresolved
        ? VERDICT.UNRESOLVED
        : // Everything public data can prove held. What it cannot prove is named
          // above rather than counted as proven.
          VERDICT.PARTIAL;

  return { verdict, checks };
}

// signed it. This is what lets `verify all` cover the claim ledger.
export async function verifyLatestDay(opts) {
  const checks = [];
  const idx = await apiGet("/api/proof/claims", opts);
  const latest = (idx?.roots || [])[0];
  if (!latest?.period) {
    return {
      verdict: VERDICT.UNRESOLVED,
      checks: [check("a stamped day exists", "unresolved", "no stamped periods are published yet")],
    };
  }

  const day = await apiGet(`/api/proof/claims/${encodeURIComponent(latest.period)}`, opts);
  const rebuilt = buildRoot(day.leaves || []);
  const rootOk = rebuilt != null && rebuilt === day.root;
  checks.push(
    check(
      `day ${day.period}: root rebuilt here from all ${day.claimCount ?? "?"} claims`,
      rootOk ? "ok" : "fail",
      rootOk ? null : `rebuilt ${rebuilt}`
    )
  );

  if (!day.stamped || !day.receiptTx) {
    checks.push(check("anchor on-chain", "pending", "this day is not stamped yet"));
    return { verdict: rootOk ? VERDICT.NO_ANCHOR : VERDICT.FAILED, checks, extra: { period: day.period } };
  }

  const anchor = await checkAnchor(checks, {
    receiptTx: day.receiptTx,
    expectedHash: rebuilt,
    expectedSigner: day.expectedSigner ?? null,
  });
  return { verdict: rootOk ? anchor : VERDICT.FAILED, checks, extra: { period: day.period } };
}

// The first day of the previous UTC month: the most recent month whose books
// can already be closed. Computed in UTC on purpose, because the reports are.
export function latestClosedMonth(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return prev.toISOString().slice(0, 10);
}
