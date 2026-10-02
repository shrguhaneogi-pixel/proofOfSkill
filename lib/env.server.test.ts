import { describe, expect, it, vi } from "vitest";

// `server-only` resolves to a throwing stub outside a React Server bundler, so
// it is stubbed here; production still gets the real guard.
vi.mock("server-only", () => ({ default: {} }));

import {
  EnvNotConfiguredError,
  envKeysIn,
  parseEnv,
  requireEnv,
  SOLANA_NETWORKS,
} from "./env.server";

const SECRET = "ab".repeat(32);
const PROGRAM_ID = "5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3";
const ISSUER_BYTES = Array.from({ length: 64 }, (_, index) => index % 256);

const COMPLETE = {
  NEXT_PUBLIC_SOLANA_NETWORK: "devnet",
  NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.devnet.solana.com",
  NEXT_PUBLIC_PROGRAM_ID: PROGRAM_ID,
  ATTESTATION_SECRET: SECRET,
  AI_API_KEY: "",
  AI_BASE_URL: "",
  AI_MODEL: "",
  ISSUER_PRIVATE_KEY: "",
};

function withEnv(overrides: Record<string, string | undefined>) {
  return { ...COMPLETE, ...overrides };
}

/** Joins the failure list so a single assertion can check what leaked. */
function errorText(result: ReturnType<typeof parseEnv>): string {
  if (result.ok) {
    throw new Error("expected a failure");
  }
  return result.error.join(" | ");
}

describe("parseEnv", () => {
  it("accepts a complete configuration and normalises it", () => {
    const result = parseEnv(withEnv({ ISSUER_PRIVATE_KEY: JSON.stringify(ISSUER_BYTES) }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }
    expect(result.data.network).toBe("devnet");
    expect(result.data.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(result.data.programId).toBe(PROGRAM_ID);
    expect(result.data.issuerSecretKey?.length).toBe(64);
    expect(Array.from(result.data.issuerSecretKey ?? [])).toEqual(ISSUER_BYTES);
    expect(result.data.attestationKeyBytes.length).toBe(32);
    expect(result.data.ai).toBeNull();
  });

  it("reports every required key that is missing, by name", () => {
    const result = parseEnv({});
    expect(result.ok).toBe(false);
    // The RPC url is not in this list: it is an override with a per-cluster default.
    for (const key of [
      "NEXT_PUBLIC_SOLANA_NETWORK",
      "NEXT_PUBLIC_PROGRAM_ID",
      "ATTESTATION_SECRET",
    ]) {
      expect(errorText(result)).toContain(key);
    }
  });

  it("treats an empty value as unset", () => {
    const result = parseEnv({ ...COMPLETE, NEXT_PUBLIC_PROGRAM_ID: "   " });
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain("NEXT_PUBLIC_PROGRAM_ID is not set");
  });

  it("keeps the network to a cluster the toolchain knows", () => {
    expect(errorText(parseEnv(withEnv({ NEXT_PUBLIC_SOLANA_NETWORK: "mainnet" })))).toContain(
      "NEXT_PUBLIC_SOLANA_NETWORK is not valid",
    );
    for (const network of SOLANA_NETWORKS) {
      expect(parseEnv(withEnv({ NEXT_PUBLIC_SOLANA_NETWORK: network })).ok).toBe(true);
    }
  });

  it("accepts an http(s) rpc url and rejects a malformed one", () => {
    expect(parseEnv(withEnv({ NEXT_PUBLIC_SOLANA_RPC_URL: "127.0.0.1:8899" })).ok).toBe(false);
    expect(parseEnv(withEnv({ NEXT_PUBLIC_SOLANA_RPC_URL: "http://127.0.0.1:8899" })).ok).toBe(
      true,
    );
  });

  it("falls back to the cluster endpoint when the rpc url is unset", () => {
    const withoutOverride: Record<string, string> = {
      NEXT_PUBLIC_SOLANA_NETWORK: "devnet",
      NEXT_PUBLIC_PROGRAM_ID: PROGRAM_ID,
      ATTESTATION_SECRET: SECRET,
    };

    const devnet = parseEnv(withoutOverride);
    expect(devnet.ok).toBe(true);
    if (devnet.ok) {
      expect(devnet.data.rpcUrl).toBe("https://api.devnet.solana.com");
    }

    const localnet = parseEnv({
      ...withoutOverride,
      NEXT_PUBLIC_SOLANA_NETWORK: "localnet",
    });
    expect(localnet.ok).toBe(true);
    if (localnet.ok) {
      expect(localnet.data.rpcUrl).toBe("http://127.0.0.1:8899");
    }
  });

  it("rejects a program id outside the base58 alphabet", () => {
    // 0, O, I and l are not base58 characters.
    expect(errorText(parseEnv(withEnv({ NEXT_PUBLIC_PROGRAM_ID: "0OIlIamNotBase58" })))).toContain(
      "NEXT_PUBLIC_PROGRAM_ID is not valid",
    );
  });

  it("requires at least 32 bytes of attestation material", () => {
    const result = parseEnv(withEnv({ ATTESTATION_SECRET: "too-short" }));
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain("ATTESTATION_SECRET is not valid");
    expect(errorText(result)).not.toContain("too-short");
  });

  it("accepts hex, base64 and text secret material of the right size", () => {
    const base64 = Buffer.alloc(32, 3).toString("base64");
    const text = "a passphrase that is certainly longer than thirty two bytes";
    for (const material of [SECRET, base64, text]) {
      const result = parseEnv(withEnv({ ATTESTATION_SECRET: material }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected success");
      }
      expect(result.data.attestationKeyBytes.length).toBeGreaterThanOrEqual(32);
    }
  });

  it("rejects a malformed issuer key without echoing its bytes", () => {
    const short = JSON.stringify(ISSUER_BYTES.slice(0, 63));
    const result = parseEnv(withEnv({ ISSUER_PRIVATE_KEY: short }));
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain("ISSUER_PRIVATE_KEY is not valid");
    expect(errorText(result)).not.toContain(short);

    const notJson = parseEnv(withEnv({ ISSUER_PRIVATE_KEY: "not json at all," }));
    expect(errorText(notJson)).toContain("ISSUER_PRIVATE_KEY is not valid");
    expect(errorText(notJson)).not.toContain("not json at all");
  });

  it("treats the evaluator as optional when none of its keys are set", () => {
    const result = parseEnv(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected success");
    }
    expect(result.data.ai).toBeNull();
  });

  it("fails when the evaluator group is only partly configured", () => {
    const noKey = errorText(parseEnv(withEnv({ AI_MODEL: "qwen3-max" })));
    expect(noKey).toContain("AI_API_KEY is not set");

    const noModel = errorText(parseEnv(withEnv({ AI_API_KEY: "sk-evaluator-key-value" })));
    expect(noModel).toContain("AI_MODEL is not set");
    expect(noModel).toContain("AI_BASE_URL is not set");
    // The key value itself must never appear in a message.
    expect(noModel).not.toContain("sk-evaluator-key-value");

    const badUrl = errorText(
      parseEnv(withEnv({ AI_API_KEY: "k", AI_BASE_URL: "dashscope.aliyuncs", AI_MODEL: "m" })),
    );
    expect(badUrl).toContain("AI_BASE_URL is not valid");
  });

  it("lists the keys a failure mentions", () => {
    const result = parseEnv({});
    if (result.ok) {
      throw new Error("expected a failure");
    }
    expect(envKeysIn(result.error)).toEqual([
      "NEXT_PUBLIC_SOLANA_NETWORK",
      "NEXT_PUBLIC_PROGRAM_ID",
      "ATTESTATION_SECRET",
    ]);
  });

  it("reads process.env when no source is given", () => {
    const previous = { ...process.env };
    try {
      for (const key of Object.keys(COMPLETE)) {
        delete process.env[key];
      }
      process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL = "https://api.devnet.solana.com";
      process.env.NEXT_PUBLIC_PROGRAM_ID = PROGRAM_ID;
      process.env.ATTESTATION_SECRET = SECRET;
      expect(parseEnv().ok).toBe(true);
    } finally {
      for (const key of Object.keys(COMPLETE)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });
});

describe("requireEnv", () => {
  it("returns the parsed data when the environment is complete", () => {
    expect(requireEnv(COMPLETE).network).toBe("devnet");
  });

  it("throws with key names only, never values", () => {
    let thrown: unknown;
    try {
      requireEnv({ ATTESTATION_SECRET: "an-extremely-secret-looking-value" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvNotConfiguredError);
    if (!(thrown instanceof EnvNotConfiguredError)) {
      throw new Error("expected EnvNotConfiguredError");
    }
    expect(thrown.name).toBe("EnvNotConfiguredError");
    expect(thrown.missingKeys).toEqual([
      "NEXT_PUBLIC_SOLANA_NETWORK",
      "NEXT_PUBLIC_PROGRAM_ID",
      "ATTESTATION_SECRET",
    ]);
    expect(thrown.message).toContain("ATTESTATION_SECRET");
    expect(thrown.message).toContain("NEXT_PUBLIC_PROGRAM_ID");
    expect(thrown.message).not.toContain("an-extremely-secret-looking-value");
  });
});
