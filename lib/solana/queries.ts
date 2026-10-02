/**
 * Read layer for the dashboard and the verify page: turn RPC account data into typed program state.
 *
 * Commitment comes from the `Connection` (see `connection.ts`, default `confirmed`), so callers do
 * not have to repeat it. Every entry point returns a typed result: a missing account is
 * `{ ok: true, data: null }`, while an RPC failure or bytes that do not match a documented layout
 * is `{ ok: false, error }` — the two cases the UI renders differently (404 versus "try again").
 */

import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  CONFIG_ACCOUNT_SIZE,
  CREDENTIAL_ACCOUNT_SIZE,
  ACCOUNT_OWNER_MEMCMP_OFFSET,
  USER_PROFILE_ACCOUNT_SIZE,
} from "./constants";
import {
  decodeConfigAccount,
  decodeCredentialAccount,
  decodeUserProfileAccount,
  type ConfigAccount,
  type CredentialAccount,
  type Result,
  type UserProfileAccount,
} from "./codecs";
import { configPda, getProgramId, profilePda } from "./pdas";

export type CredentialRecord = {
  address: PublicKey;
  account: CredentialAccount;
};

export type WalletSnapshot = {
  profile: UserProfileAccount | null;
  credentials: CredentialRecord[];
};

export function fetchConfigAccount(connection: Connection): Promise<Result<ConfigAccount | null>> {
  return readAndDecode(connection, configPda().pda, CONFIG_ACCOUNT_SIZE, decodeConfigAccount, "Config");
}

export function fetchProfileAccount(
  connection: Connection,
  user: PublicKey | string,
): Promise<Result<UserProfileAccount | null>> {
  const address = profilePda(user).pda;
  return readAndDecode(connection, address, USER_PROFILE_ACCOUNT_SIZE, decodeUserProfileAccount, "Profile");
}

/** Takes the credential PDA directly — that is the value the verify page receives in the URL. */
export function fetchCredentialAccount(
  connection: Connection,
  credentialAddress: PublicKey,
): Promise<Result<CredentialAccount | null>> {
  return readAndDecode(connection, credentialAddress, CREDENTIAL_ACCOUNT_SIZE, decodeCredentialAccount, "Credential");
}

/**
 * All credentials of one wallet, via the documented `memcmp` query: `user` is the first field of
 * the Credential struct, so it sits at offset 8 (after the Anchor discriminator). The `dataSize`
 * filter is required because UserProfile also stores `user` at offset 8.
 */
export async function fetchWalletCredentials(
  connection: Connection,
  wallet: PublicKey,
): Promise<Result<CredentialRecord[]>> {
  const programId = getProgramId();
  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: ACCOUNT_OWNER_MEMCMP_OFFSET, bytes: wallet.toBase58() } },
        { dataSize: CREDENTIAL_ACCOUNT_SIZE },
      ],
    });
    const records: CredentialRecord[] = [];
    for (const entry of accounts) {
      const decoded = decodeCredentialAccount(entry.account.data);
      if (!decoded.ok) {
        return { ok: false, error: `${entry.pubkey.toBase58()}: ${decoded.error}` };
      }
      records.push({ address: entry.pubkey, account: decoded.data });
    }
    return { ok: true, data: records };
  } catch (error) {
    return { ok: false, error: `credential query failed: ${describeError(error)}` };
  }
}

export async function fetchWalletSnapshot(
  connection: Connection,
  wallet: PublicKey,
): Promise<Result<WalletSnapshot>> {
  const [profile, credentials] = await Promise.all([
    fetchProfileAccount(connection, wallet),
    fetchWalletCredentials(connection, wallet),
  ]);
  if (!profile.ok) {
    return profile;
  }
  if (!credentials.ok) {
    return credentials;
  }
  return { ok: true, data: { profile: profile.data, credentials: credentials.data } };
}

async function readAndDecode<T>(
  connection: Connection,
  address: PublicKey,
  expectedSize: number,
  decode: (data: Uint8Array) => Result<T>,
  label: string,
): Promise<Result<T | null>> {
  let info: AccountInfo<Buffer> | null;
  try {
    info = await connection.getAccountInfo(address);
  } catch (error) {
    return { ok: false, error: `${label} account read failed: ${describeError(error)}` };
  }
  if (info === null) {
    return { ok: true, data: null };
  }
  // A wrong-cluster or mistyped address can still resolve to some program's account; the owner
  // check says so instead of reporting a discriminator mismatch.
  if (!info.owner.equals(getProgramId())) {
    return { ok: false, error: `${address.toBase58()} is owned by ${info.owner.toBase58()}, not the proof_of_skill program` };
  }
  if (info.data.length !== expectedSize) {
    return { ok: false, error: `${label} account at ${address.toBase58()} is ${info.data.length} bytes, expected ${expectedSize}` };
  }
  const decoded = decode(info.data);
  return decoded.ok ? { ok: true, data: decoded.data } : { ok: false, error: `${label}: ${decoded.error}` };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
