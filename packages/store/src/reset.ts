import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { Store } from "./db.js";

type Mode = "paper" | "live";

function withModeDbSuffix(inputPath: string, mode: Mode): string {
  const parsed = path.parse(inputPath);
  const ext = parsed.ext || ".db";
  const suffix = `.${mode}`;
  if (parsed.name.endsWith(suffix)) {
    return path.join(parsed.dir, `${parsed.name}${ext}`);
  }
  return path.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
}

function resolveModeScopedDbPath(rawDbPath: string, mode: Mode, modeScoped: boolean): string {
  const templated = rawDbPath.includes("{mode}")
    ? rawDbPath.replaceAll("{mode}", mode)
    : rawDbPath;
  if (!modeScoped || rawDbPath.includes("{mode}")) {
    return templated;
  }
  return withModeDbSuffix(templated, mode);
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim() === "") {
    return fallback;
  }
  return value.trim().toLowerCase() === "true";
}

function removeIfExists(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  try {
    fs.rmSync(targetPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FAILED TO REMOVE DB FILE: ${targetPath} (${message}). STOP RUNNING BOT/WEB AND RETRY.`);
  }
}

dotenv.config();
const baseDir = process.env.APP_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const modeRaw = process.env.MODE === "live" ? "live" : "paper";
const mode = modeRaw as Mode;
const modeScoped = envBool(process.env.MODE_SCOPED_DB, true);
const rawDbPath = process.env.DB_PATH ?? "./data/autotrader.db";
const resolvedDbPath = resolveModeScopedDbPath(rawDbPath, mode, modeScoped);
const dbPath = path.resolve(baseDir, resolvedDbPath);
removeIfExists(dbPath);
removeIfExists(`${dbPath}-wal`);
removeIfExists(`${dbPath}-shm`);

const store = new Store(dbPath);
store.initialize();
store.close();

// eslint-disable-next-line no-console
console.log(`DB RESET COMPLETE: ${dbPath}`);
