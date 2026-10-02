import { clusterApiUrl } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMMITMENT,
  DEFAULT_NETWORK,
  LOCALNET_RPC_URL,
  getConnection,
  isNetworkCluster,
  resolveNetwork,
  resolveRpcUrl,
} from "./connection";

describe("resolveNetwork", () => {
  it("defaults to devnet when nothing is configured", () => {
    expect(resolveNetwork(undefined)).toBe(DEFAULT_NETWORK);
    expect(resolveNetwork("   ")).toBe("devnet");
    expect(DEFAULT_NETWORK).toBe("devnet");
  });

  it("accepts every documented cluster and normalizes case", () => {
    expect(resolveNetwork("devnet")).toBe("devnet");
    expect(resolveNetwork("MAINNET-BETA")).toBe("mainnet-beta");
    expect(resolveNetwork("localnet")).toBe("localnet");
  });

  it("refuses an unknown cluster instead of silently using devnet", () => {
    expect(() => resolveNetwork("devnet1")).toThrow(/NEXT_PUBLIC_SOLANA_NETWORK/);
  });
});

describe("isNetworkCluster", () => {
  it("recognizes only the supported names", () => {
    expect(isNetworkCluster("mainnet-beta")).toBe(true);
    expect(isNetworkCluster("mtn")).toBe(false);
  });
});

describe("resolveRpcUrl", () => {
  it("prefers an explicit endpoint and trims it", () => {
    expect(resolveRpcUrl("devnet", "  https://rpc.example.com  ")).toBe("https://rpc.example.com");
  });

  it("uses the library endpoint for a public cluster", () => {
    expect(resolveRpcUrl("devnet", "")).toBe(clusterApiUrl("devnet"));
    expect(resolveRpcUrl("mainnet-beta", undefined)).toBe(clusterApiUrl("mainnet-beta"));
  });

  it("maps localnet to the test validator port", () => {
    expect(resolveRpcUrl("localnet", "")).toBe(LOCALNET_RPC_URL);
    expect(LOCALNET_RPC_URL).toBe("http://127.0.0.1:8899");
  });

  it("falls back to devnet when no network is given", () => {
    expect(resolveRpcUrl(undefined, "")).toBe(clusterApiUrl("devnet"));
  });
});

describe("getConnection", () => {
  it("returns the same connection for the same endpoint and commitment", () => {
    const first = getConnection({ rpcUrl: LOCALNET_RPC_URL });
    const second = getConnection({ rpcUrl: LOCALNET_RPC_URL, commitment: DEFAULT_COMMITMENT });
    expect(second).toBe(first);
  });

  it("returns a different connection for a different commitment", () => {
    const confirmed = getConnection({ rpcUrl: LOCALNET_RPC_URL, commitment: "confirmed" });
    const finalized = getConnection({ rpcUrl: LOCALNET_RPC_URL, commitment: "finalized" });
    expect(finalized).not.toBe(confirmed);
  });
});
