use anchor_lang::prelude::*;

use crate::constants::PROFILE_SEED;
use crate::state::UserProfile;

#[derive(Accounts)]
pub struct InitializeProfile<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        seeds = [PROFILE_SEED, user.key().as_ref()],
        bump,
        space = 8 + UserProfile::INIT_SPACE
    )]
    pub profile: Account<'info, UserProfile>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_profile(ctx: Context<InitializeProfile>) -> Result<()> {
    let profile = &mut ctx.accounts.profile;
    profile.user = ctx.accounts.user.key();
    profile.created_at = Clock::get()?.unix_timestamp;
    profile.completed_count = 0;
    profile.reputation = 0;
    profile.bump = ctx.bumps.profile;

    Ok(())
}
