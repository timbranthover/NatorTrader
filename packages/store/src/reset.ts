import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Store } from "./db.js";

function removeIfExists(path: string): void {
  if (fs.existsSync(path)) {
    fs.rmSync(path, { force: true });
  }
}

dotenv.config();
const baseDir = process.env.APP_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const dbPath = path.resolve(baseDir, process.env.DB_PATH ?? "./data/autotrader.db");
removeIfExists(dbPath);
removeIfExists(`${dbPath}-wal`);
removeIfExists(`${dbPath}-shm`);

const store = new Store(dbPath);
store.initialize();
store.close();

// eslint-disable-next-line no-console
console.log(`DB RESET COMPLETE: ${dbPath}`);
