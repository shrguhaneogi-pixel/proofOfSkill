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
    /// Appended last on purpose: Anchor derives each error code from the variant's
    /// position, so inserting above this would silently renumber every existing
    /// code and break the client's error mapping.
    #[msg("New issuer must be a key that can sign")]
    UnusableIssuer,
}
