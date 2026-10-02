# Living Notes

Agent-maintained. Append; do not delete history. Keep entries short and factual. Read this file at the start of every session.

<FORMAT>
`- YYYY-MM-DD [area] note` — areas: repo, solana, anchor, frontend, ai, wallet, env, deploy, decision, blocker.
</FORMAT>

## Resolved Versions

Resolved live on 2026-10-02 (Phase 0). `stack.md` says never pin from docs — these are the real values.

| Tool / package | Version | Path / note |
|---|---|---|
| node | v24.19.0 | `C:\Program Files\nodejs\node.exe` |
| pnpm | 12.8.1 | not on PATH; runs through corepack (`corepack pnpm`) |
| rustc / cargo | 1.98.1 | `C:\Users\Dell\.cargo\bin`, host `x86_64-pc-windows-gnu` |
| anchor-cli | 0.29.0 | `C:\Users\Dell\.cargo\bin\anchor.exe` |
| solana-cli | 1.18.15 | `C:\Users\Dell\.local\share\solana\install\solana-release\bin` |
| anchor-lang (Rust) | 0.29.0 | matches CLI major.minor |
| @coral-xyz/anchor (TS) | 0.29.0 | see decision below |
| next / eslint-config-next | 16.3.8 | |
| react / react-dom | 19.2.8 | |
| tailwindcss | 4.3.3 | CSS-first config, `@import "tailwindcss"` |
| typescript | 5.9.3 | |
| zod | 4.6.5 | v4 idioms (`safeParse`, no v3-only chains) |
| @solana/web3.js | 1.99.0 | v1 line, required by wallet-adapter + Anchor TS |
| @solana/wallet-adapter-react | 0.15.40 | peer `react: "*"` — React 19 OK |
| motion | 13.4.6 | import from `motion/react` |
| three / @react-three/fiber / drei | 0.186.1 / 9.8.1 / 10.7.9 | |
| openai | 7.25.0 | |
| vitest | 5.0.3 | |
| mocha / ts-mocha / chai | 9.2.2 / 11.1.0 / 4.5.0 | Anchor program tests only |

## Architecture Decisions (pre-seeded)
- [decision] Issuer co-signs `issue_credential`; user is fee payer. Server builds and partially signs the tx.
- [decision] Config PDA stores issuer; `initialize_config` restricted to program upgrade authority.
- [decision] No `passed` field onchain; credential existence implies score >= 70.
- [decision] Server recomputes score from rubric weights; model output is never trusted for `passed`.
- [decision] HMAC attestation token gates `/api/issue`; not wallet-bound at mint (documented limitation).
- [decision] No database in MVP; evaluation held in client state / sessionStorage.
- [decision] Token-2022 and Blinks deferred.
- 2026-10-02 [decision] Anchor TS client is `@coral-xyz/anchor@0.29.0`, not `@anchor-lang/core`. `stack.md` allows `@anchor-lang/core` only if it matches the CLI line; the registry shows it at 1.2.0 while the CLI is 0.29.0, so the majors disagree.
- 2026-10-02 [decision] Program ID comes from a real generated keypair (`target/deploy/proof_of_skill-keypair.json`, gitignored), not an invented base58 string: `5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3`.

## PDA Seeds (authoritative once confirmed by `anchor test`)
- Config: `["config"]`
- UserProfile: `["profile", user]`
- Credential: `["credential", user, [challenge_id]]`

## Gotchas

- 2026-10-02 [env] `stack.md` says "Dev machine is Linux (Linux Mint)". It is not — this host is win32. The Linux toolchain check command does not work as written; resolved tool paths are in the table above.
- 2026-10-02 [env] The agent shell has no `HOME`/`USERPROFILE` and no toolchain on PATH. Everything runs through a wrapper: `C:\Users\Dell\.qwen\scratch\posenv.cmd <command>`, which also injects a `pnpm` shim (`corepack pnpm`) at `C:\Users\Dell\.qwen\scratch\bin`.
- 2026-10-02 [env] **Linker fix that unblocked all Rust builds.** rustc host is `x86_64-pc-windows-gnu`, but PATH resolved `x86_64-w64-mingw32-gcc` to LLVM-MinGW (a clang driver with no `libgcc`), so even `proc-macro2`'s build script failed with `lld: unable to find library -lgcc_eh`. Putting WinLibs `mingw64\bin` first on PATH fixes it; `cargo check`/`clippy`/`fmt` all work now.
- 2026-10-02 [anchor] `anchor-lang 0.29.0` has **no** `init-space` feature — cargo rejected it. `InitSpace` is unconditional in the prelude (verified in the crate source), so plain `anchor-lang = "0.29.0"` is correct.
- 2026-10-02 [anchor] `#[program]` emits `pub use crate::__client_accounts_<ix>::*;` at the crate root, so multi-file layouts must glob-re-export the instruction modules from `instructions/mod.rs`. An explicit `pub use` of those generated modules fails with E0365 (they are `pub(crate)`). Consequence: three `handler` fns collide, so handlers are named `handle_<instruction>`. Deviates from `styleguide.md` → "handler fn `handler`", recorded here.
- 2026-10-02 [anchor] `Program<'info, ProofOfSkill>` + `Account<'info, ProgramData>` is the documented 0.29 upgrade-authority pattern and compiles as written in `smart-contract-spec.md`. `ProgramData` comes from the prelude; no extra import needed.
- 2026-10-02 [anchor] The program struct the `Program<>` account needs lives at `crate::program::<PascalName>` (anchor-syn `codegen/program/entry.rs`).
- 2026-10-02 [anchor] `UnauthorizedAdmin` is raised with `require!` in the handler rather than an `#[account(constraint = ...)]`, so the failure surfaces with the spec's error name instead of a generic `ConstraintCustom`.
- 2026-10-02 [solana] `anchor init` ignores `--no-npm`/`--typescript-only` (those flags do not exist in 0.29) and runs `yarn`→`npm install` itself. It was run only in a throwaway scratch dir to learn the generated file shapes; the repo itself uses pnpm.
- 2026-10-02 [frontend] pnpm 12 blocks install scripts by default. `bufferutil`/`utf-8-validate` (optional `ws` accelerators) are declared `false` in `pnpm-workspace.yaml`; the pure-JS fallback is used. Do not "fix" this by approving builds.
- 2026-10-02 [frontend] `pnpm peers check` reports two unmet peers, both benign and now evidenced rather than assumed: (a) `ws@7.5.13` wanting `utf-8-validate@^5` — an optional native accelerator we deliberately do not build; (b) `openai@7` wanting `ws@^8.21` while `@solana/web3.js` pins `ws@7`. (b) is not on our code path: `openai-client.test.ts` drives the **real SDK** over HTTP with a stubbed `fetch` — JSON-mode request shape, typed SDK errors, its own timeout abort, and a full end-to-end evaluation — 6 tests passing. Forcing `ws@8` globally would risk web3.js's own socket use for no benefit. The `@types/node` peer that vitest 5 complained about is resolved (bumped to 24.19.0).
- 2026-10-02 [frontend] vitest config is `vitest.config.mts` — a `.ts` config triggers Vite's "ESM syntax in a file loaded as CommonJS" warning because the repo has no `"type": "module"`.
- 2026-10-02 [frontend] shadcn 4.21.1 with the `base-nova` preset uses **base-ui, not Radix**: `Button` has no `asChild`. Compose links with `render={<Link href="..." />}` (verified in `@base-ui/react/internals/types.d.ts`: `render?: ReactElement | ComponentRenderFn`). `Alert` only has `default` and `destructive` variants — there is no `warning`.
- 2026-10-02 [frontend] `pnpm dlx shadcn init` added the **shadcn CLI to runtime `dependencies`**; demoted to devDependencies. It also wrote `lib/utils.ts` re-exporting `cn` from the published `cn` package — checked before trusting it: maintained by shadcn (`github.com/shadcn-ui/cn`, `m@shadcn.com`), not an unrelated look-alike. Still outside `stack.md`'s allowed list, so it needs sign-off.
- 2026-10-02 [frontend] eslint-config-next 16 enforces `react-hooks/set-state-in-effect`. Two components tripped it; both now use `useSyncExternalStore` (the WebGL probe caches its boolean, the sessionStorage restore caches parsed JSON by raw string so `getSnapshot` stays referentially stable). Do not "fix" these by moving the setState into a `useEffect` body again.
- 2026-10-02 [frontend] `LayoutProps<"/">` needs Next's generated route types; plain `{ children: React.ReactNode }` avoids depending on them.
- 2026-10-02 [decision] `EvaluationResult` deliberately has **no** `attestation` field, so the evaluator module cannot mint its own authorisation. `/api/evaluate` attaches the token afterwards. The dev fallback scores 0 with `passed: false`, which is what makes it unattestable rather than a policy check elsewhere.
- 2026-10-02 [env] `NEXT_PUBLIC_SOLANA_RPC_URL` is an **override**, not a required key: nothing read `env.rpcUrl`, yet `/api/evaluate` returned 500 when it was unset — failing an endpoint that never touches the RPC. `lib/solana/connection.ts` already resolves a per-cluster default. A present-but-malformed url is still rejected.
- 2026-10-02 [anchor] Rust-side correction to my own brief: the trait is `Discriminator::DISCRIMINATOR` (not `::ID`) and `INIT_SPACE` comes from `Space`; neither `Discriminator` nor `InstructionData` is in the 0.29 prelude.
- 2026-10-02 [deploy] Devnet **RPC reads work from this machine** — `/verify/[credentialId]` fetched live accounts successfully and rejected an address owned by another program. Only the *build and deploy* path is blocked; the read path is verified against real Devnet.
- 2026-10-02 [deploy] Recorded: `solana config get` targets **mainnet-beta** (global CLI config left untouched), deployer `E7Q8…zL1t` holds **0 SOL on devnet**, and `solana program show 5BLt… --url devnet` returns `Unable to find the account`. No airdrop attempted while `anchor build` is blocked.
- 2026-10-02 [blocker] Running `node scripts/init-config.cjs` to confirm its missing-IDL guard was **denied by the sandbox**, so that behaviour is known by code inspection only — it is NOT RUN and must not be reported as executed.

## Blockers

- 2026-10-02 [anchor] **`anchor build` cannot produce an SBF binary on this machine.** `cargo check`, `cargo clippy -- -D warnings` and `cargo fmt` all PASS, so the program source is verified; only the `.so` compile is blocked. Three distinct hypotheses tried:
  1. `anchor build` → `error: no such command: build-bpf`, exit 101 in ~0.2s. anchor-cli 0.29.0 shells out to the legacy `cargo-build-bpf`; Solana 1.18.15 ships only `cargo-build-sbf`. Not fixable from the repo without patching the CLI.
  2. Direct `cargo build-sbf` → `Failed to install platform-tools: A required privilege is not held by the client. (os error 1314)` — symlink creation needs Developer Mode / admin.
  3. Reuse existing tools instead of installing (`--tools-version`, `--sbf-sdk`, `--arch`) → platform-tools are absent: `~\.cache\solana` and `bin\sdk\sbf\dependencies` are both empty, and `cargo build-sbf --version` prints "platform-tools v1.41" from a default constant, not from an install.
  - **Needed to unblock:** Windows Developer Mode (or an admin shell) so platform-tools can symlink, **or** a Linux/WSL container with anchor 0.29 + Solana CLI. Until then `anchor test`, localnet, Devnet deploy and the real-signature demo path are all BLOCKED, not merely untested.

## Verified Commands

- 2026-10-02 `cargo check -p proof_of_skill` → PASS (exit 0, only `unexpected_cfgs` noise, now declared via `[lints.rust.unexpected_cfgs]` check-cfg).
- 2026-10-02 `cargo fmt --all` → PASS.
- 2026-10-02 `cargo clippy -p proof_of_skill --all-targets -- -D warnings` → PASS.
- 2026-10-02 `solana-keygen new --no-bip39-passphrase --silent --outfile <path>` → works; used for the program and issuer keypairs.
- 2026-10-02 `pnpm install`, `pnpm add`, `pnpm test` → PASS (vitest 5.0.3).
- All of the above must be invoked as `C:\Users\Dell\.qwen\scratch\posenv.cmd <cmd>` on this host.
- 2026-10-02 `cargo test -p proof_of_skill` → PASS (28 tests). The `#[program]` entrypoint does **not** block host tests; no feature flag needed.
- 2026-10-02 `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm test` → all PASS (340 tests, 14 routes).
- 2026-10-02 `node .qwen/tmp/smoke.mjs` against `pnpm dev` → 18/18 HTTP checks pass: every page renders, `/api/evaluate` returns the labelled dev fallback with no attestation, and `/api/issue` rejects malformed, wrong-secret and forged attestations with 400.
- 2026-10-02 secret scan of tracked files (`.qwen/tmp/secret-scan.mjs`, reports file:line only) → 7 matches, all negative-test fixtures asserting non-leakage; no keypair, `.env*` or `target/` path is tracked.

## Session Log

- 2026-10-02 Phase 0: audited repo (docs-only), added `.gitignore`, verified ignore rules, resolved toolchain + package versions, recorded blocker.
- 2026-10-02 Phase 1: wrote the `proof_of_skill` program (config/profile/credential, 3 instructions, 7 errors, 1 event) to spec; generated a real program ID `5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3` and issuer pubkey `Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j` (private keys gitignored). `anchor build` BLOCKED — see Blockers.
- 2026-10-02 Phase 2 start: Next.js 16 app router + Tailwind v4 scaffolded from `create-next-app` (generated in scratch, configs copied in); `lib/challenges` and `lib/hashing` implemented with 15 passing vitest tests, including SHA-256 vectors computed independently with `node:crypto`.
