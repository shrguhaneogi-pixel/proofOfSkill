import { describe, expect, it } from "vitest";

import base58 from "bs58";
import {
  EXPLORER_BASE_URL,
  addressExplorerHref,
  addressExplorerUrl,
  transactionExplorerHref,
  transactionExplorerUrl,
} from "./explorer";

const SIGNATURE = base58.encode(new Uint8Array(64).map((_zero, index) => index + 1));
const ADDRESS = "Amw2c7oVJNxtbKpWoetmghSqL8VY5Le1wBj9UbFL1TY4";

describe("transactionExplorerUrl", () => {
  it("builds a devnet link by default", () => {
    const result = transactionExplorerUrl(SIGNATURE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe(`${EXPLORER_BASE_URL}/tx/${SIGNATURE}?cluster=devnet`);
    }
  });

  it("honours an explicit testnet cluster", () => {
    const result = transactionExplorerUrl(SIGNATURE, "testnet");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe(`${EXPLORER_BASE_URL}/tx/${SIGNATURE}?cluster=testnet`);
    }
  });

  it("omits the cluster parameter on mainnet, which is the explorer default", () => {
    const result = transactionExplorerUrl(SIGNATURE, "mainnet-beta");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe(`${EXPLORER_BASE_URL}/tx/${SIGNATURE}`);
    }
  });

  it("refuses a signature that is not 64 bytes", () => {
    const short = base58.encode(new Uint8Array(63));
    const result = transactionExplorerUrl(short);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("64 bytes");
  });

  it("refuses characters outside the base58 alphabet", () => {
    const result = transactionExplorerUrl("not-a-signature-0OIl");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("not a base58 string");
  });

  it("refuses localnet instead of inventing an explorer host", () => {
    expect(transactionExplorerUrl(SIGNATURE, "localnet").ok).toBe(false);
  });
});

describe("addressExplorerUrl", () => {
  it("builds a devnet link for a real address", () => {
    const result = addressExplorerUrl(ADDRESS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe(`${EXPLORER_BASE_URL}/address/${ADDRESS}?cluster=devnet`);
    }
  });

  it("refuses an address that is not 32 bytes", () => {
    const result = addressExplorerUrl(ADDRESS.slice(0, 20));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("32 bytes");
  });
});

describe("href helpers", () => {
  it("return the URL when valid and undefined when not", () => {
    expect(transactionExplorerHref(SIGNATURE)).toBe(`${EXPLORER_BASE_URL}/tx/${SIGNATURE}?cluster=devnet`);
    expect(transactionExplorerHref("nope!")).toBeUndefined();
    expect(addressExplorerHref(ADDRESS)).toBe(`${EXPLORER_BASE_URL}/address/${ADDRESS}?cluster=devnet`);
    expect(addressExplorerHref(ADDRESS.slice(0, 10))).toBeUndefined();
  });
});
