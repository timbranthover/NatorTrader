import path from "node:path";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

const baseDir = process.env.APP_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const dbPath = path.resolve(baseDir, process.env.DB_PATH ?? "./data/autotrader.db");
const db = new Database(dbPath, { readonly: true });

const openRows = db
  .prepare(
    `SELECT id, token_mint, entry_notional_sol, metadata_json
     FROM positions
     WHERE status = 'OPEN'
     ORDER BY id ASC`,
  )
  .all() as Array<{
  id: number;
  token_mint: string;
  entry_notional_sol: number;
  metadata_json: string;
}>;

const open = openRows.map((row) => {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json ?? "{}") as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  const currentValueSol = Number(metadata.currentValueSol ?? 0);
  const pnlPct = Number(metadata.pnlPct ?? 0);
  return {
    id: row.id,
    mint: row.token_mint,
    entrySol: row.entry_notional_sol,
    currentValueSol,
    pnlPct,
  };
});

const entrySol = open.reduce((sum, item) => sum + item.entrySol, 0);
const currentSol = open.reduce((sum, item) => sum + item.currentValueSol, 0);
const unrealizedSol = currentSol - entrySol;
const unrealizedPct = entrySol > 0 ? (unrealizedSol / entrySol) * 100 : 0;

const trades = db
  .prepare(
    `SELECT ts, side, output_mint, in_amount, out_amount, status
     FROM trades
     ORDER BY id DESC
     LIMIT 8`,
  )
  .all() as Array<{
  ts: string;
  side: string;
  output_mint: string;
  in_amount: string;
  out_amount: string | null;
  status: string;
}>;

// eslint-disable-next-line no-console
console.log("===== PERFORMANCE SNAPSHOT =====");
// eslint-disable-next-line no-console
console.log(`DB: ${dbPath}`);
// eslint-disable-next-line no-console
console.log(`OPEN_POSITIONS: ${open.length}`);
// eslint-disable-next-line no-console
console.log(`ENTRY_SOL: ${entrySol.toFixed(6)}`);
// eslint-disable-next-line no-console
console.log(`CURRENT_SOL: ${currentSol.toFixed(6)}`);
// eslint-disable-next-line no-console
console.log(`UNREALIZED_SOL: ${unrealizedSol.toFixed(6)} (${unrealizedPct.toFixed(2)}%)`);
// eslint-disable-next-line no-console
console.log("----- OPEN POSITIONS -----");
for (const item of open) {
  // eslint-disable-next-line no-console
  console.log(
    `#${item.id} ${item.mint} | ENTRY=${item.entrySol.toFixed(6)} SOL | NOW=${item.currentValueSol.toFixed(6)} SOL | PNL=${item.pnlPct.toFixed(2)}%`,
  );
}
// eslint-disable-next-line no-console
console.log("----- RECENT TRADES -----");
for (const trade of trades) {
  // eslint-disable-next-line no-console
  console.log(
    `${trade.ts} ${trade.side} ${trade.output_mint} IN=${trade.in_amount} OUT=${trade.out_amount ?? "n/a"} ${trade.status}`,
  );
}
