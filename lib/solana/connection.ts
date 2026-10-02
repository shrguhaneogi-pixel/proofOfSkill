/**
 * RPC transport for the app. One place decides which endpoint and commitment level are used.
 *
 * `NEXT_PUBLIC_SOLANA_RPC_URL` overrides the public endpoint because the shared devnet RPC is
 * rate limited (docs/stack.md → ANCHOR_WORKSPACE_NOTES). Nothing here reads secrets, so the module
 * is safe for both the browser bundle and route handlers.
 */

import { Connection, clusterApiUrl, type Cluster, type Finality } from "@solana/web3.js";

/** `localnet` is not a web3.js `Cluster`; it needs an explicit endpoint instead of `clusterApiUrl`. */
export type NetworkCluster = Cluster | "localnet";

export const DEFAULT_NETWORK: NetworkCluster = "devnet";
export const DEFAULT_COMMITMENT: Finality = "confirmed";
export const LOCALNET_RPC_URL = "http://127.0.0.1:8899";

const NETWORKS: readonly NetworkCluster[] = ["devnet", "testnet", "mainnet-beta", "localnet"];

export function isNetworkCluster(value: string): value is NetworkCluster {
  return (NETWORKS as readonly string[]).includes(value);
}

/** Reads `NEXT_PUBLIC_SOLANA_NETWORK`, falling back to devnet when unset or unrecognized. */
export function resolveNetwork(value: string | undefined = process.env.NEXT_PUBLIC_SOLANA_NETWORK): NetworkCluster {
  const candidate = (value ?? "").trim().toLowerCase();
  if (candidate === "") {
    return DEFAULT_NETWORK;
  }
  // A typo such as "devnet1" must not silently talk to another cluster than the developer asked for.
  if (isNetworkCluster(candidate)) {
    return candidate;
  }
  throw new Error(
    `NEXT_PUBLIC_SOLANA_NETWORK is "${value}"; expected one of ${NETWORKS.join(", ")}`,
  );
}

/** Reads `NEXT_PUBLIC_SOLANA_RPC_URL`, falling back to the cluster's public endpoint. */
export function resolveRpcUrl(
  network: NetworkCluster = resolveNetwork(),
  urlOverride: string | undefined = process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
): string {
  const configured = (urlOverride ?? "").trim();
  if (configured !== "") {
    return configured;
  }
  return network === "localnet" ? LOCALNET_RPC_URL : clusterApiUrl(network);
}

const connectionCache = new Map<string, Connection>();

export type GetConnectionOptions = {
  network?: NetworkCluster;
  rpcUrl?: string;
  commitment?: Finality;
};

/** Memoized per endpoint + commitment, so repeated Server Component renders share one connection. */
export function getConnection(options: GetConnectionOptions = {}): Connection {
  const network = options.network ?? resolveNetwork();
  const endpoint = options.rpcUrl ?? resolveRpcUrl(network, options.rpcUrl);
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const key = `${endpoint}|${commitment}`;

  const existing = connectionCache.get(key);
  if (existing) {
    return existing;
  }
  const connection = new Connection(endpoint, { commitment });
  connectionCache.set(key, connection);
  return connection;
}
