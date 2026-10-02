pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

#[cfg(test)]
mod tests;

use anchor_lang::prelude::*;

pub use constants::*;
pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3");

#[program]
pub mod proof_of_skill {
    use super::*;

    /// Registers the keypair that is allowed to co-sign credential issuance.
    /// Restricted to the program upgrade authority so the issuer can never be
    /// taken over by a third party after deployment.
    pub fn initialize_config(ctx: Context<InitializeConfig>, issuer: Pubkey) -> Result<()> {
        initialize_config::handle_initialize_config(ctx, issuer)
    }

    pub fn initialize_profile(ctx: Context<InitializeProfile>) -> Result<()> {
        initialize_profile::handle_initialize_profile(ctx)
    }

    pub fn issue_credential(
        ctx: Context<IssueCredential>,
        challenge_id: u8,
        score: u8,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        issue_credential::handle_issue_credential(ctx, challenge_id, score, evidence_hash)
    }
}
