export const CHALLENGE_IDS = [1, 2, 3, 4, 5] as const;

export type ChallengeId = (typeof CHALLENGE_IDS)[number];

export type Difficulty = "beginner" | "intermediate" | "advanced";

export type Category = "Solana" | "Anchor" | "Web3 Frontend" | "Security";

export type RubricCriterion = {
  id: string;
  label: string;
  weight: number;
};

export type Challenge = {
  /** Mirrors `MIN_CHALLENGE_ID..=MAX_CHALLENGE_ID` in the onchain program. */
  id: ChallengeId;
  slug: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  category: Category;
  estimatedMinutes: number;
  prompt: string;
  /** Weights must sum to exactly 100 — asserted by `data.test.ts`. */
  rubric: RubricCriterion[];
  credentialType: string;
};
