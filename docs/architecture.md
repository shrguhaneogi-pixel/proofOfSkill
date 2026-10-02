# Architecture

<SYSTEM_OVERVIEW>
One repository, one Anchor workspace, one Next.js app (App Router). No separate backend service. No database in the MVP.

```text
Browser (Next.js client)
  │ 1. POST /api/evaluate  {challengeId, explanation, code, repoUrl?}
  ▼
Next.js Route Handler (server-only)
  │ validate → canonicalize → sha256 → evaluator (OpenAI-compatible LLM)
  │ server recomputes score from rubric weights; passed = score >= 70
  │ returns result + attestation token (HMAC) if passed
  ▲
Browser shows AI Evaluation
  │ 2. user connects wallet
  │ 3. POST /api/issue  {attestation, wallet}
  ▼
Route Handler verifies HMAC + expiry + wallet pubkey, checks credential PDA absent,
builds VersionedTransaction [initialize_profile?, issue_credential],
fee payer = user wallet, partially signs with ISSUER keypair, returns base64 tx.
  ▲
Browser: wallet signs + sends → confirm → credential appears
  │ 4. dashboard / verify page read Credential PDAs directly from Solana RPC
```
</SYSTEM_OVERVIEW>

<TRUST_MODEL>
- AI Evaluation: off-chain, probabilistic, rubric-bound. Label "AI Evaluation".
- Issuer: a server-held keypair registered in the onchain `Config` account. The program accepts `issue_credential` only when that key co-signs. The AI never signs anything.
- Onchain Verification: Credential PDA = wallet + challenge + score + evidence hash + timestamp + issuer. Label "Onchain Verification".
- The issuer is centralized and trusted in the MVP. State this in the README Limitations.
- `evidence_hash` = SHA-256 of the canonical submission JSON (see `docs/api-schema.md`). It proves integrity of the evidence representation, not quality.
</TRUST_MODEL>

<DIRECTORY_TREE>
```text
.
├── Anchor.toml
├── Cargo.toml
├── programs/proof_of_skill/src/
│   ├── lib.rs                 # declare_id!, #[program], instruction entrypoints only
│   ├── constants.rs
│   ├── errors.rs
│   ├── events.rs
│   ├── state/                 # config.rs, profile.rs, credential.rs
│   └── instructions/          # initialize_config.rs, initialize_profile.rs, issue_credential.rs
├── tests/                     # Anchor tests (own tsconfig)
│   ├── tsconfig.json
│   └── proof_of_skill.ts
├── scripts/                   # init-config.ts, gen-issuer.sh
├── app/
│   ├── layout.tsx  page.tsx  globals.css
│   ├── challenges/page.tsx
│   ├── challenges/[slug]/page.tsx
│   ├── dashboard/page.tsx
│   ├── verify/[credentialId]/page.tsx
│   └── api/{evaluate,issue}/route.ts
├── components/
│   ├── ui/                    # shadcn generated; do not hand-edit casually
│   ├── navbar/ hero/ challenge/ evaluation/ credential/ wallet/ transaction/
├── lib/
│   ├── challenges/            # data.ts (typed catalogue), types.ts
│   ├── evaluation/            # evaluator.ts, prompt.ts, schema.ts, scoring.ts
│   ├── hashing/               # canonicalize.ts, evidence-hash.ts
│   ├── attestation/           # sign.ts, verify.ts  (server-only)
│   ├── solana/                # pdas.ts, program.ts, connection.ts, explorer.ts, tx-builder.ts, idl/
│   ├── errors/                # mapping to user messages
│   └── types/
├── docs/
├── .env.example
└── README.md
```
Adapt to the existing repo. Do not recreate directories that already hold working code.
</DIRECTORY_TREE>

<BOUNDARIES>
- `lib/attestation/*`, `lib/evaluation/evaluator.ts`, and any file reading `process.env` secrets start with `import "server-only"`.
- Client components never import server-only modules.
- All PDA derivation lives in `lib/solana/pdas.ts` and mirrors program seeds exactly. One source of truth; tests assert parity.
- Pages are Server Components by default. Wallet, forms, and animation leaves are Client Components.
- Dashboard: `program.account.credential.all([{ memcmp: { offset: 8, bytes: wallet.toBase58() } }])` (offset 8 = Anchor discriminator; `user` is the first field).
- Verify page: server component, read-only connection, input is the credential PDA address (base58, validated); render 404 state for invalid or missing accounts.
- Explorer links are built only from real signatures/addresses via `lib/solana/explorer.ts`, with `?cluster=devnet`.
</BOUNDARIES>

<TX_STATE_MACHINE>
`disconnected → connecting → connected → preparing → signing → submitted → confirming → success | failed`
Implemented as a typed reducer in `components/transaction/`. `failed` always carries a mapped user message and a retry action.
</TX_STATE_MACHINE>

<OFFCHAIN_PERSISTENCE>
MVP stores no server state. The evaluation result lives in client state (and `sessionStorage` for refresh survival). Onchain data is read from Solana. Add a database only if a roadmap item explicitly says so.
</OFFCHAIN_PERSISTENCE>
