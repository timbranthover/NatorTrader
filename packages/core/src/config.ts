import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { BotConfig } from "./types.js";

const workspaceBaseDir = process.env.APP_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const envCandidates = [
  path.resolve(workspaceBaseDir, ".env"),
  path.resolve(process.cwd(), ".env"),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const num = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") {
        return defaultValue;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    });

const intNum = (defaultValue: number) =>
  num(defaultValue).refine((value) => Number.isInteger(value), {
    message: "Expected integer",
  });

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === "") {
        return defaultValue;
      }
      return value.trim().toLowerCase() === "true";
    });

const envSchema = z.object({
  RPC_URL: z.string().min(1, "RPC_URL is required"),
  MODE: z.enum(["paper", "live"]).default("paper"),
  WALLET_KEYPAIR_PATH: z.string().optional(),
  HELIUS_API_KEY: z.string().default(""),
  TRADE_SIZE_SOL: num(0.02).refine((v) => v > 0, "TRADE_SIZE_SOL must be > 0"),
  TRADE_SIZE_SOL_MIN: num(0.01).refine((v) => v > 0, "TRADE_SIZE_SOL_MIN must be > 0"),
  TRADE_SIZE_SOL_MAX: num(0.05).refine((v) => v > 0, "TRADE_SIZE_SOL_MAX must be > 0"),
  DYNAMIC_POSITION_SIZING: bool(false),
  MAX_SOL_AT_RISK: num(0.1).refine((v) => v > 0, "MAX_SOL_AT_RISK must be > 0"),
  MAX_TRADES_PER_HOUR: intNum(3).refine((v) => v > 0, "MAX_TRADES_PER_HOUR must be > 0"),
  MIN_LIQUIDITY_SOL: num(8).refine((v) => v >= 0, "MIN_LIQUIDITY_SOL must be >= 0"),
  MIN_MC_USD: num(10_000).refine((v) => v >= 0, "MIN_MC_USD must be >= 0"),
  MAX_MC_USD: num(2_000_000).refine((v) => v >= 0, "MAX_MC_USD must be >= 0"),
  MIN_HOLDER_COUNT: intNum(50).refine((v) => v >= 0, "MIN_HOLDER_COUNT must be >= 0"),
  MIN_VOLUME_M5_USD: num(500).refine((v) => v >= 0, "MIN_VOLUME_M5_USD must be >= 0"),
  SLIPPAGE_BPS: intNum(100).refine((v) => v > 0, "SLIPPAGE_BPS must be > 0"),
  SCORE_THRESHOLD: intNum(65).refine((v) => v >= 0 && v <= 100, "SCORE_THRESHOLD must be 0..100"),
  KILL_SWITCH_FILE_PATH: z.string().default("./KILL_SWITCH"),
  FAILURE_CIRCUIT_BREAKER_N: intNum(3).refine((v) => v > 0, "FAILURE_CIRCUIT_BREAKER_N must be > 0"),
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: intNum(30).refine(
    (v) => v > 0,
    "CIRCUIT_BREAKER_COOLDOWN_MINUTES must be > 0",
  ),
  WEB_PORT: intNum(8787).refine((v) => v > 0, "WEB_PORT must be > 0"),
  BOT_POLL_SECONDS: intNum(15).refine((v) => v >= 5, "BOT_POLL_SECONDS must be >= 5"),
  MAX_CANDIDATES_PER_SCAN: intNum(4).refine((v) => v > 0, "MAX_CANDIDATES_PER_SCAN must be > 0"),
  MAX_SCAN_POOL_FETCH: intNum(20).refine((v) => v > 0, "MAX_SCAN_POOL_FETCH must be > 0"),
  MODE_SCOPED_DB: bool(true),
  DB_PATH: z.string().default("./data/autotrader.db"),
  AUTHORITY_POLICY: z.enum(["strict", "permissive"]).default("permissive"),
  TOKEN_COOLDOWN_MINUTES: intNum(180).refine((v) => v >= 0, "TOKEN_COOLDOWN_MINUTES must be >= 0"),
  PRICE_IMPACT_PCT_CAP: num(5).refine((v) => v >= 0, "PRICE_IMPACT_PCT_CAP must be >= 0"),
  QUOTE_STABILITY_PCT_CAP: num(8).refine((v) => v >= 0, "QUOTE_STABILITY_PCT_CAP must be >= 0"),
  FRESH_POOL_WINDOW_MINUTES: intNum(60).refine((v) => v > 0, "FRESH_POOL_WINDOW_MINUTES must be > 0"),
  TP1_PCT: num(30).refine((v) => v > 0, "TP1_PCT must be > 0"),
  TP2_PCT: num(75).refine((v) => v > 0, "TP2_PCT must be > 0"),
  TP3_PCT: num(150).refine((v) => v > 0, "TP3_PCT must be > 0"),
  TP1_SELL_RATIO: num(0.33).refine((v) => v > 0 && v <= 1, "TP1_SELL_RATIO must be > 0 and <= 1"),
  TRAILING_STOP_PCT: num(15).refine((v) => v >= 0, "TRAILING_STOP_PCT must be >= 0"),
  SL_PCT: num(25).refine((v) => v > 0, "SL_PCT must be > 0"),
  TIME_STOP_MINUTES: intNum(60).refine((v) => v > 0, "TIME_STOP_MINUTES must be > 0"),
  PRIORITY_FEE_LAMPORTS: intNum(0).refine((v) => v >= 0, "PRIORITY_FEE_LAMPORTS must be >= 0"),
  SOL_PRICE_CACHE_SECONDS: intNum(120).refine((v) => v > 0, "SOL_PRICE_CACHE_SECONDS must be > 0"),
  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/swap/v1"),
  GECKO_TERMINAL_BASE_URL: z.string().default("https://api.geckoterminal.com/api/v2"),
  LOG_LEVEL: z.enum(["DEBUG", "INFO", "OK", "WARN", "ERROR"]).default("INFO"),
});

let cachedConfig: BotConfig | null = null;

function withModeDbSuffix(inputPath: string, mode: "paper" | "live"): string {
  const parsed = path.parse(inputPath);
  const ext = parsed.ext || ".db";
  const suffix = `.${mode}`;
  if (parsed.name.endsWith(suffix)) {
    return path.join(parsed.dir, `${parsed.name}${ext}`);
  }
  return path.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
}

function resolveModeScopedDbPath(rawDbPath: string, mode: "paper" | "live", modeScoped: boolean): string {
  const templated = rawDbPath.includes("{mode}")
    ? rawDbPath.replaceAll("{mode}", mode)
    : rawDbPath;
  if (!modeScoped || rawDbPath.includes("{mode}")) {
    return templated;
  }
  return withModeDbSuffix(templated, mode);
}

export function loadConfig(): BotConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const baseDir = process.env.APP_ROOT ?? process.env.INIT_CWD ?? process.cwd();
  const parsed = envSchema.parse(process.env);
  if (parsed.TRADE_SIZE_SOL_MIN > parsed.TRADE_SIZE_SOL_MAX) {
    throw new Error("TRADE_SIZE_SOL_MIN cannot be greater than TRADE_SIZE_SOL_MAX");
  }
  if (parsed.MODE === "live" && !parsed.WALLET_KEYPAIR_PATH) {
    throw new Error("MODE=live requires WALLET_KEYPAIR_PATH");
  }

  cachedConfig = {
    ...parsed,
    DB_PATH: path.resolve(baseDir, resolveModeScopedDbPath(parsed.DB_PATH, parsed.MODE, parsed.MODE_SCOPED_DB)),
    KILL_SWITCH_FILE_PATH: path.resolve(baseDir, parsed.KILL_SWITCH_FILE_PATH),
    WALLET_KEYPAIR_PATH: parsed.WALLET_KEYPAIR_PATH ? path.resolve(baseDir, parsed.WALLET_KEYPAIR_PATH) : undefined,
  };

  return cachedConfig as BotConfig;
}

export function maskPubkey(pubkey: string | undefined): string {
  if (!pubkey || pubkey.length < 10) {
    return "N/A";
  }
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}
