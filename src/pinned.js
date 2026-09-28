// The two identities a verdict depends on, pinned in this file rather than read
// from vaultbags.app.
//
// An anchor is a memo, and a memo is free text any wallet can write. What makes
// one an anchor is WHO signed it. If the tool asked the API which wallet that
// should be, a dishonest endpoint could name a wallet of its own, stamp a memo
// from it, and the tool would check the stamp against the signer the accused
// chose. So the signer is fixed here, where changing it takes a release anyone
// can read.
//
// The same reasoning covers the liquidity lock. "The lock ran" is read from the
// program's own log line, and that line only means something when the program
// emitting it is the pool program. Any program can print any text.
//
// Both were copied by code, not by hand, when pinned: the treasury from the
// public verification scripts vaultbags.app serves (where it was checked against
// the site's published treasury and against the signer of a real anchor), and
// the pool program from Meteora's own SDK (checked against a real lock
// transaction of the protocol's position, whose logs name it).

// Signs every decision, claims-day, monthly and strategy anchor.
export const TREASURY = "Bd7PmDUuvpGjFvHmoi59YCLGvjsShXrsopebg8kjaDWG";

// Meteora DAMM v2: the pool program that holds the protocol's locked position.
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
