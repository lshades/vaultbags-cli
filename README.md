# vaultbags-cli

Every protocol ships a dashboard that asks you to believe it. This ships a command that lets you check it.

```bash
npx vaultbags-cli verify claim <tx>
```

It recomputes VaultBags' accounting on your machine and reads the anchor off Solana itself, so the verdict never passes through anyone's servers.

VaultBags is an autonomous treasury on Solana: trading fees are converted into tokenized gold, the S&P 500 and US Treasuries, which holders claim directly. Every payout is hashed into a daily Merkle root, and every daily buy decision is hashed and stamped on-chain before the vault acts on it. This tool checks both.

## Install

```bash
npx vaultbags-cli <command>        # one-off, nothing installed
npm i -g vaultbags-cli             # then just: vaultbags <command>
```

Node 18 or newer. No configuration, no account, no key.

## Verify

```bash
vaultbags verify claim <tx>            # a holder payout, against the day's on-chain root
vaultbags verify allocation [date]     # what the agent chose to buy, against its receipt
vaultbags verify strategy <id> [date]  # one strategy's daily decision, against its receipt
vaultbags verify report <YYYY-MM-01>   # a month's closed books, against their receipt
vaultbags verify reserves              # what the vault says it holds, against the chain
vaultbags verify payouts [date]        # a day's payouts actually landed, asked of the chain
vaultbags verify liquidity             # the protocol's own liquidity was added and locked on-chain
vaultbags verify receipt <jwt>         # a paid call's signed receipt, then the payment it names, on-chain
vaultbags verify receipt <jwt> --body=response.json --question=question.txt
                                       # ...and that the answer you saved is the one it delivered
```

`verify payouts` is the one that asks the question a holder actually cares about. The other checks prove a record is the one anchored on-chain; a payout can sit in a perfectly valid tree and still name a transaction the chain rejected. This takes the day's published claim set, pulls the signature out of every record and asks the chain the status of each. The protocol publishes its own count of this; the command deliberately does not use it, because a verifier that accepts the answer it was handed has verified nothing.

`verify liquidity` answers the question asked of every token: whether the people behind it can pull the floor out. It takes the protocol's published liquidity record, and asks the chain about every transaction in it: that each deposit happened and was accepted, that in each lock the pool program itself RAN the instruction that makes a position permanent (read from the runtime's call stack in the logs, because any program or memo can print the instruction's name), and that all of them were signed by the wallet the record names. It comes back partly-verified on purpose. Whether the position holds withdrawable liquidity at this instant is a live account read that needs the pool program's layout, which this tool does not carry, so that one figure is shown as the protocol's own word, with the time the protocol says it read the position, and is deliberately not folded into the verdict. A verifier that counted someone else's assertion as its own pass would be worth less than no verifier.

`verify receipt` is for the paying side. Every response the paid lane settles on-chain carries an `X-X402-Receipt` header: a signed token naming the transaction, the payer, the amount, the destination wallet, the asset and the resource, with a unique id and an expiry. The command checks the signature against the key the issuer publishes at `/.well-known/jwks.json` (RS256 only; `alg: none` and HMAC are refused before any key is read), holds the claims to their own rules, and then asks the chain whether the transfer the receipt names landed where it says, for at least the amount it says, signed by the payer it says. The signature proves who issued the receipt; the chain proves the payment happened. It is the second that makes the verdict independent, so a receipt whose transaction this node cannot see comes back unresolved, not verified. The destination is also compared with the wallet the vault advertises live in its payment terms; when those cannot be read, the verdict is partial and says so. A receipt past its expiry (they are issued for an hour) is still checked in full, signature and payment, and comes back partly verified rather than failed: it was issued and the chain still says whether the payment happened, but a lapsed receipt no longer stands as a live proof, so it never reads as verified.

A receipt also names what the payment bought. For an answer: the sha256 of the question as the agent read it (surrounding whitespace removed), the sha256 of the answer exactly as served, and the tools whose results the agent read before answering. For an export (the ledger, the live registry batch): the sha256 of the served JSON body, canonicalized (keys sorted recursively, arrays in order), so whitespace and key order do not matter. Save the response body (`curl -o response.json ...`; the OpenAI-compatible endpoint's `choices[0].message.content` is read too) and pass it with `--body=`; pass the question you sent, in a file, with `--question=`. Each one that differs by a single character fails the verdict. An answer checked without its question comes back partly verified: it shows which answer was delivered, not what it was the answer to; a question checked without the answer, likewise. A saved body is only spoken for when it reads one way: one that carries an answer in two places (both `answer` and `choices`), more or fewer than one choice, or the same key written twice in one object fails the check instead of being resolved by picking a reading. Files are read as UTF-8, or as the UTF-16 that Windows PowerShell writes with `>`; a question saved with Windows line endings is matched too, and the result says so. A file that is a private key or a seed phrase is refused, like one typed as an argument, and so is an option the command does not know or an argument it does not read, so a mistyped `--body` or a file name typed without its option cannot leave the body silently unchecked. If the tool list was cut short, the receipt says it is incomplete rather than passing for whole. A receipt issued before receipts named their delivery cannot be matched to any text, and says so; one written in a newer format than this version reads comes back unresolved, with the command to update. What this proves is that the text is the one the vault delivered and signed for, next to the payment; whether the answer is right is a different question. The question's hash is not salted, so anyone who can guess a question can confirm the guess against a receipt.

For a reimplementation, the exact rules: `question_sha256` is the sha256 of the question's UTF-8 bytes with the whitespace JavaScript's `String.prototype.trim` removes taken off both ends (through the OpenAI-compatible endpoint, the question is the last `user` message, its text parts joined with a line feed); `answer_sha256` is the sha256 of the answer's UTF-8 bytes as served; `content_sha256` is the sha256 of the export's canonical JSON (keys sorted by UTF-16 code unit, arrays in order, no whitespace, strings and numbers written as `JSON.stringify` writes them), which for any JSON a response carries is the canonical form of RFC 8785.

Add `--json` to any of them for machine-readable output with the same exit codes, so this can sit inside a monitor or a CI step. It holds when a command cannot run too: a verify command that could not finish prints an unresolved verdict with the reason, and any other command prints `ok: false` with the error (and the HTTP status, when there was one).

Exit codes: `0` verified, `1` failed, `2` usage error or a refused argument, `3` not settled either way (not anchored yet, partly verified, or a read that could not complete). Only `0` means verified, so a script can rely on it.

Each one recomputes the record locally, rebuilds the exact memo that record implies (for a claims day: the date, the number of claims and the root; for a decision: the date, the weights and the hash), and then reads the anchoring transaction from Solana: it must have succeeded, carry that memo character for character, be signed by the treasury, and have landed at the time: a decision on the day it governs, a day's claim root after that day, a month's books after that month. The right memo stamped later is a backfill, which is what an anchor exists to rule out, so it fails; a landing time the RPC does not return leaves the verdict unresolved. The treasury is pinned in [`src/pinned.js`](src/pinned.js), not read from the API. A memo is free text that any wallet can write, so an anchor whose author the accused got to name would prove nothing; if the API names a different signer, that disagreement is itself a failure. The record must also be the one asked for: a valid proof for some other claim, or another day's decision, fails.

`verify reserves` adds up every published reserve wallet, so on the default public RPC it can pause once while the endpoint's rate limit clears. Point `VB_RPC` at your own node and it does not. It compares stored units, which is what the vault publishes. One of the assets applies a growing display multiplier over what it stores, so a wallet shows slightly more of it than the stored figure; the check says so on that line rather than comparing the displayed amount, which would read the chain as richer than it is.

The verdicts are deliberately distinct, because they mean different things:

- **VERIFIED** the recomputation matched, and it matched what is stamped on-chain.
- **CONSISTENT, NOT YET ANCHORED** the published records agree with each other, but that day has not been stamped yet. This is not a pass, and it does not pretend to be one: recomputing over data the operator handed you proves the response is internally consistent, which a dishonest operator could fake perfectly.
- **UNRESOLVED** something could not be settled either way, so it counts as neither pass nor fail. Each line says which: an endpoint that would not answer is yours to retry, while a figure held in wallets nobody publishes is simply outside what public data can settle.
- **PARTLY VERIFIED** everything public data can prove held, and something else was outside its reach. `verify liquidity` always ends here (the position's live state is the protocol's word), and so does `verify receipt` when the vault's payment terms cannot be read to compare the destination, when the receipt has expired, when an answer is checked without its question, or when its delivery is written in a format newer than the installed version reads.
- **VERIFICATION FAILED** something did not match. That is a finding; please report it.

## Read

```bash
vaultbags allocation      # today's buy proportions and the reasoning
vaultbags treasury        # balances and value
vaultbags reserves        # the wallets holding them
vaultbags brain-vs-flat   # the daily line vs a fixed even split, win or lose
vaultbags ask "how much has been paid to holders?"
```

## Status line

One line about your vault, for Claude Code's status line or a shell prompt:

```
VaultBags | to claim: 0.0007 g gold, 0.0001 SPY shares, 0.0995 USDY ($0.30) | vault $1,208.28 | buying 30/35/35 today (UTC) | next purchase 44% queued | next run in 4m
```

What the wallet has waiting to be claimed, in real units (grams of gold, SPY shares, USDY), the vault's total, today's buy (by the UTC day), how close the next purchase is and when the agent runs next. Without a wallet it shows the vault alone. The wallet is a public address; nothing here needs or accepts a key.

```bash
npm i -g vaultbags-cli
vaultbags statusline --wallet=<your address>     # or set VB_WALLET
```

In Claude Code, add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "vaultbags statusline --wallet=<your address>",
    "refreshInterval": 60
  }
}
```

It prints from a local cache and refreshes that cache in the background, so the bar never waits on the network: the vault's figures are read at most every five minutes and the wallet's at most every fifteen (the public claim preview allows 200 reads a day per IP, shared by everything on the same network), a read that fails waits the same before it is tried again, and a refused one an hour. A figure that could not be read is left out, never shown as zero, and a line read more than an hour ago says when. The cache lives in a folder of your own under the system's temp folder (or, if another account holds that name, under your runtime or `~/.cache` folder) and keeps a hash of the address, not the address. On a shared machine, prefer `VB_WALLET` (in Claude Code, the `env` block of the same settings file) to `--wallet=`: a command line is visible to every account on the machine, an environment is not. The background refresh always gets the address through its environment. `refreshInterval` keeps the countdown current while a session is idle. Installing it globally matters here: measured on one machine, a run took about 70 ms installed and 1.1 to 1.5 s through `npx`, which resolves the package every time.

## Everything else

```bash
vaultbags tools                    # list what the agent exposes, read live from the spec
vaultbags get <tool> [--k=v]       # call any of them, raw JSON
```

`tools` and `get` read the live OpenAPI spec, so a capability added to the agent is available here with no release. Only the pretty-printed commands above are coupled to response shapes.

## It never signs, and never accepts a key

There is no command here that needs one, and the refusal is active rather than merely absent: paste something that looks like a private key or a seed phrase and it stops and tells you why.

That is not about protecting this tool, which cannot sign anything regardless. It is about the habit. A CLI that quietly swallows a pasted key teaches people that pasting keys into terminals is normal, and that habit is what produces the next drained wallet.

One argument has a key's shape by design: a strategy key is 64 hex characters, exactly what a 32-byte private key looks like written in hex. `verify strategy` and `get strategy --strategy=` accept one only when it is on the public list of strategies, which the tool reads first with a request that carries nothing you typed. Anything not on that list is refused like any other key and never sent, and a preset name (`classic`, `growth`, `hard-money`, `income`) always works.

A key already sitting in your environment is a different case, and it gets a warning rather than a refusal. It was almost certainly put there by another project, nothing here reads it, and refusing to run a read-only command over it would break the tool on exactly the machines most likely to run it while protecting nobody.

If you need to move funds or claim, do it in your wallet at [vaultbags.app](https://vaultbags.app).

## Don't trust this tool either

The trust-critical logic lives in one short file, [`src/canonical.js`](src/canonical.js), deliberately copied rather than imported from VaultBags: a verifier that used the operator's own library to check the operator's own numbers would be asking the accused to mark their own exam. Read it in one sitting, or reimplement it in any language. The two identities a verdict depends on, the treasury that signs anchors and the pool program that locks liquidity, are fixed in [`src/pinned.js`](src/pinned.js), where changing them takes a release anyone can read.

The anchor is read from a public Solana RPC by default. Point it at one you trust:

```bash
VB_RPC=https://your-rpc vaultbags verify claim <tx>
```

If this tool and vaultbags.app ever disagree, that disagreement is the finding.

There are also three standalone scripts with no install at all, [verify-claim.mjs](https://vaultbags.app/verify-claim.mjs), [verify-decision.mjs](https://vaultbags.app/verify-decision.mjs) and [verify-report.mjs](https://vaultbags.app/verify-report.mjs), which apply the same rules (pinned signer, exact recomputed memo, exit `0` only when verified). Nothing published to npm can match a dependency-free file you can read in one sitting, so those stay; this complements them.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `VB_RPC` | `https://api.mainnet-beta.solana.com` | Solana RPC used for anchor reads |
| `VB_BASE` | `https://vaultbags.app` | API base |
| `NO_COLOR` | unset | plain output |

MIT
