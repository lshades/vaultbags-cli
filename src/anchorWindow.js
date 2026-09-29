// When a stamp may land to count as the record's own. PURE (no IO), unit-tested
// by test/anchor.test.mjs.
//
// A memo carrying exactly the right text, signed by the treasury, still proves
// nothing about the past if it was written later: that is a backfill, and ruling
// a backfill out is what anchoring is for. So a stamp is proof only if it landed
// at the time. These are the same windows the VaultBags API applies to its own
// anchors (lib/claimAnchorCore), measured by the protocol on its whole history
// (2026-09-29): every daily decision and strategy memo landed on the day it
// governs (the latest 5.9 hours after midnight UTC), every claims root after its
// day ended, every monthly report after its month closed.
//
// Unix seconds throughout. A window is { notBefore, notAfter?, span }.

const dayStart = (utcDate) => {
  if (typeof utcDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) return NaN;
  return Math.floor(Date.parse(`${utcDate}T00:00:00Z`) / 1000);
};

// A decision (the day's allocation, or a strategy's) governs the day it names,
// so it must be stamped during that day.
export function sameDayWindow(utcDate) {
  const start = dayStart(utcDate);
  return Number.isFinite(start) ? { notBefore: start, notAfter: start + 86400, span: "on the day it decides" } : null;
}

// A day's claims root closes the day, so it can only be stamped after it.
export function afterDayWindow(utcDate) {
  const start = dayStart(utcDate);
  return Number.isFinite(start) ? { notBefore: start + 86400, span: "after the day it closes" } : null;
}

// A month's books close the month, so they can only be stamped after it.
export function afterMonthWindow(periodFirstDay) {
  const start = dayStart(periodFirstDay);
  if (!Number.isFinite(start)) return null;
  const d = new Date(start * 1000);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return { notBefore: next, span: "after the month it closes" };
}

// { state: "ok" | "fail" | "unresolved", detail }. A landing time the RPC did
// not return, or a record whose date cannot be read, leaves the question open:
// never verified, and never a failure the chain did not show.
export function landedInWindow(blockTime, window) {
  if (!window) return { state: "unresolved", detail: "the record's date could not be read, so there is no window to check" };
  if (!Number.isFinite(blockTime)) return { state: "unresolved", detail: "this RPC did not return when the transaction landed" };
  const at = new Date(blockTime * 1000).toISOString().replace(".000Z", "Z");
  const outside =
    (Number.isFinite(window.notBefore) && blockTime < window.notBefore) ||
    (Number.isFinite(window.notAfter) && blockTime >= window.notAfter);
  return outside
    ? { state: "fail", detail: `landed ${at}, which is not ${window.span}: a later stamp is a backfill, not proof` }
    : { state: "ok", detail: `landed ${at}, ${window.span}` };
}
