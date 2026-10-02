import { describe, expect, it } from "vitest";

import { CHALLENGES, findChallenge, findChallengeBySlug } from "./data";
import { CHALLENGE_IDS } from "./types";

describe("challenge catalogue", () => {
  it("covers exactly the ids the program accepts", () => {
    const ids = CHALLENGES.map((challenge) => challenge.id);
    expect([...ids].sort()).toEqual([...CHALLENGE_IDS]);
  });

  it("has unique ids and slugs", () => {
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(CHALLENGES.length);
    expect(new Set(CHALLENGES.map((c) => c.slug)).size).toBe(CHALLENGES.length);
  });

  it("has rubric weights that sum to exactly 100", () => {
    for (const challenge of CHALLENGES) {
      const total = challenge.rubric.reduce((sum, criterion) => sum + criterion.weight, 0);
      expect(total, `challenge ${challenge.id} weights`).toBe(100);
    }
  });

  it("has unique rubric criterion ids per challenge", () => {
    for (const challenge of CHALLENGES) {
      const ids = challenge.rubric.map((criterion) => criterion.id);
      expect(new Set(ids).size, `challenge ${challenge.id} criterion ids`).toBe(ids.length);
      for (const criterion of challenge.rubric) {
        expect(criterion.label.length).toBeGreaterThan(0);
        expect(criterion.weight).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every user-facing string populated", () => {
    for (const challenge of CHALLENGES) {
      for (const field of ["title", "description", "prompt", "credentialType"] as const) {
        expect(challenge[field].trim().length, `challenge ${challenge.id} ${field}`).toBeGreaterThan(
          0,
        );
      }
      expect(challenge.estimatedMinutes).toBeGreaterThan(0);
    }
  });

  it("looks up by id and by slug", () => {
    expect(findChallenge(1)?.slug).toBe("solana-pda-fundamentals");
    expect(findChallengeBySlug("solana-pda-fundamentals")?.id).toBe(1);
    expect(findChallenge(99)).toBeUndefined();
    expect(findChallengeBySlug("nope")).toBeUndefined();
  });

  it("pins the challenge 1 rubric that the spec fixes", () => {
    expect(findChallenge(1)?.rubric.map((criterion) => [criterion.id, criterion.weight])).toEqual([
      ["pda_derivation", 30],
      ["account_relationships", 25],
      ["security_implications", 25],
      ["clarity", 20],
    ]);
  });
});
