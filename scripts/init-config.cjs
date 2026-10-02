/**
 * Registers the server-held issuer key in the onchain Config account.
 *
 * Run after the program is deployed and the deployer is the program's upgrade
 * authority:
 *   node scripts/init-config.cjs            # uses RPC from env or localnet
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 node scripts/init-config.cjs
 *
 * Plain CommonJS on purpose: the approved dependency list in docs/stack.md has
 * no ts-node, and this must stay runnable with just `node`.
 */
const fs = require("node:fs");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { Keypair, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3",
);

function readIdl() {
  const idlPath = path.join(__dirname, "..", "target", "idl", "proof_of_skill.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `no IDL at ${idlPath}. Build the program first (anchor build) — this script cannot run ` +
        "while the SBF build is blocked on this host.",
    );
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

function readIssuerPubkey() {
  const keyPath = process.env.ISSUER_KEY_FILE
    ? path.resolve(process.env.ISSUER_KEY_FILE)
    : path.join(__dirname, "..", ".keys", "issuer.json");
  if (!fs.existsSync(keyPath)) {
    throw new Error(`no issuer keypair at ${keyPath}. Generate one with solana-keygen new -o ${keyPath}`);
  }
  const bytes = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey;
}

async function main() {
  const provider = anchor.AnchorProvider.local(
    process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899",
    { commitment: "confirmed", skipPreflight: false },
  );
  anchor.setProvider(provider);

  const program = new anchor.Program(readIdl(), provider);
  const issuer = readIssuerPubkey();
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID,
  );

  const existing = await program.account.config.fetchNullable(configPda);
  if (existing) {
    if (existing.issuer.equals(issuer)) {
      console.log(`Config already initialized with the expected issuer: ${issuer.toBase58()}`);
      return;
    }
    throw new Error(
      `Config already exists with a different issuer (${existing.issuer.toBase58()}). ` +
        "Re-deploy the program or rotate the issuer deliberately.",
    );
  }

  console.log(`Initializing Config with issuer ${issuer.toBase58()}`);
  await program.methods
    .initializeConfig(issuer)
    .accounts({ admin: provider.wallet.publicKey })
    .rpc();

  const created = await program.account.config.fetch(configPda);
  console.log(`Config created at ${configPda.toBase58()} (admin ${created.admin.toBase58()})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
