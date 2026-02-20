const fs = require("node:fs");
const path = require("node:path");
const { Keypair } = require("@solana/web3.js");

const outputArg = process.argv[2];
const defaultOutput = path.resolve(process.cwd(), "../../keys/hot-wallet.json");
const outputPath = path.resolve(process.cwd(), outputArg ?? defaultOutput);

if (fs.existsSync(outputPath)) {
  console.error(`WALLET FILE ALREADY EXISTS: ${outputPath}`);
  console.error("ABORTING TO AVOID OVERWRITE.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const keypair = Keypair.generate();
fs.writeFileSync(outputPath, JSON.stringify(Array.from(keypair.secretKey)));

console.log(`WALLET_FILE=${outputPath}`);
console.log(`BOT_WALLET_PUBLIC_KEY=${keypair.publicKey.toBase58()}`);
console.log("KEEP THIS FILE PRIVATE. DO NOT COMMIT OR SHARE IT.");
