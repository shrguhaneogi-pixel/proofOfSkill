# Agent Rules

<EXECUTION_RULES>
- Inspect before modifying: `git status`, `package.json`, `Anchor.toml`, `Cargo.toml`, existing `app/`, `.env*.example`.
- Act autonomously. Do not ask "should I proceed?". Ask only when a missing fact blocks the demo path and cannot be inferred from the repo.
- Write complete code. Every file you create is complete; every edit is a targeted replacement of a unique block.
- Prefer installed dependencies. Before adding a package: check it is not already installed, check peer dependencies (`pnpm view <pkg> peerDependencies`), then add it and log it in `docs/living-notes.md`.
- Verify any Solana, Anchor, wallet-adapter, Next.js, Tailwind or shadcn API against the installed version (`node_modules/<pkg>/package.json`, `.d.ts` files, `cargo doc`, `--help`) before using it. If you cannot verify, say so in `docs/living-notes.md` instead of guessing.
- Do not invent CLI commands, flags, config keys or program IDs. Use `<cmd> --help` to confirm.
- Keep the MVP narrow. If a feature does not serve Skill → Evaluation → Verification → Reputation, do not build it.
</EXECUTION_RULES>

<ANTI_LOOP_PROTOCOL>
- Maximum 3 attempts per distinct error. Each attempt must test a different hypothesis based on the actual error text.
- Before attempt 2 and 3, re-read the full error and the file at the reported line. Do not re-run an unchanged failing command.
- After 3 failed attempts: stop that task, write the error, the 3 hypotheses and what you tried to `docs/living-notes.md` under `## Blockers`, then move to the next unblocked roadmap item.
- Never "fix" an error by deleting `node_modules`, lockfiles, `target/`, or `.next/` unless the error text points to a corrupted cache; log it if you do.
- Never silence errors: no `// @ts-ignore`, `// @ts-expect-error` without a linked reason, `eslint-disable` for whole files, `as any`, empty `catch`, or removing a failing test.
- Never use `--force`, `--legacy-peer-deps`, or `--no-verify` to get past a failure.
- Do not poll or sleep in loops. Long commands run once with a timeout; read their output.
- Do not refactor working code unless a roadmap item requires it.
</ANTI_LOOP_PROTOCOL>

<TERMINAL_RULES>
- Package manager: `pnpm` only. Never run `npm install` or `yarn`.
- Use non-interactive flags (`--yes`, `--no-git`, etc.) for scaffolding. Confirm flags with `--help`.
- Run from the repo root unless a command needs a subdirectory.
- Devnet airdrops are rate-limited. Try `solana airdrop 2` at most twice; on failure, record the exact error and use https://faucet.solana.com instructions in the blocker note. Never loop airdrops.
- Never print, cat, echo or log secret files or env values. Check existence with `test -f`, not `cat`.
- Never run destructive commands outside the repo.
</TERMINAL_RULES>

<FORBIDDEN_PRACTICES>
- No placeholder text in code: no `// existing code`, `// ...rest`, `// TODO: implement`, `unimplemented!()`, lorem ipsum, fake data presented as real.
- No fabricated results: no fake transaction signatures, Explorer URLs, Program IDs, test results or deployment claims. Report `NOT RUN` or `BLOCKED` honestly.
- No mock AI output presented as real. A development fallback is allowed only if it is returned with `"provider": "dev-fallback"` and the UI renders a visible "Development fallback — not an AI evaluation" banner. It must be impossible to obtain an issuer attestation from the fallback in production (`NODE_ENV === "production"`).
- No secrets in git: API keys, keypairs, seed phrases, `.env*` (except `.env.example` with empty values). `.keys/` and `target/deploy/*-keypair.json` stay in `.gitignore`.
- No `NEXT_PUBLIC_` prefix on any secret.
- No trusting the client for `passed`, `score`, or issuer identity. Authorization is enforced by the Anchor program and the server attestation.
- No arbitrary execution of user-submitted code. No fetching user-supplied URLs server-side (the repo URL is stored and hashed, never fetched).
- No `init_if_needed`, no `unsafe`, no `UncheckedAccount` without a `/// CHECK:` comment explaining why it is safe, no unchecked arithmetic in the program.
- No deprecated or removed APIs (see `docs/stack.md` → API_PITFALLS). No old tutorials as authority.
- No new top-level features outside `docs/roadmap.md` before the demo path passes.
</FORBIDDEN_PRACTICES>

<GIT>
- Commit after each completed roadmap item using Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Run `git status` before every commit and confirm no secret or build artifact is staged.
- Never push, force-push, rebase, amend published commits, or change git config.
</GIT>

<DEFINITION_OF_DONE>
A roadmap item is done only when: code is complete, the verification command passed in this session, `pnpm typecheck` is clean (and `anchor build` for program changes), and the item is ticked and noted.
Report status with exactly: `PASS`, `FAIL`, `NOT RUN`, `BLOCKED`.
</DEFINITION_OF_DONE>

<ERROR_UX>
Every user-facing failure maps to a plain-language message and a next step. Handle: wallet missing, user rejected, wrong network, insufficient SOL, simulation failure, blockhash expired, RPC failure, credential already exists, AI missing key / rate limit / timeout / invalid JSON, invalid submission. Mapping lives in `lib/errors/`.
</ERROR_UX>
