use anchor_lang::prelude::*;

#[event]
pub struct CredentialIssued {
    pub user: Pubkey,
    pub challenge_id: u8,
    pub score: u8,
    pub evidence_hash: [u8; 32],
    pub issuer: Pubkey,
    pub issued_at: i64,
}

/// Emitted by `update_config`. Both issuers are recorded so an auditor scanning
/// the log can tell a rotation from the key it replaced.
#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub previous_issuer: Pubkey,
    pub new_issuer: Pubkey,
}
