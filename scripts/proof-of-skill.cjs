/**
 * Hand-built instruction encoding for the `proof_of_skill` program, for the plain-node
 * operator scripts.
 *
 * Deliberately IDL-free. `anchor build` is the only thing that emits
 * `target/idl/proof_of_skill.json`, and a program built with `cargo build-sbf` does not,
 * so an IDL-dependent script cannot run on a host that has bytecode but no IDL. The app
 * client already encodes at the byte level (see `lib/solana/constants.ts`), and these
 * constants are the same values pinned by `programs/proof_of_skill/src/tests.rs`.
 *
 * Plain CommonJS on purpose: docs/stack.md's approved dependency list has no ts-node, and
 * these must stay runnable with just `node`.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");

/**
 * Node does not read `.env.local` on its own the way Next does, and the operator already
 * keeps the issuer key and program id there. Loading it first means these scripts and the
 * running app always agree. Runs before any `process.env` read below.
 */
function loadLocalEnv() {
  const file = path.join(__dirname, "..", ".env.local");
  if (fs.existsSync(file)) {
    process.loadEnvFile(file);
  }
}

loadLocalEnv();

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3",
);

/** sha256("global:<ix_name>")[0..8], as asserted in the Rust test module. */
const SIGHASH = {
  initializeConfig: Buffer.from("d07f1501c2bec446", "hex"),
  updateConfig: Buffer.from("1d9efcbf0a53db63", "hex"),
};

const CONFIG_SEED = Buffer.from("config");

function configPda() {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
}

/** `initialize_config(issuer: Pubkey)` / `update_config(issuer: Pubkey)` — sighash + 32 raw bytes. */
function encodeIssuerArg(sighash, issuer) {
  const data = Buffer.alloc(sighash.length + 32);
  sighash.copy(data, 0);
  Buffer.from(issuer.toBytes()).copy(data, sighash.length);
  return data;
}

function initializeConfigInstruction(admin, issuer, programData) {
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeIssuerArg(SIGHASH.initializeConfig, issuer),
  };
}

/**
 * `update_config` — accounts are `admin` (signer, fee payer, so writable), the Config PDA,
 * then this program and its ProgramData, matching `UpdateConfig` in the Rust source
 * exactly. The program re-reads the *current* upgrade authority from ProgramData, so a key
 * demoted by a later transfer or renouncement can no longer rotate; dropping these two
 * accounts would make every rotation revert.
 */
function updateConfigInstruction(admin, issuer, programData) {
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programData, isSigner: false, isWritable: false },
    ],
    data: encodeIssuerArg(SIGHASH.updateConfig, issuer),
  };
}

function programDataAddress() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ProgramData"), PROGRAM_ID.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  )[0];
}

const DISCRIMINATOR_LENGTH = 8;
const CONFIG_ACCOUNT_SIZE = 73;

/** Decodes `Config { admin, issuer, bump }` the same way `lib/solana/codecs.ts` does. */
function decodeConfig(raw) {
  if (raw.length !== CONFIG_ACCOUNT_SIZE) {
    throw new Error(`Config account is ${raw.length} bytes, expected ${CONFIG_ACCOUNT_SIZE}`);
  }
  return {
    admin: new PublicKey(raw.slice(DISCRIMINATOR_LENGTH, 40)),
    issuer: new PublicKey(raw.slice(40, 72)),
    bump: raw[72],
  };
}

function readKeypair(explicitPath, label) {
  const candidates = [
    explicitPath,
    path.join(__dirname, "..", ".keys", "admin.json"),
    path.join(os.homedir(), ".config", "solana", "id.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) {
      const bytes = JSON.parse(fs.readFileSync(resolved, "utf8"));
      return { keypair: Keypair.fromSecretKey(Uint8Array.from(bytes)), path: resolved, label };
    }
  }
  throw new Error(
    `no ${label} keypair found. Looked for: ${candidates.join(", ")}. ` +
      `Create one with: solana-keygen new -o .keys/admin.json`,
  );
}

function readPublicKeyArg(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required (a base58 public key)`);
  }
  return new PublicKey(value);
}

/**
 * Resolves the issuer the operator means, in this order: an explicit base58 argument,
 * `ISSUER_PUBKEY`, `ISSUER_PRIVATE_KEY` (the same value the server signs with), then
 * `.keys/issuer.json`. Deriving from the private key is what keeps the Config registration
 * and `/api/issue` from disagreeing — the program refuses to issue when they do.
 *
 * Only ever returns the public half.
 */
function readIssuerPubkey(explicit) {
  if (typeof explicit === "string" && explicit.length > 0) {
    return new PublicKey(explicit);
  }
  const configured = process.env.ISSUER_PUBKEY;
  if (typeof configured === "string" && configured.length > 0) {
    return new PublicKey(configured);
  }
  const secret = process.env.ISSUER_PRIVATE_KEY;
  if (typeof secret === "string" && secret.trim().length > 0) {
    return keypairFromSecretList(secret, "ISSUER_PRIVATE_KEY").publicKey;
  }
  const keyFile = path.join(__dirname, "..", ".keys", "issuer.json");
  if (fs.existsSync(keyFile)) {
    return keypairFromSecretList(fs.readFileSync(keyFile, "utf8"), keyFile).publicKey;
  }
  throw new Error(
    "no issuer key found. Pass --issuer <pubkey>, or set ISSUER_PUBKEY / ISSUER_PRIVATE_KEY, " +
      "or create .keys/issuer.json with: solana-keygen new -o .keys/issuer.json",
  );
}

function keypairFromSecretList(text, label) {
  let bytes;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON — expected the array of 64 byte values printed by solana-keygen`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`${label} must be a JSON array of exactly 64 byte values`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/**
 * Refuses mainnet. These scripts sign and send real transactions, and a mistaken
 * mainnet deploy or issuer rotation is not undoable.
 */
function connectionFromEnv() {
  const url = process.env.ANCHOR_PROVIDER_URL || process.env.SOLANA_RPC_URL || "";
  if (url.length === 0) {
    throw new Error(
      "set ANCHOR_PROVIDER_URL (or SOLANA_RPC_URL) to the cluster endpoint, e.g. https://api.devnet.solana.com",
    );
  }
  if (/mainnet/i.test(url)) {
    throw new Error(`refusing to use a mainnet endpoint (${url}); this script is devnet/localnet only`);
  }
  return new Connection(url, "confirmed");
}

async function sendAndConfirm(connection, payer, instruction, description) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
    instruction,
  );
  transaction.sign([payer]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  const status = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (status.value.err) {
    throw new Error(`${description} failed onchain: ${JSON.stringify(status.value.err)} (tx ${signature})`);
  }
  return signature;
}

module.exports = {
  CONFIG_ACCOUNT_SIZE,
  PROGRAM_ID,
  SIGHASH,
  configPda,
  connectionFromEnv,
  decodeConfig,
  initializeConfigInstruction,
  loadLocalEnv,
  programDataAddress,
  readIssuerPubkey,
  readKeypair,
  readPublicKeyArg,
  sendAndConfirm,
  updateConfigInstruction,
};
