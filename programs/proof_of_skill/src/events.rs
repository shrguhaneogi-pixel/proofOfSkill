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
