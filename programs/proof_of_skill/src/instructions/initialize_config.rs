use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::errors::ProofError;
use crate::program::ProofOfSkill;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [CONFIG_SEED],
        bump,
        space = 8 + Config::INIT_SPACE
    )]
    pub config: Account<'info, Config>,

    /// The onchain account of this program. Anchor checks it is executable and
    /// matches the declared program id, so `programdata_address()` cannot be
    /// spoofed with a foreign program account.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, ProofOfSkill>,

    /// ProgramData of this program, read only to resolve the upgrade authority.
    /// The `program` constraint above pins it to this program's own ProgramData.
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, issuer: Pubkey) -> Result<()> {
    let admin_key = ctx.accounts.admin.key();
    require!(
        ctx.accounts.program_data.upgrade_authority_address == Some(admin_key),
        ProofError::UnauthorizedAdmin
    );

    let config = &mut ctx.accounts.config;
    config.admin = admin_key;
    config.issuer = issuer;
    config.bump = ctx.bumps.config;

    Ok(())
}
