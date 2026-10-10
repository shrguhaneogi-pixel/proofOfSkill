import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

// `server-only` resolves to a throwing stub outside a React Server bundler.
vi.mock("server-only", () => ({ default: {} }));

const mocks = vi.hoisted(() => ({
  buildIssueTransaction: vi.fn(),
  fetchCredentialAccount: vi.fn(),
}));

// The transaction builder is the RPC-touching half. Everything up to it — body parsing,
// canonicalisation, signature check, wallet binding — must run for real, so only this one
// function is replaced and the module's other exports stay live.
vi.mock("@/lib/solana/tx-builder.server", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...(actual as object), buildIssueTransaction: mocks.buildIssueTransaction };
});

vi.mock("@/lib/solana/queries", () => ({
  fetchCredentialAccount: mocks.fetchCredentialAccount,
  fetchProfileAccount: vi.fn(),
  fetchConfigAccount: vi.fn(),
}));

vi.mock("@/lib/solana/connection", () => ({
  getConnection: () => ({}),
  resolveRpcUrl: (network: string) => `http://rpc.invalid/${network}`,
}));

import {
  PASS_THRESHOLD,
  encodeBase64Url,
  hmacBase64Url,
  signAttestation,
} from "@/lib/attestation/sign";
import { POST } from "@/app/api/issue/route";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

/** Real ed25519 addresses from fixed seeds, so the binding test uses two distinct wallets. */
const WALLET_A = "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
const WALLET_B = "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu";

const EVIDENCE_HASH = "63c446cf82ccd52235e415b7f3de9969f75459676cd0fbb1e44041e339152b77";

/** A 64 byte ed25519 secret key in the JSON-array form `ISSUER_PRIVATE_KEY` expects. */
const ISSUER = Keypair.fromSeed(new Uint8Array(32).fill(3));

const BUILT = {
  transaction: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  blockhash: WALLET_A,
  lastValidBlockHeight: 100,
  credentialPda: "4JzYzqr1CMNmntfSpatBngb9uHGYQqoJfyXkyn6rARKW",
  profilePda: "A94CxDeVUUi7VPGTg8175hYogkma2eRoiWQ1C41hE5Xw",
};

function mintFor(walletPublicKey: string, secret = SECRET): string {
  const result = signAttestation(
    { walletPublicKey, challengeId: 1, score: PASS_THRESHOLD + 17, evidenceHash: EVIDENCE_HASH },
    { secret },
  );
  if (!result.ok) {
    throw new Error(`attestation should have been minted: ${result.error}`);
  }
  return result.data;
}

/** Signs a payload the signer would never emit, with the live secret. */
function forge(payloadJson: string, secret = SECRET): string {
  return `${encodeBase64Url(payloadJson)}.${hmacBase64Url(payloadJson, Uint8Array.from(Buffer.from(secret, "hex")))}`;
}

function post(body: unknown) {
  return new Request("http://localhost/api/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Reads the wire body without trusting it to be JSON. */
async function errorOf(response: Response) {
  const body = (await response.json()) as { error?: { code?: string; message?: string } };
  return { status: response.status, code: body.error?.code, message: body.error?.message };
}

describe("POST /api/issue — attestation wallet binding", () => {
  const previousEnv = { ...process.env };

  beforeAll(() => {
    process.env.ATTESTATION_SECRET = SECRET;
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
    process.env.NEXT_PUBLIC_PROGRAM_ID = "5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3";
    process.env.ISSUER_PRIVATE_KEY = JSON.stringify(Array.from(ISSUER.secretKey));
  });

  afterAll(() => {
    process.env = { ...previousEnv };
  });

  beforeEach(() => {
    mocks.fetchCredentialAccount.mockResolvedValue({ ok: true, data: null });
    mocks.buildIssueTransaction.mockResolvedValue({ ok: true, data: BUILT });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an attestation minted for Wallet_A when Wallet_B presents it", async () => {
    const attestation = mintFor(WALLET_A);
    const response = await POST(post({ attestation, wallet: WALLET_B }));
    const { status, code } = await errorOf(response);

    expect(status).toBe(403);
    expect(code).toBe("WALLET_MISMATCH");
    // The whole point: no transaction is ever composed for the wrong wallet.
    expect(mocks.buildIssueTransaction).not.toHaveBeenCalled();
  });

  it("accepts the same token when the wallet it was minted for presents it", async () => {
    const attestation = mintFor(WALLET_A);
    const response = await POST(post({ attestation, wallet: WALLET_A }));

    expect(response.status).toBe(200);
    expect(mocks.buildIssueTransaction).toHaveBeenCalledTimes(1);
    const input = mocks.buildIssueTransaction.mock.calls[0][0] as { wallet: string };
    expect(input.wallet).toBe(WALLET_A);
  });

  it("reverts a token that was never signed, before ever comparing wallets", async () => {
    const attestation = mintFor(WALLET_A, OTHER_SECRET);
    const response = await POST(post({ attestation, wallet: WALLET_A }));
    const { status, code } = await errorOf(response);

    expect(status).toBe(400);
    expect(code).toBe("INVALID_ATTESTATION");
    expect(mocks.buildIssueTransaction).not.toHaveBeenCalled();
  });

  it("refuses a pre-binding attestation that carries no wallet and no version", async () => {
    // The exact v1 payload, correctly signed with the live secret: still not redeemable.
    const legacy = JSON.stringify({
      challengeId: 1,
      score: 87,
      evidenceHash: EVIDENCE_HASH,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const response = await POST(post({ attestation: forge(legacy), wallet: WALLET_A }));
    const { status, code } = await errorOf(response);

    expect(status).toBe(400);
    expect(code).toBe("INVALID_ATTESTATION");
    expect(mocks.buildIssueTransaction).not.toHaveBeenCalled();
  });

  it("does not let a valid attestation for one wallet be redeemed through a malformed address", async () => {
    const attestation = mintFor(WALLET_A);
    for (const wallet of ["", "not-an-address", "0OIl+==", WALLET_A.slice(0, 20), WALLET_B]) {
      const response = await POST(post({ attestation, wallet }));
      const { status, code } = await errorOf(response);
      // Four of these are not decodable as a 32 byte key; the fifth (Wallet_B) is the
      // binding rejection. Neither is allowed to reach the builder.
      expect(["INVALID_WALLET", "WALLET_MISMATCH"]).toContain(code);
      expect(status).toBe(code === "WALLET_MISMATCH" ? 403 : 400);
    }
    expect(mocks.buildIssueTransaction).not.toHaveBeenCalled();
  });

  it("requires a wallet in the body at all", async () => {
    const response = await POST(post({ attestation: mintFor(WALLET_A) }));
    const { status, code } = await errorOf(response);
    expect(status).toBe(400);
    expect(code).toBe("INVALID_WALLET");
  });
});
