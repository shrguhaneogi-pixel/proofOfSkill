use anchor_lang::prelude::*;

/// Per-wallet profile, PDA seeds `["profile", user]`.
#[account]
#[derive(InitSpace)]
pub struct UserProfile {
    /// Kept first so clients can index profiles with a `memcmp` filter at offset 8.
    pub user: Pubkey,
    pub created_at: i64,
    pub completed_count: u32,
    /// Sum of issued credential scores; a simple monotonic reputation signal.
    pub reputation: u32,
    pub bump: u8,
}
