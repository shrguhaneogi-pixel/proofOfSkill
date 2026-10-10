# API Schema

<ENV_VARS>
`.env.example` contains all keys with empty values. Never commit `.env.local`.

```env
# public (safe in browser)
NEXT_PUBLIC_SOLANA_NETWORK=devnet
NEXT_PUBLIC_SOLANA_RPC_URL=
NEXT_PUBLIC_PROGRAM_ID=

# server-only
AI_API_KEY=
AI_BASE_URL=          # OpenAI-compatible endpoint, e.g. a Qwen-compatible-mode URL; confirm in provider docs
AI_MODEL=
ISSUER_PRIVATE_KEY=   # JSON array of 64 secret-key bytes (output of solana-keygen); server-only
ATTESTATION_SECRET=   # >= 32 random bytes, hex/base64; used for HMAC
```
Validate env at startup with zod in `lib/env.server.ts`. Missing `AI_API_KEY` returns error code `AI_NOT_CONFIGURED` with setup instructions, never a fake result.
</ENV_VARS>

<CHALLENGE_TYPE>
```ts
type Challenge = {
  id: 1 | 2 | 3 | 4 | 5;
  slug: string;
  title: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  category: "Solana" | "Anchor" | "Web3 Frontend" | "Security";
  estimatedMinutes: number;
  prompt: string;                 // what the user must produce
  rubric: { id: string; label: string; weight: number }[]; // weights sum to exactly 100
  credentialType: string;
};
```
Catalogue lives in `lib/challenges/data.ts`, typed, with a unit test asserting weights sum to 100 and IDs are unique and 1–5. Challenge 1 rubric: PDA derivation 30, account relationships 25, security implications 25, clarity and completeness 20.
</CHALLENGE_TYPE>

<SUBMISSION>
```ts
const SubmissionSchema = z.object({
  walletPublicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  challengeId: z.number().int().min(1).max(5),
  explanation: z.string().trim().min(100).max(4000),
  code: z.string().trim().min(1).max(8000),
  repoUrl: z.string().url().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/).optional(),
});
```
`walletPublicKey` is required: the attestation minted on a pass is bound to it, so the
credential can only be redeemed by the wallet that was evaluated. The regex is a shape
check shared with the browser form; `/api/evaluate` canonicalises through
`parsePublicKey` and signs the base58 string that decode returns, so a non-canonical
spelling can never produce a token that fails to match at redemption.
</SUBMISSION>

<EVIDENCE_HASH>
Canonical JSON = keys sorted alphabetically, `explanation` and `code` with `\r\n` normalized to `\n` and leading/trailing whitespace trimmed, `repoUrl` omitted when absent, UTF-8, no extra whitespace.
`evidenceHash = SHA-256(canonicalJson)` → 32 bytes onchain, hex string in API responses.
Implemented once in `lib/hashing/` and unit-tested with fixed vectors (same input → same hash; key order and CRLF do not change it; any content change does).
</EVIDENCE_HASH>

<EVALUATOR_CONTRACT>
Function: `evaluateSubmission(challenge, submission): Promise<EvaluationResult>` in `lib/evaluation/evaluator.ts` (server-only).

Model raw output (validated with zod; reject and retry once on invalid JSON, then return `AI_INVALID_OUTPUT`):
```json
{
  "criteria": [{ "id": "string", "points": 0, "comment": "string" }],
  "strengths": ["string"],
  "weaknesses": ["string"],
  "feedback": "string"
}
```
Rules enforced by server code, not by the model:
- Every rubric criterion id appears exactly once; unknown ids are rejected.
- `points` is clamped to `[0, weight]`.
- `score = round(sum(points))`. `passed = score >= 70`. The model never decides `passed` or the total.
- Request uses the OpenAI-compatible chat completions API with JSON output mode, temperature ≤ 0.2, a timeout (e.g. 45 s), and one retry for 429/5xx with backoff.
- Prompt injection defense: system prompt states that submission text is untrusted data; submission is wrapped in explicit delimiters; instructions inside it are ignored; the rubric is the only grading authority.

Result returned to the client:
```ts
type EvaluationResult = {
  challengeId: number;
  score: number;                  // 0–100
  passed: boolean;
  passThreshold: 70;
  strengths: string[];
  weaknesses: string[];
  feedback: string;
  evaluatedCriteria: {
    id: string; label: string; weight: number;
    pointsAwarded: number; status: "met" | "partial" | "not_met"; comment: string;
  }[];                            // status: >=80% met, 40–79% partial, <40% not_met
  evidenceHash: string;           // hex
  provider: string;               // real provider/model id, or "dev-fallback"
  evaluatedAt: string;            // ISO
  attestation?: string;           // present only when passed and provider is not dev-fallback
};
```
</EVALUATOR_CONTRACT>

<ATTESTATION>
Purpose: the browser cannot claim `passed = true`; only a token minted by `/api/evaluate` unlocks `/api/issue`.
- Format: `base64url(payloadJson) + "." + base64url(HMAC_SHA256(ATTESTATION_SECRET, payloadJson))`.
- Payload, in this exact signed key order: `{ v, walletPublicKey, challengeId, score, evidenceHash, exp }`, `exp` = now + 15 minutes.
- `v` is the payload version (`ATTESTATION_VERSION`, currently `2`). Bumping it retires every older token — including unstamped v1 tokens — because `v` is inside the signed body, so an old token fails the schema rather than silently verifying. Rotating `ATTESTATION_SECRET` also invalidates outstanding tokens, but abruptly: anyone inside their 15 minute window must evaluate again.
- Verify with `crypto.timingSafeEqual`; the signature is checked before any payload field is read, then wallet binding, then expiry, then score < 70.
- Wallet binding: `/api/issue` passes the caller's canonical wallet as `expectedWalletPublicKey`. A token minted for Wallet_A and presented by Wallet_B is rejected `403 WALLET_MISMATCH` and never reaches the transaction builder.
- Closed limitation: the token previously was not bound to a wallet, so a forwarded or stolen token could be redeemed by whoever held it. Per-wallet, per-challenge uniqueness was always enforced by the Credential PDA; it is not a substitute for binding, because the first redeemer wins.
</ATTESTATION>

<ROUTES>
### POST /api/evaluate
Body: `Submission`. Success `200`: `EvaluationResult`. Errors: `400 INVALID_SUBMISSION`, `400 INVALID_WALLET`, `404 CHALLENGE_NOT_FOUND`, `429 RATE_LIMITED`, `503 AI_NOT_CONFIGURED`, `502 AI_INVALID_OUTPUT`, `504 AI_TIMEOUT`, `502 AI_UPSTREAM_ERROR`.
Apply per-IP in-memory rate limiting (simple, documented as MVP-grade) and a request body size cap.

### POST /api/issue
Body: `{ attestation: string, wallet: string /* base58 */ }`.
Steps: validate wallet as a PublicKey and canonicalise it → verify attestation (signature first, then the wallet binding, then expiry, then threshold) → fetch Config, Profile, Credential PDAs → if Credential exists return `409 CREDENTIAL_EXISTS` → build `VersionedTransaction` with `[initialize_profile (if absent), issue_credential(challengeId, score, evidenceHash)]`, fee payer = wallet, recent blockhash from RPC → co-sign with the issuer keypair via `transaction.sign([issuer])` → return:
```ts
{ transaction: string /* base64 */, blockhash: string, lastValidBlockHeight: number,
  credentialPda: string, profilePda: string }
```
Errors: `400 INVALID_ATTESTATION`, `400 INVALID_WALLET`, `403 WALLET_MISMATCH`, `409 CREDENTIAL_EXISTS`, `503 ISSUER_NOT_CONFIGURED`, `502 RPC_ERROR`.

All error bodies: `{ error: { code: string, message: string } }` where `message` is user-safe. Never leak stack traces, env values, or raw upstream responses.
</ROUTES>
