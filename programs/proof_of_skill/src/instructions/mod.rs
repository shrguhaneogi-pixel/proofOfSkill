pub mod initialize_config;
pub mod initialize_profile;
pub mod issue_credential;

// Anchor 0.29 codegen emits `pub use crate::__client_accounts_<ix>;` from the
// `#[program]` expansion, so the derive-generated modules have to be reachable
// at the crate root. Globs are the only form that works: the generated modules
// are `pub(crate)`, and an explicit `pub use` of them is rejected (E0365).
pub use initialize_config::*;
pub use initialize_profile::*;
pub use issue_credential::*;
