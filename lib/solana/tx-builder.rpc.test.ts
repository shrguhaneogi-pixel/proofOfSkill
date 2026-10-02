import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { bytesToHex, hexToBytes } from "../hashing/evidence-hash";

// `server-only` throws when imported outside a React server graph; vitest hoists this above the
// import of ./tx-builder.server, so the module under test still loads.
vi.mock("server-only", () => ({ default: {} }));

import {
  ACCOUNT_DISCRIMINATORS,
  DEFAULT_PROGRAM_ID,
  INSTRUCTION_DISCRIMINATORS,
} from "./constants";
import { configPda, credentialPda, profilePda } from "./pdas";
import { buildIssueTransaction } from "./tx-builder.server";

const WALLET = new PublicKey("Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j");
const ADMIN = new PublicKey("5Tj8zs2NjYH3k99FemR1ehu4NreneizumE1zKytEvqt4");
const BLOCKHASH = "11111111111111111111111111111111";
const EVIDENCE_HASH = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

const issuer = Keypair.generate();

function configData(coSigner: PublicKey): Uint8Array {
  const bytes = new Uint8Array(73);
  bytes.set(ACCOUNT_DISCRIMINATORS.config, 0);
  bytes.set(ADMIN.toBytes(), 8);
  bytes.set(coSigner.toBytes(), 40);
  bytes[72] = 255;
  return bytes;
}

function profileData(): Uint8Array {
  const bytes = new Uint8Array(57);
  bytes.set(ACCOUNT_DISCRIMINATORS.userProfile, 0);
  bytes.set(WALLET.toBytes(), 8);
  return bytes;
}

/**
 * A real `Connection` with every RPC method replaced: the request types stay honest, and no socket
 * is ever opened (the endpoint is a closed port on loopback).
 */
function stubRpc(options: { config?: Uint8Array; profile?: Uint8Array }): Connection {
  const connection = new Connection("http://127.0.0.1:1", "confirmed");
  const programId = new PublicKey(DEFAULT_PROGRAM_ID);
  const configAddress = configPda(programId).pda.toBase58();
  const profileAddress = profilePda(WALLET, programId).pda.toBase58();

  vi.spyOn(connection, "getAccountInfo").mockImplementation(
    async (address: PublicKey): Promise<AccountInfo<Buffer> | null> => {
      const data =
        address.toBase58() === configAddress
          ? options.config
          : address.toBase58() === profileAddress
            ? options.profile
            : undefined;
      if (data === undefined) {
        return null;
      }
      return { executable: false, owner: programId, lamports: 1, data: Buffer.from(data), rentEpoch: 0 };
    },
  );
  vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 4321,
  });
  return connection;
}

const base = {
  wallet: WALLET.toBase58(),
  issuer,
  challengeId: 2,
  score: 91,
  evidenceHash: EVIDENCE_HASH,
};

function decodedInstructions(transaction: string) {
  return TransactionMessage.decompile(
    VersionedTransaction.deserialize(new Uint8Array(Buffer.from(transaction, "base64"))).message,
  ).instructions;
}

describe("buildIssueTransaction", () => {
  it("reads config, derives profileExists from the chain and returns the route payload", async () => {
    const result = await buildIssueTransaction({
      ...base,
      connection: stubRpc({ config: configData(issuer.publicKey) }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.blockhash).toBe(BLOCKHASH);
    expect(result.data.lastValidBlockHeight).toBe(4321);
    expect(result.data.credentialPda).toBe(credentialPda(WALLET, 2).pda.toBase58());
    expect(result.data.profilePda).toBe(profilePda(WALLET).pda.toBase58());
  });

  it("prepends initialize_profile while the profile account is absent", async () => {
    const result = await buildIssueTransaction({
      ...base,
      connection: stubRpc({ config: configData(issuer.publicKey) }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const instructions = decodedInstructions(result.data.transaction);
    expect(instructions).toHaveLength(2);
    expect(bytesToHex(new Uint8Array(instructions[0].data))).toBe(
      bytesToHex(INSTRUCTION_DISCRIMINATORS.initializeProfile),
    );
    expect(bytesToHex(new Uint8Array(instructions[1].data)).slice(0, 16)).toBe(
      bytesToHex(INSTRUCTION_DISCRIMINATORS.issueCredential),
    );
  });

  it("skips initialize_profile when the profile account already exists", async () => {
    const result = await buildIssueTransaction({
      ...base,
      connection: stubRpc({ config: configData(issuer.publicKey), profile: profileData() }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const instructions = decodedInstructions(result.data.transaction);
    expect(instructions).toHaveLength(1);
  });

  it("refuses to sign with a key that is not the onchain issuer", async () => {
    const result = await buildIssueTransaction({
      ...base,
      connection: stubRpc({ config: configData(ADMIN) }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("ISSUER_MISMATCH");
  });

  it("says so when Config has not been initialized", async () => {
    const result = await buildIssueTransaction({ ...base, connection: stubRpc({}) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONFIG_NOT_INITIALIZED");
    }
  });

  it("maps an RPC outage to RPC_ERROR", async () => {
    const connection = new Connection("http://127.0.0.1:1", "confirmed");
    vi.spyOn(connection, "getAccountInfo").mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await buildIssueTransaction({ ...base, connection });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("RPC_ERROR");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("skips both reads when the route already fetched config and the profile flag", async () => {
    const connection = stubRpc({});
    const getAccountInfo = vi.spyOn(connection, "getAccountInfo");
    const result = await buildIssueTransaction({
      ...base,
      connection,
      config: { admin: ADMIN, issuer: issuer.publicKey, bump: 255 },
      profileExists: true,
    });

    expect(result.ok).toBe(true);
    expect(getAccountInfo).not.toHaveBeenCalled();
  });
});
