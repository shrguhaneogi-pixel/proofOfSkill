/**
 * Solana Explorer links.
 *
 * A link is only produced from a real 64 byte signature or a real 32 byte address, so the UI can
 * never present a fabricated explorer page (docs/rules.md → FORBIDDEN_PRACTICES). Invalid input
 * returns a typed error; `*Href` helpers return `undefined` so a component can drop the link.
 */

import base58 from "bs58";
import { DEFAULT_NETWORK, type NetworkCluster } from "./connection";
import { PUBLIC_KEY_LENGTH } from "./constants";

export const EXPLORER_BASE_URL = "https://explorer.solana.com";

const SIGNATURE_LENGTH = 64;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

export type ExplorerResult = { ok: true; url: string } | { ok: false; error: string };

type ClusterQuery = { ok: true; parameter: string } | { ok: false; error: string };

/**
 * `docs/architecture.md` requires `?cluster=devnet`. `mainnet-beta` is the explorer default and is
 * therefore emitted with no cluster parameter; `localnet` has no public explorer host, so it is
 * refused rather than pointed at a guessed URL.
 */
function clusterQuery(cluster: NetworkCluster): ClusterQuery {
  if (cluster === "localnet") {
    return { ok: false, error: "Solana Explorer has no URL for a local validator" };
  }
  if (cluster === "mainnet-beta") {
    return { ok: true, parameter: "" };
  }
  return { ok: true, parameter: `?cluster=${cluster}` };
}

function decodeFixedBase58(value: string, length: number, label: string): string | null {
  if (!BASE58_PATTERN.test(value)) {
    return `${label} is not a base58 string`;
  }
  const bytes = base58.decode(value);
  if (bytes.length !== length) {
    return `${label} must decode to ${length} bytes, got ${bytes.length}`;
  }
  return null;
}

/** `https://explorer.solana.com/tx/<signature>?cluster=devnet` */
export function transactionExplorerUrl(
  signature: string,
  cluster: NetworkCluster = DEFAULT_NETWORK,
): ExplorerResult {
  const invalid = decodeFixedBase58(signature, SIGNATURE_LENGTH, "transaction signature");
  if (invalid) {
    return { ok: false, error: invalid };
  }
  const query = clusterQuery(cluster);
  if (!query.ok) {
    return { ok: false, error: query.error };
  }
  return { ok: true, url: `${EXPLORER_BASE_URL}/tx/${signature}${query.parameter}` };
}

/** `https://explorer.solana.com/address/<address>?cluster=devnet` — PDAs, wallets, programs. */
export function addressExplorerUrl(
  address: string,
  cluster: NetworkCluster = DEFAULT_NETWORK,
): ExplorerResult {
  const invalid = decodeFixedBase58(address, PUBLIC_KEY_LENGTH, "address");
  if (invalid) {
    return { ok: false, error: invalid };
  }
  const query = clusterQuery(cluster);
  if (!query.ok) {
    return { ok: false, error: query.error };
  }
  return { ok: true, url: `${EXPLORER_BASE_URL}/address/${address}${query.parameter}` };
}

export function transactionExplorerHref(
  signature: string,
  cluster: NetworkCluster = DEFAULT_NETWORK,
): string | undefined {
  const result = transactionExplorerUrl(signature, cluster);
  return result.ok ? result.url : undefined;
}

export function addressExplorerHref(
  address: string,
  cluster: NetworkCluster = DEFAULT_NETWORK,
): string | undefined {
  const result = addressExplorerUrl(address, cluster);
  return result.ok ? result.url : undefined;
}
