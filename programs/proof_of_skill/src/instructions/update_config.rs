use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::errors::ProofError;
use crate::events::ConfigUpdated;
use crate::program::ProofOfSkill;
use crate::state::Config;

/// Rotates the authorized issuer without redeploying the program.
///
/// Two independent bindings must both hold, and neither alone is sufficient:
///
/// - `has_one = admin` against `config.admin`, so only the key that created Config can
///   move the issuer; and
/// - the handler's check that the same signer is *still* the program's upgrade authority.
///
/// The second check is not redundant. `initialize_config` freezes `config.admin` to the
/// upgrade authority as it stood at creation, and nothing ever rewrites it — so after the
/// authority is transferred or renounced, a `has_one = admin`-only guard would let the
/// demoted key keep rotating the issuer forever while the authority that actually controls
/// the program today had no path in. Checking both makes rotation track control of the
/// program instead of a snapshot of it.
///
/// Consequence to accept deliberately: renouncing the upgrade authority (the usual end
/// state of a final deploy) makes the issuer permanently unrotatable. If that is the plan,
/// rotate to the long-lived issuer *before* renouncing.
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

    /// Resolved exactly as in `initialize_config`: Anchor checks this is this program and
    /// that `programdata_address()` matches, so a caller cannot substitute a foreign
    /// program's ProgramData to make the authority check pass.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, ProofOfSkill>,

    /// Read only, to resolve the *current* upgrade authority.
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, issuer: Pubkey) -> Result<()> {
    // The all-zero key is a valid Pubkey but can never sign, so accepting it would
    // brick issuance with no way back short of a redeploy.
    require!(issuer != Pubkey::default(), ProofError::UnusableIssuer);

    require!(
        ctx.accounts.program_data.upgrade_authority_address == Some(ctx.accounts.admin.key()),
        ProofError::UnauthorizedAdmin
    );

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
