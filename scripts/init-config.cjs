/**
 * Registers the server-held issuer key in the onchain Config account.
 *
 * Run after the program is deployed, signed by the deployer (it must be the program's
 * upgrade authority, which `initialize_config` checks against ProgramData):
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com node scripts/init-config.cjs
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com node scripts/init-config.cjs --admin-key .keys/deployer.json
 *
 * Plain CommonJS on purpose: docs/stack.md's approved dependency list has no ts-node, and
 * this must stay runnable with just `node`.
 *
 * IDL-free: `cargo build-sbf` produces bytecode but no `target/idl/proof_of_skill.json`,
 * and this app's client never reads an IDL (see `lib/solana/`), so requiring one here would
 * tie first-time setup to a build path that does not exist on every host.
 */
const { PublicKey } = require("@solana/web3.js");
const {
  PROGRAM_ID,
  configPda,
  connectionFromEnv,
  decodeConfig,
  initializeConfigInstruction,
  programDataAddress,
  readKeypair,
  readIssuerPubkey,
  sendAndConfirm,
} = require("./proof-of-skill.cjs");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

/**
 * `bpf_loader_upgradeable` ProgramData layout: `4` state discriminant, `8` slot, then a
 * `COption<Pubkey>` upgrade authority (4 byte flag + 32 byte key). Returns null when the
 * authority has been relinquished, which is the state that makes `initialize_config`
 * permanently unreachable.
 */
function readUpgradeAuthority(data) {
  if (data.length < 48) {
    return null;
  }
  return data.readUInt32LE(12) === 1 ? new PublicKey(data.subarray(16, 48)) : null;
}

async function main() {
  const issuer = readIssuerPubkey(argValue("--issuer") || process.env.ISSUER_PUBKEY);
  const admin = readKeypair(argValue("--admin-key") || process.env.ADMIN_KEY_FILE, "admin");
  const connection = connectionFromEnv();
  const pda = configPda();

  const existing = await connection.getAccountInfo(pda);
  if (existing !== null) {
    const config = decodeConfig(existing.data);
    if (config.issuer.equals(issuer)) {
      console.log(`Config already initialized with the expected issuer: ${issuer.toBase58()}`);
      return;
    }
    throw new Error(
      `Config already exists at ${pda.toBase58()} with issuer ${config.issuer.toBase58()}, ` +
        `not ${issuer.toBase58()}. Rotate it deliberately with: ` +
        "node scripts/rotate-issuer.cjs --new-issuer <pubkey>",
    );
  }

  // Checked before signing so a wrong-key mistake costs no fee. The program makes the same
  // comparison, so this only turns a revert into a readable message.
  const programData = programDataAddress();
  const account = await connection.getAccountInfo(programData);
  if (account === null) {
    throw new Error(
      `no ProgramData at ${programData.toBase58()} for program ${PROGRAM_ID.toBase58()}. Deploy it first.`,
    );
  }

  const authority = readUpgradeAuthority(account.data);
  if (authority === null) {
    throw new Error(
      "this program has no upgrade authority, so initialize_config can never succeed. " +
        "Deploy a build whose authority is the intended admin key.",
    );
  }
  if (!authority.equals(admin.keypair.publicKey)) {
    throw new Error(
      `the upgrade authority is ${authority.toBase58()}, but the signing key is ` +
        `${admin.keypair.publicKey.toBase58()} (${admin.path}). They must be the same account.`,
    );
  }

  console.log(`Initializing Config with issuer ${issuer.toBase58()}`);
  console.log(`  admin:   ${admin.keypair.publicKey.toBase58()}`);
  console.log(`  program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  rpc:     ${connection.rpcEndpoint}`);

  const signature = await sendAndConfirm(
    connection,
    admin.keypair,
    initializeConfigInstruction(admin.keypair.publicKey, issuer, programData),
    "initialize_config",
  );

  const created = decodeConfig((await connection.getAccountInfo(pda)).data);
  if (!created.issuer.equals(issuer)) {
    throw new Error(
      `transaction landed but Config.issuer is ${created.issuer.toBase58()}, not ${issuer.toBase58()}`,
    );
  }

  console.log(`Config created at ${pda.toBase58()} (admin ${created.admin.toBase58()}, bump ${created.bump})`);
  console.log(`  tx: ${signature}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
