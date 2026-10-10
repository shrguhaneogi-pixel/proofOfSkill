//! Host-runnable parity tests for the `proof_of_skill` program.
//!
//! `anchor build` is blocked on this host (anchor-cli 0.29 shells out to the
//! absent `cargo-build-bpf`), so there is no `.so`, no IDL and `anchor test`
//! cannot run. These tests are the verification that *is* available: they pin
//! the constant math, account discriminators, account byte layouts and PDA
//! derivations that the TypeScript client under `lib/` independently
//! reproduces. The expected values below were derived independently of this
//! crate for the TypeScript client, so a failure here is a real cross-language
//! integration bug rather than a stale expectation — never "fix" an expectation
//! to make a test pass.
//!
//! Scope limits, stated plainly: the `require!` checks inside the
//! `Context<...>` handlers (`handle_initialize_config`,
//! `handle_initialize_profile`, `handle_issue_credential`) need a Solana
//! runtime and are NOT exercised here. They belong to the blocked
//! `anchor test` suite. Nothing below fakes a `Context`.

use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_lang::{Discriminator, InstructionData};

use crate::instruction;
use crate::{Config, Credential, UserProfile};

/// The program id the TypeScript client is configured with.
const EXPECTED_PROGRAM_ID: &str = "5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3";

/// A wallet used as the fixed subject of every PDA derivation in this file.
const USER: &str = "Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j";

/// Anchor reserves the first 8 bytes of every account for the discriminator.
const DISCRIMINATOR_LEN: usize = 8;

fn pubkey(value: &str) -> Pubkey {
    Pubkey::from_str(value)
        .unwrap_or_else(|error| panic!("{value} is not a valid base58 pubkey: {error:?}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Serializes an account exactly the way Anchor persists it onchain:
/// `discriminator || borsh(fields)`.
fn serialize_account<T: AccountSerialize>(account: &T) -> Vec<u8> {
    let mut buffer = Vec::new();
    account
        .try_serialize(&mut buffer)
        .expect("account serialization must succeed");
    buffer
}

// ---------------------------------------------------------------------------
// 0. Program id — the anchor every PDA assertion below hangs from.
// ---------------------------------------------------------------------------

#[test]
fn program_id_matches_the_typescript_client() {
    assert_eq!(crate::ID.to_string(), EXPECTED_PROGRAM_ID);
}

// ---------------------------------------------------------------------------
// 1. Account discriminators: sha256("account:<StructName>")[..8].
// ---------------------------------------------------------------------------

#[test]
fn config_account_discriminator() {
    assert_eq!(
        hex(&<Config as Discriminator>::DISCRIMINATOR),
        "9b0caae01efacc82"
    );
}

#[test]
fn user_profile_account_discriminator() {
    assert_eq!(
        hex(&<UserProfile as Discriminator>::DISCRIMINATOR),
        "202577cdb3b40dc2"
    );
}

#[test]
fn credential_account_discriminator() {
    assert_eq!(
        hex(&<Credential as Discriminator>::DISCRIMINATOR),
        "912c44dc432e6487"
    );
}

/// The three accounts must be mutually distinguishable, otherwise a client
/// decoding an account buffer could not tell which schema applies.
#[test]
fn account_discriminators_are_mutually_distinct() {
    let discriminators = [
        <Config as Discriminator>::DISCRIMINATOR,
        <UserProfile as Discriminator>::DISCRIMINATOR,
        <Credential as Discriminator>::DISCRIMINATOR,
    ];
    let unique: std::collections::BTreeSet<[u8; 8]> = discriminators.into_iter().collect();
    assert_eq!(
        unique.len(),
        3,
        "account discriminators collide: {discriminators:?}"
    );
}

// ---------------------------------------------------------------------------
// 2. Account space math: `space = 8 + T::INIT_SPACE` as used by `#[account(init)]`.
// ---------------------------------------------------------------------------

#[test]
fn config_account_space() {
    assert_eq!(<Config as Space>::INIT_SPACE, 65);
    assert_eq!(DISCRIMINATOR_LEN + <Config as Space>::INIT_SPACE, 73);
}

#[test]
fn user_profile_account_space() {
    assert_eq!(<UserProfile as Space>::INIT_SPACE, 49);
    assert_eq!(DISCRIMINATOR_LEN + <UserProfile as Space>::INIT_SPACE, 57);
}

#[test]
fn credential_account_space() {
    assert_eq!(<Credential as Space>::INIT_SPACE, 107);
    assert_eq!(DISCRIMINATOR_LEN + <Credential as Space>::INIT_SPACE, 115);
}

/// `InitSpace` is a hand-maintained estimate; the real account bytes come from
/// borsh. If the two ever disagree, the `init` space allocation is wrong and
/// the TypeScript decoder is reading past the end of the data.
#[test]
fn declared_space_matches_the_actually_serialized_length() {
    for (name, init_space, bytes) in [
        (
            "Config",
            <Config as Space>::INIT_SPACE,
            serialize_account(&sample_config()),
        ),
        (
            "UserProfile",
            <UserProfile as Space>::INIT_SPACE,
            serialize_account(&sample_profile()),
        ),
        (
            "Credential",
            <Credential as Space>::INIT_SPACE,
            serialize_account(&sample_credential()),
        ),
    ] {
        assert_eq!(
            bytes.len(),
            DISCRIMINATOR_LEN + init_space,
            "{name} serialized to {} bytes but 8 + INIT_SPACE is {}",
            bytes.len(),
            DISCRIMINATOR_LEN + init_space
        );
    }
}

// ---------------------------------------------------------------------------
// 2b. Field offsets. The spec requires `user` first in UserProfile and
// Credential so clients can `memcmp` at offset 8, and the TypeScript decoder
// hard-codes every following offset.
// ---------------------------------------------------------------------------

#[test]
fn config_field_offsets() {
    let config = sample_config();
    let bytes = serialize_account(&config);
    assert_eq!(&bytes[..8], &<Config as Discriminator>::DISCRIMINATOR);
    assert_eq!(&bytes[8..40], config.admin.as_ref(), "Config.admin");
    assert_eq!(&bytes[40..72], config.issuer.as_ref(), "Config.issuer");
    assert_eq!(bytes[72], config.bump, "Config.bump");
}

#[test]
fn user_profile_field_offsets() {
    let profile = sample_profile();
    let bytes = serialize_account(&profile);
    assert_eq!(&bytes[..8], &<UserProfile as Discriminator>::DISCRIMINATOR);
    assert_eq!(
        &bytes[8..40],
        profile.user.as_ref(),
        "UserProfile.user must sit at offset 8 for the memcmp filter"
    );
    assert_eq!(&bytes[40..48], &profile.created_at.to_le_bytes());
    assert_eq!(&bytes[48..52], &profile.completed_count.to_le_bytes());
    assert_eq!(&bytes[52..56], &profile.reputation.to_le_bytes());
    assert_eq!(bytes[56], profile.bump);
}

#[test]
fn credential_field_offsets() {
    let credential = sample_credential();
    let bytes = serialize_account(&credential);
    assert_eq!(&bytes[..8], &<Credential as Discriminator>::DISCRIMINATOR);
    assert_eq!(
        &bytes[8..40],
        credential.user.as_ref(),
        "Credential.user must sit at offset 8 for the memcmp filter"
    );
    assert_eq!(&bytes[40..72], credential.issuer.as_ref());
    assert_eq!(&bytes[72..104], &credential.evidence_hash);
    assert_eq!(&bytes[104..112], &credential.issued_at.to_le_bytes());
    assert_eq!(bytes[112], credential.challenge_id);
    assert_eq!(bytes[113], credential.score);
    assert_eq!(bytes[114], credential.bump);
}

/// The decode path the client mirrors: Anchor refuses a buffer whose
/// discriminator is not its own, and round-trips a correct one.
#[test]
fn accounts_round_trip_through_the_anchor_decode_path() {
    let config = sample_config();
    let decoded_config = Config::try_deserialize(&mut &serialize_account(&config)[..])
        .expect("Config must decode from its own bytes");
    assert_eq!(decoded_config.admin, config.admin);
    assert_eq!(decoded_config.issuer, config.issuer);
    assert_eq!(decoded_config.bump, config.bump);

    let profile = sample_profile();
    let decoded_profile = UserProfile::try_deserialize(&mut &serialize_account(&profile)[..])
        .expect("UserProfile must decode from its own bytes");
    assert_eq!(decoded_profile.user, profile.user);
    assert_eq!(decoded_profile.created_at, profile.created_at);
    assert_eq!(decoded_profile.completed_count, profile.completed_count);
    assert_eq!(decoded_profile.reputation, profile.reputation);
    assert_eq!(decoded_profile.bump, profile.bump);

    let credential = sample_credential();
    let decoded_credential = Credential::try_deserialize(&mut &serialize_account(&credential)[..])
        .expect("Credential must decode from its own bytes");
    assert_eq!(decoded_credential.user, credential.user);
    assert_eq!(decoded_credential.issuer, credential.issuer);
    assert_eq!(decoded_credential.evidence_hash, credential.evidence_hash);
    assert_eq!(decoded_credential.issued_at, credential.issued_at);
    assert_eq!(decoded_credential.challenge_id, credential.challenge_id);
    assert_eq!(decoded_credential.score, credential.score);
    assert_eq!(decoded_credential.bump, credential.bump);
}

#[test]
fn decode_rejects_an_account_with_the_wrong_discriminator() {
    let mut bytes = serialize_account(&sample_credential());
    bytes[..DISCRIMINATOR_LEN].copy_from_slice(&<Config as Discriminator>::DISCRIMINATOR);
    // `Credential` has no `Debug`, so this cannot use `expect_err`.
    match Credential::try_deserialize(&mut &bytes[..]) {
        Ok(_) => panic!("a Credential carrying the Config discriminator must not decode"),
        Err(anchor_lang::error::Error::AnchorError(inner)) => {
            assert_eq!(inner.error_name, "AccountDiscriminatorMismatch");
        }
        Err(other) => panic!("expected an AnchorError, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 3. PDA seed parity with lib/solana/pdas.ts.
// ---------------------------------------------------------------------------

#[test]
fn pda_seed_prefixes_are_the_documented_literals() {
    // Materialised as strings so this compares runtime values rather than two
    // compile-time constants that would fold to `true`.
    let seeds: Vec<String> = [
        crate::CONFIG_SEED,
        crate::PROFILE_SEED,
        crate::CREDENTIAL_SEED,
    ]
    .iter()
    .map(|seed| String::from_utf8(seed.to_vec()).expect("seeds are ascii"))
    .collect();
    assert_eq!(seeds, vec!["config", "profile", "credential"]);
}

#[test]
fn config_pda_matches_the_typescript_client() {
    let (address, bump) = Pubkey::find_program_address(&[crate::CONFIG_SEED], &crate::ID);
    assert_eq!(
        (address.to_string(), bump),
        (
            "Amw2c7oVJNxtbKpWoetmghSqL8VY5Le1wBj9UbFL1TY4".to_string(),
            255u8
        ),
        "PDA mismatch for seeds [config]"
    );
}

#[test]
fn profile_pda_matches_the_typescript_client() {
    let user = pubkey(USER);
    let (address, bump) =
        Pubkey::find_program_address(&[crate::PROFILE_SEED, user.as_ref()], &crate::ID);
    assert_eq!(
        (address.to_string(), bump),
        (
            "A94CxDeVUUi7VPGTg8175hYogkma2eRoiWQ1C41hE5Xw".to_string(),
            255u8
        ),
        "PDA mismatch for seeds [profile, user]"
    );
}

#[test]
fn credential_pdas_match_the_typescript_client() {
    let user = pubkey(USER);
    let cases: [(u8, &str, u8); 5] = [
        (1, "4JzYzqr1CMNmntfSpatBngb9uHGYQqoJfyXkyn6rARKW", 255),
        (2, "575ztNWrf36zKK2qb2FkwCYgf8QNNPWwtP3AdxyPoLe5", 255),
        (3, "BPDd5n2BcgKfhgFyUisdRFxQR6PtjELavQfzs9LUUEHs", 249),
        (4, "6BUcDQaTADfXjVVPEXyd5Q3a5dkVykRwMfHZF7dM5z2G", 254),
        (5, "5Tj8zs2NjYH3k99FemR1ehu4NreneizumE1zKytEvqt4", 254),
    ];
    for (challenge_id, expected_address, expected_bump) in cases {
        let (address, bump) = Pubkey::find_program_address(
            &[crate::CREDENTIAL_SEED, user.as_ref(), &[challenge_id]],
            &crate::ID,
        );
        assert_eq!(
            (address.to_string(), bump),
            (expected_address.to_string(), expected_bump),
            "PDA mismatch for seeds [credential, user, [{challenge_id}]]"
        );
    }
}

/// The `bump` fields written by the handlers must be the canonical bumps the
/// client derives, or every later `seeds = ..., bump = account.bump`
/// constraint rejects the account it created itself.
#[test]
fn stored_bump_is_the_canonical_bump_for_the_same_seeds() {
    let user = pubkey(USER);
    let config = sample_config();
    assert_eq!(
        config.bump,
        Pubkey::find_program_address(&[crate::CONFIG_SEED], &crate::ID).1
    );

    let profile = sample_profile();
    assert_eq!(
        profile.bump,
        Pubkey::find_program_address(&[crate::PROFILE_SEED, user.as_ref()], &crate::ID).1
    );

    let credential = sample_credential();
    assert_eq!(
        credential.bump,
        Pubkey::find_program_address(
            &[
                crate::CREDENTIAL_SEED,
                user.as_ref(),
                &[credential.challenge_id]
            ],
            &crate::ID
        )
        .1
    );
}

// ---------------------------------------------------------------------------
// 4. Instruction discriminators and wire format: sha256("global:<ix_name>")[..8].
// ---------------------------------------------------------------------------

#[test]
fn initialize_config_instruction_discriminator() {
    assert_eq!(
        hex(&<instruction::InitializeConfig as Discriminator>::DISCRIMINATOR),
        "d07f1501c2bec446"
    );
}

#[test]
fn initialize_profile_instruction_discriminator() {
    assert_eq!(
        hex(&<instruction::InitializeProfile as Discriminator>::DISCRIMINATOR),
        "20914dd53a27fbea"
    );
}

#[test]
fn issue_credential_instruction_discriminator() {
    assert_eq!(
        hex(&<instruction::IssueCredential as Discriminator>::DISCRIMINATOR),
        "ffc1abe044abc257"
    );
}

#[test]
fn update_config_instruction_discriminator() {
    assert_eq!(
        hex(&<instruction::UpdateConfig as Discriminator>::DISCRIMINATOR),
        "1d9efcbf0a53db63"
    );
}

/// `update_config` takes the same argument as `initialize_config` — one bare
/// `Pubkey` — so the client can reuse the encoder's layout, but its sighash must
/// differ or a rotation would be indistinguishable from a first-time register.
#[test]
fn update_config_wire_format_is_a_distinct_sighash_over_the_same_argument() {
    let issuer = pubkey(USER);
    let data = instruction::UpdateConfig { issuer }.data();
    assert_eq!(data.len(), 8 + 32);
    assert_eq!(
        &data[..8],
        <instruction::UpdateConfig as Discriminator>::DISCRIMINATOR,
        "update_config must carry its own sighash"
    );
    assert_ne!(
        &data[..8],
        <instruction::InitializeConfig as Discriminator>::DISCRIMINATOR,
        "update_config must not collide with initialize_config"
    );
    assert_eq!(&data[8..], issuer.as_ref());
}

/// `InstructionData::data()` is exactly the 8-byte sighash plus borsh arguments
/// the client must put on the wire — the byte-for-byte contract for a hand
/// built transaction.
#[test]
fn instruction_wire_format() {
    let issuer = pubkey(USER);
    let config_data = instruction::InitializeConfig { issuer }.data();
    assert_eq!(config_data.len(), 8 + 32);
    assert_eq!(
        &config_data[..8],
        &<instruction::InitializeConfig as Discriminator>::DISCRIMINATOR
    );
    assert_eq!(
        &config_data[8..],
        issuer.as_ref(),
        "issuer is borsh-encoded raw"
    );

    let profile_data = instruction::InitializeProfile.data();
    assert_eq!(
        profile_data,
        <instruction::InitializeProfile as Discriminator>::DISCRIMINATOR.to_vec(),
        "initialize_profile takes no arguments, so its data is the sighash alone"
    );

    let evidence_hash = [0xabu8; 32];
    let credential_data = instruction::IssueCredential {
        challenge_id: 3,
        score: 90,
        evidence_hash,
    }
    .data();
    assert_eq!(credential_data.len(), 8 + 1 + 1 + 32);
    assert_eq!(
        &credential_data[..8],
        &<instruction::IssueCredential as Discriminator>::DISCRIMINATOR
    );
    assert_eq!(&credential_data[8..10], &[3u8, 90u8]);
    assert_eq!(&credential_data[10..], &evidence_hash);
}

#[test]
fn instruction_discriminators_are_distinct_from_each_other_and_from_accounts() {
    let mut all: Vec<[u8; 8]> = vec![
        <instruction::InitializeConfig as Discriminator>::DISCRIMINATOR,
        <instruction::UpdateConfig as Discriminator>::DISCRIMINATOR,
        <instruction::InitializeProfile as Discriminator>::DISCRIMINATOR,
        <instruction::IssueCredential as Discriminator>::DISCRIMINATOR,
        <Config as Discriminator>::DISCRIMINATOR,
        <UserProfile as Discriminator>::DISCRIMINATOR,
        <Credential as Discriminator>::DISCRIMINATOR,
    ];
    let total = all.len();
    all.sort_unstable();
    all.dedup();
    assert_eq!(
        all.len(),
        total,
        "sighash collision across ix/account types"
    );
}

// ---------------------------------------------------------------------------
// 5. Spec constants and the boundaries they imply.
// ---------------------------------------------------------------------------

/// The challenge-id set the program accepts, enumerated by the same range
/// expression `handle_issue_credential` uses.
fn accepted_challenge_ids() -> Vec<u8> {
    (0u8..=u8::MAX)
        .filter(|challenge_id| {
            (crate::MIN_CHALLENGE_ID..=crate::MAX_CHALLENGE_ID).contains(challenge_id)
        })
        .collect()
}

/// The score window implied by the two handler checks on `score`, enumerated
/// over the whole `u8` domain.
fn accepted_scores() -> Vec<u8> {
    (0u8..=u8::MAX)
        .filter(|score| *score >= crate::PASS_THRESHOLD && *score <= crate::MAX_SCORE)
        .collect()
}

/// Scores the `score <= MAX_SCORE` check rejects.
fn scores_above_max() -> Vec<u8> {
    (0u8..=u8::MAX)
        .filter(|score| *score > crate::MAX_SCORE)
        .collect()
}

/// Scores the `score >= PASS_THRESHOLD` check rejects.
fn scores_below_threshold() -> Vec<u8> {
    (0u8..=u8::MAX)
        .filter(|score| *score < crate::PASS_THRESHOLD)
        .collect()
}

#[test]
fn challenge_id_boundaries_match_the_frontend_catalogue() {
    assert_eq!(accepted_challenge_ids(), vec![1u8, 2, 3, 4, 5]);
    assert_eq!(accepted_challenge_ids().len(), 5);
    assert_eq!(crate::MIN_CHALLENGE_ID, 1);
    assert_eq!(crate::MAX_CHALLENGE_ID, 5);
}

#[test]
fn score_boundaries_are_seventy_through_one_hundred() {
    let scores = accepted_scores();
    assert_eq!(scores.len(), 31);
    assert_eq!(scores.first().copied(), Some(70));
    assert_eq!(scores.last().copied(), Some(100));
    assert_eq!(crate::PASS_THRESHOLD, 70);
    assert_eq!(crate::MAX_SCORE, 100);
}

/// The two `require!`s on `score` are not dead code and the window they
/// intersect is not empty: a credential can actually be issued. Asserted
/// through the enumerated sets so the check is over real values rather than a
/// compile-time comparison of two constants.
#[test]
fn score_checks_are_all_reachable_and_mutually_consistent() {
    let accepted = accepted_scores();
    assert!(!accepted.is_empty());
    assert_eq!(accepted.first().copied(), Some(crate::PASS_THRESHOLD));
    assert_eq!(accepted.last().copied(), Some(crate::MAX_SCORE));

    let above_max = scores_above_max();
    assert!(!above_max.is_empty());
    assert_eq!(above_max.first().copied(), Some(crate::MAX_SCORE + 1));
    assert_eq!(above_max.len(), usize::from(u8::MAX - crate::MAX_SCORE));

    let below_threshold = scores_below_threshold();
    assert!(!below_threshold.is_empty());
    assert_eq!(below_threshold.first().copied(), Some(0));
    assert_eq!(
        below_threshold.last().copied(),
        Some(crate::PASS_THRESHOLD - 1)
    );
    assert_eq!(below_threshold.len(), usize::from(crate::PASS_THRESHOLD));

    let ids = accepted_challenge_ids();
    assert_eq!(ids.first().copied(), Some(crate::MIN_CHALLENGE_ID));
    assert_eq!(ids.last().copied(), Some(crate::MAX_CHALLENGE_ID));
    assert_eq!(
        ids.len(),
        usize::from(crate::MAX_CHALLENGE_ID - crate::MIN_CHALLENGE_ID) + 1
    );
}

// ---------------------------------------------------------------------------
// Fixtures — fixed literals only, so every test is deterministic.
// ---------------------------------------------------------------------------

fn sample_config() -> Config {
    Config {
        admin: Pubkey::new_from_array([2u8; 32]),
        issuer: Pubkey::new_from_array([1u8; 32]),
        bump: 255,
    }
}

fn sample_profile() -> UserProfile {
    UserProfile {
        user: pubkey(USER),
        created_at: 1_759_000_000,
        completed_count: 0,
        reputation: 0,
        bump: 255,
    }
}

fn sample_credential() -> Credential {
    Credential {
        user: pubkey(USER),
        issuer: Pubkey::new_from_array([1u8; 32]),
        evidence_hash: [0xabu8; 32],
        issued_at: 1_759_000_000,
        challenge_id: 3,
        score: 90,
        bump: 249,
    }
}
