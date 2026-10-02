use anchor_lang::prelude::*;

/// Program-wide configuration, PDA seeds `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Upgrade authority at the time Config was created.
    pub admin: Pubkey,
    /// The only key allowed to co-sign `issue_credential`.
    pub issuer: Pubkey,
    pub bump: u8,
}
