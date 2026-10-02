# ProofOfSkill — Agent Entry Point

<MISSION>
Build ProofOfSkill: a Solana (Devnet) dApp that turns demonstrated technical ability into verifiable onchain credentials.
Flow: Challenge → Submission → AI Evaluation → Issuer attestation → Wallet-signed Solana tx → Credential PDA → Dashboard → Public verify page.
Two concepts must stay separate in code, UI copy and docs:
- AI Evaluation = an off-chain model scored the work against a rubric. Not cryptographic proof.
- Onchain Verification = Solana records wallet X completed challenge Y with score Z at time T. It does not prove the code is correct.
</MISSION>

<READ_ORDER>
Before any task, read these files. If the `@` imports below did not load (check with `/memory show`), open them with the file-read tool.

@./docs/rules.md
@./docs/roadmap.md
@./docs/living-notes.md

Read on demand (do not preload unless the task touches them):
- `docs/architecture.md` — directory tree, data flow, trust model
- `docs/stack.md` — allowed dependencies, commands, API pitfalls
- `docs/smart-contract-spec.md` — accounts, instructions, errors, events
- `docs/api-schema.md` — evaluator JSON, API routes, attestation token, env vars
- `docs/styleguide.md` — code and visual standards
</READ_ORDER>

<SESSION_PROTOCOL>
1. Read `docs/roadmap.md`. Pick the first unchecked item. Do not skip ahead.
2. Do the work. Run the verification command listed for that item.
3. Tick the item `- [x]` in `docs/roadmap.md` only after verification passes.
4. Append decisions, gotchas and blockers to `docs/living-notes.md`.
5. Commit (see `docs/rules.md` → GIT).
</SESSION_PROTOCOL>

<PRECEDENCE>
When files conflict: `docs/rules.md` > `docs/smart-contract-spec.md` > `docs/api-schema.md` > `docs/architecture.md` > `docs/stack.md` > `docs/styleguide.md`.
The user's live instruction overrides all files. If the repo contradicts a doc, record it in `docs/living-notes.md` and ask only if it blocks the demo path.
</PRECEDENCE>
