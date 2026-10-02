import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert, expect } from "chai";
import type { ProofOfSkill } from "../target/types/proof_of_skill";

const PROGRAM_ID = new anchor.web3.PublicKey(
  "5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3",
);

const SEEDS = {
  config: Buffer.from("config"),
  profile: Buffer.from("profile"),
  credential: Buffer.from("credential"),
} as const;

/** Mirrors `programs/proof_of_skill/src/constants.rs` exactly. */
function deriveProfilePda(user: anchor.web3.PublicKey): [anchor.web3.PublicKey, number] {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [SEEDS.profile, user.toBuffer()],
    PROGRAM_ID,
  );
}

function deriveCredentialPda(
  user: anchor.web3.PublicKey,
  challengeId: number,
): [anchor.web3.PublicKey, number] {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [SEEDS.credential, user.toBuffer(), Uint8Array.of(challengeId)],
    PROGRAM_ID,
  );
}

function deriveConfigPda(): [anchor.web3.PublicKey, number] {
  return anchor.web3.PublicKey.findProgramAddressSync([SEEDS.config], PROGRAM_ID);
}

function nonZeroHash(): Buffer {
  const hash = Buffer.alloc(32, 0);
  hash.fill(7, 0, 32);
  return hash;
}

/**
 * Anchor raises either a namespaced `ProofError` from our program or a raw
 * runtime error. Tests assert on `errorName` when present, which is what the
 * spec's "not on message substrings alone" rule asks for.
 */
function anchorErrorName(error: unknown): string | undefined {
  const candidate = error as { errorName?: string; code?: number };
  return candidate?.errorName;
}

describe("proof_of_skill", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ProofOfSkill as Program<ProofOfSkill>;
  const wallet = provider.wallet as anchor.Wallet;

  // Fresh payer per test keeps `init` from colliding across the suite.
  function newUser(): anchor.web3.Keypair {
    return anchor.web3.Keypair.generate();
  }

  async function fund(keypair: anchor.web3.Keypair, lamports: number): Promise<void> {
    const signature = await provider.connection.requestAirdrop(keypair.publicKey, lamports);
    const { blockhash, lastValidBlockHeight } =
      await provider.connection.getLatestBlockhash("confirmed");
    await provider.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  }

  async function initializeIssuer(): Promise<anchor.web3.Keypair> {
    const issuer = anchor.web3.Keypair.generate();
    const [configPda] = deriveConfigPda();
    const existing = await program.account.config.fetchAll([
      { memcmp: { offset: 0, bytes: configPda.toBase58() } },
    ]);
    if (existing.length === 0) {
      await program.methods.initializeConfig(issuer.publicKey).accounts({
        admin: wallet.publicKey,
      }).rpc();
    }
    return issuer;
  }

  it("initialize_config succeeds for the upgrade authority", async () => {
    const issuer = anchor.web3.Keypair.generate();
    const [configPda, bump] = deriveConfigPda();

    await program.methods.initializeConfig(issuer.publicKey)
      .accounts({ admin: wallet.publicKey })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.admin.toBase58(), wallet.publicKey.toBase58());
    assert.equal(config.issuer.toBase58(), issuer.publicKey.toBase58());
    assert.equal(config.bump, bump);
  });

  it("initialize_config fails for a signer that is not the upgrade authority", async () => {
    const impostor = newUser();
    await fund(impostor, anchor.web3.LAMPORTS_PER_SOL);

    let rejected = false;
    try {
      await program.methods.initializeConfig(impostor.publicKey)
        .accounts({ admin: impostor.publicKey })
        .signers([impostor])
        .rpc();
    } catch (error) {
      rejected = true;
      assert.equal(anchorErrorName(error), "UnauthorizedAdmin");
    }
    assert.isTrue(rejected, "expected a non-upgrade-authority admin to be rejected");
  });

  it("initialize_profile creates the PDA with zeroed counters", async () => {
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);
    const [profilePda, bump] = deriveProfilePda(user.publicKey);

    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    const profile = await program.account.userProfile.fetch(profilePda);
    assert.equal(profile.user.toBase58(), user.publicKey.toBase58());
    assert.equal(profile.completedCount.toNumber(), 0);
    assert.equal(profile.reputation.toNumber(), 0);
    assert.equal(profile.bump, bump);
    assert.isBelow(Math.abs(profile.createdAt.toNumber() - Date.now() / 1000), 600);
  });

  it("issue_credential succeeds with user and issuer signatures", async () => {
    const issuer = await initializeIssuer();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);

    const [profilePda] = deriveProfilePda(user.publicKey);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    const hash = nonZeroHash();
    await program.methods.issueCredential(1, 88, Array.from(hash))
      .accounts({ user: user.publicKey, issuer: issuer.publicKey })
      .signers([user, issuer])
      .rpc();

    const [credentialPda] = deriveCredentialPda(user.publicKey, 1);
    const credential = await program.account.credential.fetch(credentialPda);
    assert.equal(credential.user.toBase58(), user.publicKey.toBase58());
    assert.equal(credential.issuer.toBase58(), issuer.publicKey.toBase58());
    assert.equal(credential.challengeId, 1);
    assert.equal(credential.score, 88);
    assert.deepEqual(Array.from(credential.evidenceHash), Array.from(hash));

    const profile = await program.account.userProfile.fetch(profilePda);
    assert.equal(profile.completedCount.toNumber(), 1);
    assert.equal(profile.reputation.toNumber(), 88);
  });

  it("rejects a score above 100", async () => {
    const issuer = await initializeIssuer();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    let rejected = false;
    try {
      await program.methods.issueCredential(1, 101, Array.from(nonZeroHash()))
        .accounts({ user: user.publicKey, issuer: issuer.publicKey })
        .signers([user, issuer])
        .rpc();
    } catch (error) {
      rejected = true;
      assert.equal(anchorErrorName(error), "InvalidScore");
    }
    assert.isTrue(rejected, "expected score 101 to be rejected");
  });

  it("rejects a score below the passing threshold", async () => {
    const issuer = await initializeIssuer();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    let rejected = false;
    try {
      await program.methods.issueCredential(1, 69, Array.from(nonZeroHash()))
        .accounts({ user: user.publicKey, issuer: issuer.publicKey })
        .signers([user, issuer])
        .rpc();
    } catch (error) {
      rejected = true;
      assert.equal(anchorErrorName(error), "ScoreBelowThreshold");
    }
    assert.isTrue(rejected, "expected score 69 to be rejected");
  });

  it("rejects challenge ids outside 1..=5", async () => {
    const issuer = await initializeIssuer();
    for (const challengeId of [0, 6]) {
      const user = newUser();
      await fund(user, anchor.web3.LAMPORTS_PER_SOL);
      await program.methods.initializeProfile()
        .accounts({ user: user.publicKey })
        .signers([user])
        .rpc();

      let rejected = false;
      try {
        await program.methods.issueCredential(challengeId, 90, Array.from(nonZeroHash()))
          .accounts({ user: user.publicKey, issuer: issuer.publicKey })
          .signers([user, issuer])
          .rpc();
      } catch (error) {
        rejected = true;
        assert.equal(anchorErrorName(error), "InvalidChallengeId");
      }
      assert.isTrue(rejected, `expected challenge id ${challengeId} to be rejected`);
    }
  });

  it("rejects a co-signer that is not the registered issuer", async () => {
    const issuer = await initializeIssuer();
    const impostor = anchor.web3.Keypair.generate();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    let rejected = false;
    try {
      await program.methods.issueCredential(1, 90, Array.from(nonZeroHash()))
        .accounts({ user: user.publicKey, issuer: impostor.publicKey })
        .signers([user, impostor])
        .rpc();
    } catch (error) {
      rejected = true;
      assert.equal(anchorErrorName(error), "UnauthorizedIssuer");
    }
    assert.isTrue(rejected, "expected an impostor issuer to be rejected");
    expect(issuer.publicKey).to.be.an.instanceof(anchor.web3.PublicKey);
  });

  it("rejects a second credential for the same wallet and challenge", async () => {
    const issuer = await initializeIssuer();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    await program.methods.issueCredential(2, 80, Array.from(nonZeroHash()))
      .accounts({ user: user.publicKey, issuer: issuer.publicKey })
      .signers([user, issuer])
      .rpc();

    let rejected = false;
    try {
      await program.methods.issueCredential(2, 95, Array.from(nonZeroHash()))
        .accounts({ user: user.publicKey, issuer: issuer.publicKey })
        .signers([user, issuer])
        .rpc();
    } catch {
      // The failure comes from the system program (`init` on an existing
      // address), not from our program, so there is no ProofError name here.
      rejected = true;
    }
    assert.isTrue(rejected, "expected a duplicate credential to be rejected");

    const [credentialPda] = deriveCredentialPda(user.publicKey, 2);
    const credential = await program.account.credential.fetch(credentialPda);
    assert.equal(credential.score, 80, "first credential must be untouched");
  });

  it("rejects a transaction without the issuer signature", async () => {
    const issuer = await initializeIssuer();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();

    let rejected = false;
    try {
      await program.methods.issueCredential(3, 90, Array.from(nonZeroHash()))
        .accounts({ user: user.publicKey, issuer: issuer.publicKey })
        .signers([user])
        .rpc();
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected, "expected a missing issuer signature to be rejected");
  });

  it("derives the same PDAs on the client as the program creates", async () => {
    const issuer = await initializeIssuer();
    const user = newUser();
    await fund(user, anchor.web3.LAMPORTS_PER_SOL);

    const [expectedProfile, expectedProfileBump] = deriveProfilePda(user.publicKey);
    await program.methods.initializeProfile()
      .accounts({ user: user.publicKey })
      .signers([user])
      .rpc();
    const createdProfile = await program.account.userProfile.fetch(expectedProfile);
    assert.equal(createdProfile.bump, expectedProfileBump);

    const [expectedCredential, expectedCredentialBump] = deriveCredentialPda(user.publicKey, 4);
    await program.methods.issueCredential(4, 77, Array.from(nonZeroHash()))
      .accounts({ user: user.publicKey, issuer: issuer.publicKey })
      .signers([user, issuer])
      .rpc();
    const createdCredential = await program.account.credential.fetch(expectedCredential);
    assert.equal(createdCredential.bump, expectedCredentialBump);
    assert.equal(createdCredential.challengeId, 4);

    const [expectedConfig] = deriveConfigPda();
    const createdConfig = await program.account.config.fetch(expectedConfig);
    assert.equal(createdConfig.issuer.toBase58(), issuer.publicKey.toBase58());
  });
});
