import type { Challenge } from "./types";

/**
 * Curated MVP catalogue. `id` values are part of the onchain contract: the
 * program only accepts `MIN_CHALLENGE_ID..=MAX_CHALLENGE_ID`, so adding an id
 * here without updating `programs/proof_of_skill/src/constants.rs` will make
 * issuance fail onchain.
 */
export const CHALLENGES: Challenge[] = [
  {
    id: 1,
    slug: "solana-pda-fundamentals",
    title: "Solana PDA Fundamentals",
    description:
      "Explain how program-derived addresses work and design a PDA scheme for a small onchain record.",
    difficulty: "beginner",
    category: "Solana",
    estimatedMinutes: 45,
    prompt: `You are designing the account layout for a skill-credential program.

Write an explanation (and optionally a code snippet) that covers:
1. How a PDA is derived, and why no wallet can ever sign for one.
2. A seed scheme for a per-wallet profile account and for one credential per
   wallet per challenge, including where the bump belongs.
3. What an attacker could do if the program trusted a client-supplied profile
   address instead of re-deriving it from seeds.

Answer in your own words. A Rust or TypeScript snippet is welcome but not
required. Do not paste documentation text.`,
    rubric: [
      { id: "pda_derivation", label: "PDA derivation mechanics", weight: 30 },
      { id: "account_relationships", label: "Account relationships and seeds", weight: 25 },
      { id: "security_implications", label: "Security implications", weight: 25 },
      { id: "clarity", label: "Clarity and completeness", weight: 20 },
    ],
    credentialType: "solana-pda-fundamentals",
  },
  {
    id: 2,
    slug: "solana-transaction-analysis",
    title: "Solana Transaction Analysis",
    description:
      "Read a real transaction layout and explain why it succeeded or failed.",
    difficulty: "intermediate",
    category: "Solana",
    estimatedMinutes: 60,
    prompt: `A transaction sends lamports from A to B, and a second instruction transfers a
token. It fails with "AccountNotFound" even though both addresses exist.

Explain:
1. What each account in the message must declare (signer, writable, executable)
   and how a missing writable flag surfaces at runtime.
2. How the fee payer, recent blockhash, and signature set interact, and what
   happens when the blockhash expires.
3. Two concrete ways you would diagnose the failing account, naming the RPC
   method or Explorer view you would use.

Submit your reasoning; a snippet of the account list is a bonus.`,
    rubric: [
      { id: "account_roles", label: "Account role semantics", weight: 30 },
      { id: "blockhash_fees", label: "Blockhash and fee mechanics", weight: 25 },
      { id: "diagnosis", label: "Diagnosis method", weight: 25 },
      { id: "clarity", label: "Clarity and completeness", weight: 20 },
    ],
    credentialType: "solana-transaction-analysis",
  },
  {
    id: 3,
    slug: "anchor-program-fundamentals",
    title: "Anchor Program Fundamentals",
    description:
      "Show you can write safe Anchor account constraints and initialization.",
    difficulty: "intermediate",
    category: "Anchor",
    estimatedMinutes: 75,
    prompt: `Design the accounts struct for an instruction that lets a user open a vault
account holding a score, minted by an authorized authority.

Cover:
1. The #[account(...)] constraints you would use for the vault, including seeds,
   bump, payer, and space, and why each matters.
2. How you would restrict who may create or mutate the vault, and which Anchor
   helper enforces it.
3. The difference between init, init_if_needed, and mut on an existing account,
   and which one you avoid.

A real Rust struct is strongly encouraged. Explain every constraint you keep.`,
    rubric: [
      { id: "seeds_and_space", label: "Seeds, bump and space", weight: 30 },
      { id: "access_control", label: "Access control constraints", weight: 30 },
      { id: "init_semantics", label: "init semantics", weight: 20 },
      { id: "clarity", label: "Clarity and completeness", weight: 20 },
    ],
    credentialType: "anchor-program-fundamentals",
  },
  {
    id: 4,
    slug: "typescript-web3-integration",
    title: "TypeScript Web3 Integration",
    description:
      "Build a wallet-signed transaction flow in TypeScript without lying to the user.",
    difficulty: "intermediate",
    category: "Web3 Frontend",
    estimatedMinutes: 60,
    prompt: `Write the client-side logic that signs and confirms a transaction with a
browser wallet, then shows the result to the user.

Requirements:
1. Handle these states explicitly: disconnected, connecting, connected, signing,
   submitted, confirming, success, failed.
2. Confirm the transaction correctly and explain why waiting on a blockhash
   expiry is better than polling a fixed timeout.
3. Never fabricate a signature or Explorer link. Explain what you render before
   the wallet has actually signed.

Submit real TypeScript. Partial credit if the state machine is right but the
types are loose.`,
    rubric: [
      { id: "state_coverage", label: "Wallet state coverage", weight: 30 },
      { id: "confirmation", label: "Confirmation strategy", weight: 25 },
      { id: "honesty", label: "No fabricated results", weight: 25 },
      { id: "clarity", label: "Clarity and completeness", weight: 20 },
    ],
    credentialType: "typescript-web3-integration",
  },
  {
    id: 5,
    slug: "smart-contract-security-basics",
    title: "Smart Contract Security Basics",
    description:
      "Find the real vulnerabilities in a small program and propose fixes.",
    difficulty: "advanced",
    category: "Security",
    estimatedMinutes: 90,
    prompt: `Review this instruction:

    #[derive(Accounts)]
    pub struct MintBadges<'info> {
        #[account(mut)]
        pub user: Signer<'info>,
        #[account(mut)]
        pub badge: Account<'info, Badge>,
        pub system_program: Program<'info, System>,
    }

    pub fn mint_badges(ctx: Context<MintBadges>, count: u64) -> Result<()> {
        ctx.accounts.badge.supply += count;
        Ok(())
    }

List every problem you can defend, ordered by severity, and give the concrete
fix for each (constraint, check, or error variant). State which issues you could
NOT prove from the snippet alone.`,
    rubric: [
      { id: "missing_checks", label: "Missing ownership and seed checks", weight: 30 },
      { id: "arithmetic", label: "Unchecked arithmetic", weight: 25 },
      { id: "authorization", label: "Authorization and signer gaps", weight: 25 },
      { id: "clarity", label: "Severity ranking and honesty", weight: 20 },
    ],
    credentialType: "smart-contract-security-basics",
  },
];

export function findChallenge(id: number): Challenge | undefined {
  return CHALLENGES.find((challenge) => challenge.id === id);
}

export function findChallengeBySlug(slug: string): Challenge | undefined {
  return CHALLENGES.find((challenge) => challenge.slug === slug);
}
