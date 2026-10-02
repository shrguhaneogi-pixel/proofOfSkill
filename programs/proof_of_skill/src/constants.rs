pub const CONFIG_SEED: &[u8] = b"config";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const CREDENTIAL_SEED: &[u8] = b"credential";

/// Challenge identifiers accepted onchain. Must stay in sync with the
/// `lib/challenges/data.ts` catalogue in the frontend.
pub const MIN_CHALLENGE_ID: u8 = 1;
pub const MAX_CHALLENGE_ID: u8 = 5;

pub const MAX_SCORE: u8 = 100;
pub const PASS_THRESHOLD: u8 = 70;
