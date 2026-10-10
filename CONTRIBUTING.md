# Contributing

PRs are welcome. Open an issue first for anything larger than a bug fix, so the
design conversation happens before the code exists.

## Getting set up

```bash
pnpm install
cp .env.example .env.local   # fill in what you have; everything is optional except
                             # NEXT_PUBLIC_PROGRAM_ID and ATTESTATION_SECRET
pnpm dev
```

`ISSUER_PRIVATE_KEY` is the JSON contents of a keypair file:

```bash
solana-keygen new --no-bip39-passphrase -o .keys/issuer.json
```

`ATTESTATION_SECRET` needs at least 32 bytes of key material:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Never commit `.env.local`, `.keys/`, or any keypair — `.gitignore` covers them.

## The gate a PR has to pass

```bash
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint .
pnpm test          # vitest run
pnpm build         # next build
```

The Rust program has its own gate, and it runs on the host target:

```bash
cargo fmt -p proof_of_skill -- --check
cargo clippy -p proof_of_skill --all-targets -- -D warnings
cargo test -p proof_of_skill
```

## The SBF build does not run on Windows

`anchor build`, `anchor test`, and a deploy from a Windows host will not work: the
rustc inside platform-tools is an `x86_64-pc-windows-msvc` build, so host build
scripts need `link.exe` and the MSVC CRT. This is a missing toolchain, **not** a
permissions problem — enabling Developer Mode does not fix it. Build and test the
program on Linux (or macOS); `.github/workflows/anchor.yml` runs exactly that on
every pull request, and publishes the `.so` and IDL as artifacts.

Host `cargo test` pins discriminators, account byte layout, `INIT_SPACE`, sighashes
and PDA derivations against vectors computed independently in TypeScript. Those tests
prove the **wire format**, not rejection behaviour — only `anchor test` against a real
validator exercises `require!` and account constraints. Do not treat a green host run
as evidence that a constraint works.

## Conventions this repo keeps

- **Errors are typed results, not exceptions, at every boundary.** Anything that reads
  untrusted input (a request body, RPC bytes, an upstream model response) returns
  `{ ok: true; data } | { ok: false; error }`. Throw only where a caller cannot
  meaningfully recover.
- **Nothing in `lib/**` reads `process.env` at import time.** `next build` evaluates
  route modules with an empty environment, so validating at import would freeze the
  build machine's config into runtime. Read env inside a handler, or resolve a value
  lazily on first use.
- **User-facing failure text lives only in `lib/errors/codes.ts`.** It is static by
  construction so a mapped message can never interpolate a secret, a stack trace, or an
  upstream body. Add a catalogue entry rather than composing a sentence at the call site.
- **Anchor error variants must be appended last.** Codes are positional, so inserting
  one renumbers every existing code and silently breaks the client's mapping.
- **Onchain constants have one source of truth.** `programs/proof_of_skill/src/constants.rs`
  and `lib/program-contract.ts` mirror each other and assert it from both sides. Change
  one, change the other, and let the tests catch the drift.
- **Put tests where vitest can see them.** `vitest.config.mts` collects
  `lib/**`, `components/**`, `app/**` only. A test in `db/` or `scripts/` is silently
  never run and the suite still exits 0 — a false pass. Put a `db/` module's test under
  `lib/` instead, and confirm the file count went up.
- **A `server-only` module needs a stub in its test.** `import "server-only"` throws
  under Node's resolution conditions, so start the file with
  `vi.mock("server-only", () => ({ default: {} }))`.
- **Never commit a secret-shaped fixture.** A literal like `sk-or-v1-<64 hex>` trips
  GitHub push protection (GH013) whether or not it is real — and a scanner cannot tell.
  Build such values at runtime (`["sk-or-v1", "4f9a".repeat(16)].join("-")`) so the test
  still exercises the exact shape while the source stays clean. Do not use the
  allow-secret URL; bypassing trains reviewers to ignore real leaks.

## What this project will not claim

The AI evaluation is a rubric-based assessment, not a proof of skill, and the chain
records a claim — it does not verify the code. The issuer is a single trusted key:
onchain, the *only* gate on minting a credential is that co-signature (attestation
checking lives in `/api/issue`, not in the program), so issuer key compromise means
forgery. Reputation is per-wallet and therefore sybil-attackable. Say so in any change
that touches these areas rather than letting a feature make the claim implicitly
stronger.
