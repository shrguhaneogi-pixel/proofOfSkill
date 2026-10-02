use anchor_lang::prelude::*;

use crate::constants::{
    CONFIG_SEED, CREDENTIAL_SEED, MAX_CHALLENGE_ID, MAX_SCORE, MIN_CHALLENGE_ID, PASS_THRESHOLD,
    PROFILE_SEED,
};
use crate::errors::ProofError;
use crate::events::CredentialIssued;
use crate::state::{Config, Credential, UserProfile};

#[derive(Accounts)]
#[instruction(challenge_id: u8)]
pub struct IssueCredential<'info> {
    /// The wallet the credential is issued to. Pays rent and fees.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Co-signature required by `config.issuer`; the AI never holds this key.
    pub issuer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = issuer @ ProofError::UnauthorizedIssuer,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [PROFILE_SEED, user.key().as_ref()],
        bump = profile.bump,
        has_one = user,
    )]
    pub profile: Account<'info, UserProfile>,

    /// `init` on an already derived address fails, which is what enforces one
    /// credential per wallet per challenge.
    #[account(
        init,
        payer = user,
        seeds = [CREDENTIAL_SEED, user.key().as_ref(), &[challenge_id]],
        bump,
        space = 8 + Credential::INIT_SPACE
    )]
    pub credential: Account<'info, Credential>,

    pub system_program: Program<'info, System>,
}

pub fn handle_issue_credential(
    ctx: Context<IssueCredential>,
    challenge_id: u8,
    score: u8,
    evidence_hash: [u8; 32],
) -> Result<()> {
    require!(
        (MIN_CHALLENGE_ID..=MAX_CHALLENGE_ID).contains(&challenge_id),
        ProofError::InvalidChallengeId
    );
    require!(score <= MAX_SCORE, ProofError::InvalidScore);
    require!(score >= PASS_THRESHOLD, ProofError::ScoreBelowThreshold);
    require!(evidence_hash != [0u8; 32], ProofError::EmptyEvidenceHash);

    let issued_at = Clock::get()?.unix_timestamp;

    {
        let profile = &mut ctx.accounts.profile;
        profile.completed_count = profile
            .completed_count
            .checked_add(1)
            .ok_or(ProofError::MathOverflow)?;
        profile.reputation = profile
            .reputation
            .checked_add(score as u32)
            .ok_or(ProofError::MathOverflow)?;
    }

    let credential = &mut ctx.accounts.credential;
    credential.user = ctx.accounts.user.key();
    credential.issuer = ctx.accounts.issuer.key();
    credential.evidence_hash = evidence_hash;
    credential.issued_at = issued_at;
    credential.challenge_id = challenge_id;
    credential.score = score;
    credential.bump = ctx.bumps.credential;

    emit!(CredentialIssued {
        user: ctx.accounts.user.key(),
        challenge_id,
        score,
        evidence_hash,
        issuer: ctx.accounts.issuer.key(),
        issued_at,
    });

    Ok(())
}
