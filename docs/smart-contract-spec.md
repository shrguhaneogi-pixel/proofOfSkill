# Smart Contract Spec — `proof_of_skill`

<DESIGN_DECISIONS>
- One Anchor program, three instructions, three account types.
- `initialize_config` is added beyond the two instructions in the original brief. It is required so the authorized issuer is stored onchain and enforced by the program.
- No `passed` field on Credential: a credential can only be created when `score >= PASS_THRESHOLD`, so existence implies pass. Fail results are never written onchain.
- Both the user and the issuer sign `issue_credential`. User pays rent and fees. The issuer never holds user funds.
- No `init_if_needed`. The client prepends `initialize_profile` in the same transaction when the profile does not exist.
- Token-2022 is out of scope for the MVP.
</DESIGN_DECISIONS>

<CONSTANTS>
```rust
pub const CONFIG_SEED: &[u8] = b"config";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const CREDENTIAL_SEED: &[u8] = b"credential";
pub const MIN_CHALLENGE_ID: u8 = 1;
pub const MAX_CHALLENGE_ID: u8 = 5;
pub const MAX_SCORE: u8 = 100;
pub const PASS_THRESHOLD: u8 = 70;
```
Challenge IDs: 1 PDA Fundamentals, 2 Transaction Analysis, 3 Anchor Fundamentals, 4 TypeScript Web3 Integration, 5 Smart Contract Security Basics. TS catalogue uses identical numeric IDs.
</CONSTANTS>

<ACCOUNTS>
Use `#[derive(InitSpace)]`; allocate `8 + Self::INIT_SPACE`.

```rust
#[account] #[derive(InitSpace)]
pub struct Config {          // PDA seeds: ["config"]
    pub admin: Pubkey,       // upgrade authority at init time
    pub issuer: Pubkey,      // the only key allowed to co-sign credentials
    pub bump: u8,
}

#[account] #[derive(InitSpace)]
pub struct UserProfile {     // PDA seeds: ["profile", user]
    pub user: Pubkey,        // first field (offset 8) — memcmp filter relies on this
    pub created_at: i64,
    pub completed_count: u32,
    pub reputation: u32,     // sum of scores
    pub bump: u8,
}

#[account] #[derive(InitSpace)]
pub struct Credential {      // PDA seeds: ["credential", user, [challenge_id]]
    pub user: Pubkey,        // first field (offset 8)
    pub issuer: Pubkey,
    pub evidence_hash: [u8; 32],
    pub issued_at: i64,
    pub challenge_id: u8,
    pub score: u8,
    pub bump: u8,
}
```
Seed for challenge uses the single byte `&[challenge_id]`. Store and reuse the canonical bump (`bump` fields); do not recompute with `find_program_address` on every call.
</ACCOUNTS>

<INSTRUCTIONS>
### initialize_config(issuer: Pubkey)
- Signer: `admin` (mut, payer).
- Accounts: `config` (init, seeds=[CONFIG_SEED], bump), `program` (Program<ProofOfSkill>), `program_data` (Account<ProgramData>), `system_program`.
- Constraints: `program.programdata_address()? == Some(program_data.key())` and `program_data.upgrade_authority_address == Some(admin.key())`. This prevents anyone but the deployer from setting the issuer (front-run protection).
- Effect: store admin, issuer, bump.

### initialize_profile()
- Signer: `user` (mut, payer).
- Accounts: `profile` (init, seeds=[PROFILE_SEED, user.key()], bump), `system_program`.
- Effect: `user`, `created_at = Clock::get()?.unix_timestamp`, counters = 0.

### issue_credential(challenge_id: u8, score: u8, evidence_hash: [u8; 32])
- Signers: `user` (mut, payer), `issuer`.
- Accounts: `config` (seeds=[CONFIG_SEED], bump=config.bump, `has_one = issuer @ ProofError::UnauthorizedIssuer`), `profile` (mut, seeds=[PROFILE_SEED, user.key()], bump=profile.bump, `has_one = user`), `credential` (init, seeds=[CREDENTIAL_SEED, user.key().as_ref(), &[challenge_id]], bump), `system_program`.
- Handler checks (in order): challenge ID within `MIN..=MAX`; `score <= MAX_SCORE`; `score >= PASS_THRESHOLD`; `evidence_hash != [0u8; 32]`.
- Effects: write Credential; `profile.completed_count = checked_add(1)`; `profile.reputation = checked_add(score as u32)`; `emit!(CredentialIssued {...})`.
- Duplicate protection: `init` on an existing PDA fails. The client must pre-check and map the failure to `CredentialAlreadyExists` UX.
</INSTRUCTIONS>

<ERRORS>
```rust
#[error_code]
pub enum ProofError {
    #[msg("Invalid challenge id")] InvalidChallengeId,
    #[msg("Score must be between 0 and 100")] InvalidScore,
    #[msg("Score is below the passing threshold")] ScoreBelowThreshold,
    #[msg("Evidence hash must not be empty")] EmptyEvidenceHash,
    #[msg("Signer is not the authorized issuer")] UnauthorizedIssuer,
    #[msg("Arithmetic overflow")] MathOverflow,
    #[msg("Signer is not the program upgrade authority")] UnauthorizedAdmin,
}
```
</ERRORS>

<EVENTS>
```rust
#[event]
pub struct CredentialIssued {
    pub user: Pubkey,
    pub challenge_id: u8,
    pub score: u8,
    pub evidence_hash: [u8; 32],
    pub issuer: Pubkey,
    pub issued_at: i64,
}
```
</EVENTS>

<REQUIRED_TESTS>
`tests/proof_of_skill.ts` covers, each as its own test:
1. `initialize_config` succeeds for the upgrade authority; fails for another signer.
2. `initialize_profile` creates the PDA at the expected address with zeroed counters.
3. `issue_credential` succeeds with user + issuer; Credential fields and profile counters are correct.
4. Rejects `score > 100` (`InvalidScore`) and `score < 70` (`ScoreBelowThreshold`).
5. Rejects `challenge_id` 0 and 6 (`InvalidChallengeId`).
6. Rejects a signer that is not `config.issuer` (`UnauthorizedIssuer`).
7. Rejects a second credential for the same user + challenge.
8. Rejects a missing issuer signature.
9. PDA parity: `lib/solana/pdas.ts` derivations equal accounts created onchain (import or duplicate the seed logic exactly).
Assert on Anchor error codes/names, not on message substrings alone.
</REQUIRED_TESTS>

<SECURITY_CHECKLIST>
- [ ] Every PDA has seeds + bump constraints; no account passed unchecked.
- [ ] `has_one` links config→issuer and profile→user.
- [ ] All arithmetic is checked.
- [ ] No lamport transfer other than rent via `init`.
- [ ] No `UncheckedAccount` (or each has a `/// CHECK:` justification).
- [ ] `issuer` and `user` are both `Signer<'info>`.
- [ ] Event emitted only after all state writes succeed.
</SECURITY_CHECKLIST>
