/**
 * Rotates the authorized issuer on the deployed program, without a redeploy.
 *
 *   node scripts/rotate-issuer.cjs --new-issuer <BASE58_PUBKEY>
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *     node scripts/rotate-issuer.cjs --new-issuer 9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu
 *
 * The signer must be the key stored in `Config.admin` (the upgrade authority that ran
 * `init-config.cjs`), because `update_config` is guarded by `has_one = admin`. After this
 * lands, the server's `ISSUER_PRIVATE_KEY` must be replaced with the new keypair and the
 * app restarted — `/api/issue` refuses to co-sign when it is not the registered issuer.
 */
const {
  PROGRAM_ID,
  configPda,
  connectionFromEnv,
  decodeConfig,
  readKeypair,
  readPublicKeyArg,
  sendAndConfirm,
  updateConfigInstruction,
} = require("./proof-of-skill.cjs");

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return undefined;
}

const ALL_ZERO = new Uint8Array(32);

async function main() {
  const newIssuer = readPublicKeyArg(
    argValue("--new-issuer") || process.env.NEW_ISSUER_PUBKEY,
    "new issuer",
  );

  if (newIssuer.toBytes().every((byte, index) => byte === ALL_ZERO[index])) {
    throw new Error("the new issuer must not be the all-zero address: it can never sign");
  }

  const admin = readKeypair(argValue("--admin-key") || process.env.ADMIN_KEY_FILE, "admin");
  const connection = connectionFromEnv();
  const pda = configPda();

  const account = await connection.getAccountInfo(pda);
  if (account === null) {
    throw new Error(
      `no Config account at ${pda.toBase58()} for program ${PROGRAM_ID.toBase58()}. ` +
        "Run scripts/init-config.cjs first.",
    );
  }

  const config = decodeConfig(account.data);
  if (!config.admin.equals(admin.keypair.publicKey)) {
    throw new Error(
      `Config.admin is ${config.admin.toBase58()}, but the signing key is ${admin.keypair.publicKey.toBase58()} ` +
        `(${admin.path}). Only Config.admin can rotate the issuer, so this would revert.`,
    );
  }

  if (config.issuer.equals(newIssuer)) {
    console.log(`Issuer is already ${newIssuer.toBase58()} — nothing to do.`);
    return;
  }

  console.log(`Rotating issuer on Config ${pda.toBase58()}`);
  console.log(`  admin:          ${config.admin.toBase58()}`);
  console.log(`  issuer (old):   ${config.issuer.toBase58()}`);
  console.log(`  issuer (new):   ${newIssuer.toBase58()}`);

  const signature = await sendAndConfirm(
    connection,
    admin.keypair,
    updateConfigInstruction(admin.keypair.publicKey, newIssuer),
    "update_config",
  );

  const after = decodeConfig((await connection.getAccountInfo(pda)).data);
  if (!after.issuer.equals(newIssuer)) {
    throw new Error(
      `transaction landed but Config.issuer is ${after.issuer.toBase58()}, not ${newIssuer.toBase58()}`,
    );
  }

  console.log(`Success. New issuer ${after.issuer.toBase58()}`);
  console.log(`  tx: ${signature}`);
  console.log("Next: set ISSUER_PRIVATE_KEY to the new keypair in .env.local and restart the app.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
