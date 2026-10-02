use anchor_lang::prelude::*;

#[error_code]
pub enum ProofError {
    #[msg("Invalid challenge id")]
    InvalidChallengeId,
    #[msg("Score must be between 0 and 100")]
    InvalidScore,
    #[msg("Score is below the passing threshold")]
    ScoreBelowThreshold,
    #[msg("Evidence hash must not be empty")]
    EmptyEvidenceHash,
    #[msg("Signer is not the authorized issuer")]
    UnauthorizedIssuer,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Signer is not the program upgrade authority")]
    UnauthorizedAdmin,
}
