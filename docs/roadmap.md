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
- [ ] Next.js app boots with Tailwind v4 + shadcn initialized. Verify: `pnpm build`.
- [ ] `lib/challenges/data.ts` with 5 typed challenges + unit test. Verify: `pnpm test`.
- [ ] `lib/hashing` + tests with fixed vectors. Verify: `pnpm test`.
- [ ] `lib/evaluation` (prompt, schema, scoring, evaluator) + tests for scoring/clamping/invalid JSON using a stubbed client. Verify: `pnpm test`.
- [ ] `POST /api/evaluate`. Verify: real call with configured key, or documented `AI_NOT_CONFIGURED` response if no key.
- [ ] `lib/attestation` + tests (valid, tampered, expired). Verify: `pnpm test`.
- [ ] `lib/solana` (pdas, program, connection, tx-builder, explorer) + PDA parity test. Verify: `pnpm test`.
- [ ] `POST /api/issue`. Verify: returns a partially signed tx that simulates successfully on the target cluster.
- [ ] Wallet provider + connect UI (Phantom via Wallet Standard). Verify: manual connect in browser.
- [ ] Challenge page → submit → result → issue → sign → confirm → dashboard list. Verify: manual run on localnet or devnet.

## Phase 3 — Product UI
- [ ] Landing page (explains AI Evaluation vs Onchain Verification).
- [ ] Challenge list + challenge workspace.
- [ ] Evaluation screen (score bar, rubric rows, status, issue button, honest loading state).
- [ ] Transaction status component (all states) with mapped errors.
- [ ] Dashboard (wallet, total credentials, average score, categories, recent credentials, Explorer links).
- [ ] `/verify/[credentialId]` public page with invalid/missing states.
- [ ] Error mapping module covering every case in `docs/rules.md` → ERROR_UX. Verify: unit tests.

## Phase 4 — Visual layer
- [ ] `motion` transitions and credential reveal, with reduced-motion handling.
- [ ] Hero 3D scene, lazy-loaded, with static fallback. If it exceeds a reasonable time box, simplify it.

## Phase 5 — Hardening
- [ ] `pnpm typecheck` PASS
- [ ] `pnpm lint` PASS
- [ ] `pnpm test` PASS
- [ ] `pnpm build` PASS
- [ ] `anchor build` PASS
- [ ] `anchor test` PASS
- [ ] Security checklist in `docs/smart-contract-spec.md` fully ticked.
- [ ] Secret scan: no keys in tracked files (`git ls-files` + grep for key patterns; do not print matches' values).

## Phase 6 — Devnet
- [ ] `solana config get` shows devnet; deployer funded (see airdrop rule). Else mark BLOCKED with exact error.
- [ ] `anchor deploy --provider.cluster devnet`; record real Program ID.
- [ ] Initialize Config on devnet with issuer pubkey.
- [ ] Set `NEXT_PUBLIC_PROGRAM_ID`; run the full demo path with a real wallet. Record the real signature and Explorer URL.

## Phase 7 — Docs and report
- [ ] README reflects only what exists: pitch, problem, Why Solana, Mermaid architecture, on/offchain data table, real program details, verified setup commands, tests actually run, limitations.
- [ ] Final report in the format from the master prompt (status, Solana, AI, testing matrix using PASS/FAIL/NOT RUN/BLOCKED, files, limitations, max 5 next steps).

## Optional (only after Phase 6 passes)
- [ ] Solana Action / Blink for sharing a credential. Verify the current Actions spec before coding; remove if it threatens the demo.
