use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::errors::ProofError;
use crate::events::ConfigUpdated;
use crate::state::Config;

/// Rotates the authorized issuer without redeploying the program.
///
/// `has_one = admin` binds `config.admin` (written once by `initialize_config`) to the
/// `admin` signer, so only the key that created Config can move the issuer. The plan's
/// original design kept rotation behind the upgrade authority; that is strictly weaker,
/// because the upgrade authority can already replace the program the issuer is trusted
/// by, whereas `config.admin` can only rotate the issuer.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// `mut` because this key is the transaction fee payer, which the runtime
    /// requires to be writable.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ProofError::UnauthorizedAdmin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, issuer: Pubkey) -> Result<()> {
    // The all-zero key is a valid Pubkey but can never sign, so accepting it would
    // brick issuance with no way back short of a redeploy.
    require!(issuer != Pubkey::default(), ProofError::UnusableIssuer);

    let admin = ctx.accounts.admin.key();
    let previous_issuer = ctx.accounts.config.issuer;
    ctx.accounts.config.issuer = issuer;

    emit!(ConfigUpdated {
        admin,
        previous_issuer,
        new_issuer: issuer,
    });

    Ok(())
}
