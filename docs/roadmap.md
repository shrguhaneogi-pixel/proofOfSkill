# Roadmap

Rules: work top to bottom. Tick `- [x]` only after the **Verify** command passes in this session. Log notes in `docs/living-notes.md`. Do not start Phase N+1 while Phase N has an unchecked item unless it is marked BLOCKED in living-notes.

## Phase 0 — Audit
- [x] Inspect repo (git status, package.json, Anchor.toml, Cargo.toml, app/, env files) and record findings. Verify: summary written to living-notes.
- [x] Run toolchain check from `docs/stack.md`; record resolved versions. Verify: versions listed in living-notes. (Host is win32, not Linux — see Gotchas.)
- [x] Ensure `.gitignore` covers `.env*` (except `.env.example`), `.keys/`, `target/`, `node_modules/`, `.next/`. Verify: `git check-ignore -v .env.local .keys/x target`.

## Phase 1 — Solana program

> BLOCKED on `anchor build` for every item below: anchor-cli 0.29 shells out to
> `cargo-build-bpf` (absent) and `cargo build-sbf` cannot install platform-tools
> without symlink privileges. Program source is verified instead with
> `cargo check -p proof_of_skill`, `cargo clippy -- -D warnings` and `cargo fmt`,
> all of which PASS. Details in `docs/living-notes.md` → Blockers.

- [ ] Anchor workspace scaffolded or reconciled with existing; program named `proof_of_skill`. Verify: `anchor build`.
- [ ] State, constants, errors, events per spec. Verify: `anchor build`.
- [ ] `initialize_config`, `initialize_profile`, `issue_credential` per spec. Verify: `anchor build` + `cargo clippy -- -D warnings`.
- [ ] All required tests from the spec. Verify: `anchor test` (record the pass count).
- [ ] Generate issuer keypair into `.keys/issuer.json` (gitignored); `scripts/init-config.ts` initializes Config on localnet. Verify: script run + test.

## Phase 2 — Vertical slice (ugly is fine)
- [x] Next.js app boots with Tailwind v4 + shadcn initialized. Verify: `pnpm build` → PASS (14 routes).
- [x] `lib/challenges/data.ts` with 5 typed challenges + unit test. Verify: `pnpm test` → PASS (7 tests).
- [x] `lib/hashing` + tests with fixed vectors. Verify: `pnpm test` → PASS (8 tests, digests computed independently with `node:crypto`).
- [x] `lib/evaluation` (prompt, schema, scoring, evaluator) + tests for scoring/clamping/invalid JSON using a stubbed client. Verify: `pnpm vitest run lib/evaluation` → PASS (110 tests, 8 files, no network).
- [x] `POST /api/evaluate`. Verify: HTTP smoke run — 200 with the labelled `dev-fallback` and no attestation when no key is configured; 400 `INVALID_SUBMISSION` for short text and out-of-range ids; 429 inside a burst.
- [x] `lib/attestation` + tests (valid, tampered, expired). Verify: `pnpm test` → PASS (26 tests) plus live 400s from `/api/issue` for malformed and wrong-secret tokens.
- [x] `lib/solana` (pdas, program, connection, tx-builder, explorer) + PDA parity test. Verify: `pnpm vitest run lib/solana` → PASS (109 tests, 9 files). Parity is additionally pinned from the Rust side by `cargo test` (same 7 addresses and bumps), which is stronger than a same-language test — but it proves derivation, not enforcement.
- [ ] `POST /api/issue`. **BLOCKED** on its verify step: "partially signed tx that simulates successfully on the target cluster" needs a deployed program. The auth half is verified live (400 on malformed / wrong-secret / invalid wallet); `buildIssueTransaction` itself is unit-tested against a stubbed RPC, never against a cluster.
- [ ] Wallet provider + connect UI (Phantom via Wallet Standard). **NOT RUN** — needs a real browser with an installed wallet. Code is in place and `wallets={[]}` was verified against the installed provider, which calls `useStandardWalletAdapters` internally.
- [ ] Challenge page → submit → result → issue → sign → confirm → dashboard list. **BLOCKED** by the un-built program; every step before signing is verified.

## Phase 3 — Product UI
- [x] Landing page (explains AI Evaluation vs Onchain Verification). Verify: HTTP 200 and both labels present in the served HTML.
- [x] Challenge list + challenge workspace. Verify: HTTP 200, all five titles listed, rubric ids rendered, unknown slug → 404.
- [ ] Evaluation screen (score bar, rubric rows, status, issue button, honest loading state). **NOT RUN** — needs a browser to drive submit; the panel is type-checked against the real `EvaluationResult` and the API contract is verified.
- [ ] Transaction status component (all states) with mapped errors. **NOT RUN** in a browser. The reducer itself is unit-tested (7 transitions incl. out-of-order guards).
- [ ] Dashboard (wallet, total credentials, average score, categories, recent credentials, Explorer links). Page renders (HTTP 200); the credentialed state is **unverifiable** until a credential exists onchain.
- [x] `/verify/[credentialId]` public page with invalid/missing states. Verify: live Devnet RPC reads — malformed address, an address owned by another program, and the not-found path all render correctly.
- [x] Error mapping module covering every case in `docs/rules.md` → ERROR_UX. Verify: `pnpm test` → PASS (47 tests).

## Phase 4 — Visual layer
- [ ] `motion` transitions and credential reveal, with reduced-motion handling. Built and it compiles; **not visually verified** in a browser.
- [ ] Hero 3D scene, lazy-loaded, with static fallback. Built with WebGL + `prefers-reduced-motion` fallbacks; **not visually verified**.

## Phase 5 — Hardening
- [x] `pnpm typecheck` PASS
- [x] `pnpm lint` PASS
- [x] `pnpm test` PASS — 340 tests, 25 files
- [x] `pnpm build` PASS — 14 routes
- [ ] `anchor build` — **BLOCKED** (see living-notes → Blockers)
- [ ] `anchor test` — **BLOCKED** (depends on the above)
- [ ] Security checklist in `docs/smart-contract-spec.md` fully ticked. Statically satisfied (seeds+bump on every PDA, `has_one` links, checked math, no lamport transfer beyond rent, no `UncheckedAccount`, both signers typed, event emitted after writes) but the runtime half cannot be ticked without a validator.
- [x] Secret scan: no keys in tracked files. 7 pattern matches, all negative-test fixtures asserting non-leakage; no keypair, `.env*` or `target/` path is tracked.

## Phase 6 — Devnet

> **BLOCKED end to end.** The exact recorded state, measured 2026-10-02:
> - `solana config get` → `RPC URL: https://api.mainnet-beta.solana.com`, Keypair Path `~\.config\solana\id.json`. Not devnet. I did not change your global CLI config.
> - Deployer `E7Q8B3NWQTocYqWgdEeqJ6AtyCmCF4LqBYHau7srzL1t` → `solana balance --url devnet` = **0 SOL**.
> - `solana program show 5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3 --url devnet` → `Error: Unable to find the account` — confirms the program has never been deployed.
> No airdrop was attempted: devnet airdrops are rate-limited and, while `anchor build` is blocked, funded SOL cannot be spent on anything. Request it only once the `.so` can be produced.

- [ ] `solana config get` shows devnet; deployer funded (see airdrop rule). Else mark BLOCKED with exact error. — BLOCKED, recorded above.
- [ ] `anchor deploy --provider.cluster devnet`; record real Program ID. — BLOCKED: requires the `.so` from `anchor build`.
- [ ] Initialize Config on devnet with issuer pubkey. — BLOCKED: `scripts/init-config.cjs` refuses to run without `target/idl/proof_of_skill.json`, by design.
- [ ] Set `NEXT_PUBLIC_PROGRAM_ID`; run the full demo path with a real wallet. Record the real signature and Explorer URL. — BLOCKED; no signature exists and none is fabricated anywhere in this repo.

## Phase 7 — Docs and report
- [ ] README reflects only what exists: pitch, problem, Why Solana, Mermaid architecture, on/offchain data table, real program details, verified setup commands, tests actually run, limitations.
- [ ] Final report in the format from the master prompt (status, Solana, AI, testing matrix using PASS/FAIL/NOT RUN/BLOCKED, files, limitations, max 5 next steps).

## Optional (only after Phase 6 passes)
- [ ] Solana Action / Blink for sharing a credential. Verify the current Actions spec before coding; remove if it threatens the demo.
