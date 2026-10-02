use anchor_lang::prelude::*;

/// Issued skill credential, PDA seeds `["credential", user, [challenge_id]]`.
///
/// Existence of this account is the proof of a pass: `issue_credential` rejects
/// any score below `PASS_THRESHOLD`, so there is deliberately no `passed` field.
#[account]
#[derive(InitSpace)]
pub struct Credential {
    /// Kept first so clients can index credentials with a `memcmp` filter at offset 8.
    pub user: Pubkey,
    /// The issuer recorded in `Config` at issuance time.
    pub issuer: Pubkey,
    /// SHA-256 of the canonicalized submission. Binds the credential to the
    /// evidence representation, not to the quality of the work.
    pub evidence_hash: [u8; 32],
    pub issued_at: i64,
    pub challenge_id: u8,
    pub score: u8,
    pub bump: u8,
}
