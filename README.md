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
vaultbags verify report <YYYY-MM-01>   # a month's closed books, against their receipt
vaultbags verify reserves              # what the vault says it holds, against the chain
vaultbags verify payouts [date]        # a day's payouts actually landed, asked of the chain
```

`verify payouts` is the one that asks the question a holder actually cares about. The other checks prove a record is the one anchored on-chain; a payout can sit in a perfectly valid tree and still name a transaction the chain rejected. This takes the day's published claim set, pulls the signature out of every record and asks the chain the status of each. The protocol publishes its own count of this; the command deliberately does not use it, because a verifier that accepts the answer it was handed has verified nothing.

Add `--json` to any of them for machine-readable output with the same exit codes, so this can sit inside a monitor or a CI step.

Each one recomputes the hash locally and then reads the anchoring transaction from Solana, and checks that the treasury signed it. A memo is free text that any wallet can write, so an anchor whose author went unchecked proves that somebody stamped a hash, not that this one did.

`verify reserves` adds up every published reserve wallet, so on the default public RPC it can pause once while the endpoint's rate limit clears. Point `VB_RPC` at your own node and it does not.

The verdicts are deliberately distinct, because they mean different things:

- **VERIFIED** the recomputation matched, and it matched what is stamped on-chain.
- **CONSISTENT, NOT YET ANCHORED** the published records agree with each other, but that day has not been stamped yet. This is not a pass, and it does not pretend to be one: recomputing over data the operator handed you proves the response is internally consistent, which a dishonest operator could fake perfectly.
- **UNRESOLVED** something could not be settled either way, so it counts as neither pass nor fail. Each line says which: an endpoint that would not answer is yours to retry, while a figure held in wallets nobody publishes is simply outside what public data can settle.
- **PARTLY VERIFIED** everything public data can prove held, and something else was outside its reach. This is what you get when an anchor's expected signer is not published: the memo matched, but who stamped it went unchecked, and that is not the same thing.
- **VERIFICATION FAILED** something did not match. That is a finding; please report it.

## Read

```bash
vaultbags allocation      # today's buy proportions and the reasoning
vaultbags treasury        # balances and value
vaultbags reserves        # the wallets holding them
vaultbags brain-vs-flat   # the daily line vs a fixed even split, win or lose
vaultbags ask "how much has been paid to holders?"
```

## Everything else

```bash
vaultbags tools                    # list what the agent exposes, read live from the spec
vaultbags get <tool> [--k=v]       # call any of them, raw JSON
```

`tools` and `get` read the live OpenAPI spec, so a capability added to the agent is available here with no release. Only the pretty-printed commands above are coupled to response shapes.

## It never signs, and never accepts a key

There is no command here that needs one, and the refusal is active rather than merely absent: paste something that looks like a private key or a seed phrase and it stops and tells you why.

That is not about protecting this tool, which cannot sign anything regardless. It is about the habit. A CLI that quietly swallows a pasted key teaches people that pasting keys into terminals is normal, and that habit is what produces the next drained wallet.

A key already sitting in your environment is a different case, and it gets a warning rather than a refusal. It was almost certainly put there by another project, nothing here reads it, and refusing to run a read-only command over it would break the tool on exactly the machines most likely to run it while protecting nobody.

If you need to move funds or claim, do it in your wallet at [vaultbags.app](https://vaultbags.app).

## Don't trust this tool either

The trust-critical logic lives in one short file, [`src/canonical.js`](src/canonical.js), deliberately copied rather than imported from VaultBags: a verifier that used the operator's own library to check the operator's own numbers would be asking the accused to mark their own exam. Read it in one sitting, or reimplement it in any language.

The anchor is read from a public Solana RPC by default. Point it at one you trust:

```bash
VB_RPC=https://your-rpc vaultbags verify claim <tx>
```

If this tool and vaultbags.app ever disagree, that disagreement is the finding.

There are also two standalone scripts with no install at all, [verify-claim.mjs](https://vaultbags.app/verify-claim.mjs) and [verify-decision.mjs](https://vaultbags.app/verify-decision.mjs). Nothing published to npm can match a dependency-free file you can read in one sitting, so those stay; this complements them.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `VB_RPC` | `https://api.mainnet-beta.solana.com` | Solana RPC used for anchor reads |
| `VB_BASE` | `https://vaultbags.app` | API base |
| `NO_COLOR` | unset | plain output |

MIT
