# Style Guide

<TYPESCRIPT>
- `strict: true`. No `any`, no non-null `!` unless the invariant is commented. Prefer `unknown` + zod narrowing at boundaries.
- Early returns over nested `if/else`. Max nesting depth 3.
- Files under 300 lines, components under 200. Split by responsibility.
- Named exports. Default exports only where Next.js requires them (`page.tsx`, `layout.tsx`, `route.ts` handlers are named by HTTP verb).
- File names `kebab-case.ts(x)`; components `PascalCase`; hooks `useX`; constants `SCREAMING_SNAKE_CASE`.
- Variables holding derived program addresses end in `_pda` (`profile_pda` in Rust, `profilePda` is NOT used — use `profile_pda` in TS too for grep-ability). Seed constants end in `_SEED`.
- Types co-located with their module; shared types in `lib/types/`. No barrel files that re-export entire folders.
- Errors: return typed results (`{ ok: true, data } | { ok: false, error }`) from `lib/` functions; throw only for programmer errors. Map to user messages in `lib/errors/`.
- Comments explain why, not what. Every `/// CHECK:` in Rust and every non-obvious constraint is commented.
</TYPESCRIPT>

<REACT_NEXT>
- Server Components by default. Add `"use client"` only to leaves that need state, effects, wallet, or animation.
- Data fetching in Server Components; mutations through route handlers.
- Every route segment with async work has `loading.tsx`; user-visible failures have `error.tsx` or inline error states.
- Forms: controlled inputs with zod validation shared with the API schema. Disable submit while pending.
- Accessibility: semantic elements, labels on inputs, visible focus rings, color is never the only status signal, `prefers-reduced-motion` respected for all motion and the 3D scene.
</REACT_NEXT>

<RUST>
- `cargo fmt` and `cargo clippy -- -D warnings` clean before committing program changes.
- One instruction per file under `instructions/`; `lib.rs` only wires entrypoints.
- Account structs named `<Instruction>` in PascalCase; handler fn `handler`.
- Checked math only (`checked_add`, `ok_or(ProofError::MathOverflow)`).
</RUST>

<VISUAL_DIRECTION>
Identity: developer verification infrastructure — GitHub + Linear + Vercel precision with restrained Web3 cues.
- Dark-first with a light theme. Colors as CSS variables in `@theme`/`:root`; one accent color, one success, one warning, one danger. No neon, no rainbow gradients, no floating coins, no heavy glassmorphism.
- Strong type hierarchy: a sans for UI, a mono for hashes, addresses, scores. Tabular numbers for scores.
- 1px subtle borders, consistent 4/8px spacing grid, generous whitespace, cards with clear hierarchy.
- Status chips: `AI EVALUATED`, `PASS`, `FAIL`, `ONCHAIN VERIFIED`. The two trust layers always appear as separate labeled sections.
- Truncate addresses and hashes (`ABCD…1234`) with copy buttons; show full value on hover or in the verify page.
- Motion: `motion` for page/card entrance, evaluation score bar, credential reveal, tx status transitions. Durations 150–400 ms. No looping decorative animation.
- 3D: exactly one hero scene (developer → proof → evaluation → verification → credential nodes). Lazy-loaded, `frameloop="demand"` or low-cost loop, static SVG/CSS fallback for reduced motion, missing WebGL, and slow devices.
- Copy tone: precise and plain. Never write "AI-verified skill" or "blockchain proves your skill". Use "AI Evaluation" and "Onchain Verification".
</VISUAL_DIRECTION>
