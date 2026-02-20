export type Mode = "paper" | "live";

export type AuthorityPolicy = "strict" | "permissive";

export type LogLevel = "DEBUG" | "INFO" | "OK" | "WARN" | "ERROR";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface BotConfig {
  RPC_URL: string;
  MODE: Mode;
  WALLET_KEYPAIR_PATH: string | undefined;
  HELIUS_API_KEY: string;
  TRADE_SIZE_SOL: number;
  TRADE_SIZE_SOL_MIN: number;
  TRADE_SIZE_SOL_MAX: number;
  DYNAMIC_POSITION_SIZING: boolean;
  MAX_SOL_AT_RISK: number;
  MAX_TRADES_PER_HOUR: number;
  MIN_LIQUIDITY_SOL: number;
  MIN_MC_USD: number;
  MAX_MC_USD: number;
  MIN_HOLDER_COUNT: number;
  MIN_VOLUME_M5_USD: number;
  SLIPPAGE_BPS: number;
  SCORE_THRESHOLD: number;
  KILL_SWITCH_FILE_PATH: string;
  FAILURE_CIRCUIT_BREAKER_N: number;
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: number;
  WEB_PORT: number;
  BOT_POLL_SECONDS: number;
  MAX_CANDIDATES_PER_SCAN: number;
  MAX_SCAN_POOL_FETCH: number;
  MODE_SCOPED_DB: boolean;
  DB_PATH: string;
  AUTHORITY_POLICY: AuthorityPolicy;
  TOKEN_COOLDOWN_MINUTES: number;
  PRICE_IMPACT_PCT_CAP: number;
  QUOTE_STABILITY_PCT_CAP: number;
  FRESH_POOL_WINDOW_MINUTES: number;
  TP1_PCT: number;
  TP2_PCT: number;
  TP3_PCT: number;
  TP1_SELL_RATIO: number;
  TRAILING_STOP_PCT: number;
  SL_PCT: number;
  TIME_STOP_MINUTES: number;
  PRIORITY_FEE_LAMPORTS: number;
  SOL_PRICE_CACHE_SECONDS: number;
  JUPITER_BASE_URL: string;
  GECKO_TERMINAL_BASE_URL: string;
  LOG_LEVEL: LogLevel;
}

export interface PoolCandidate {
  poolId: string;
  dexId: string;
  baseMint: string;
  quoteMint: string;
  tradeMint: string;
  createdAt: string;
  reserveUsd: number;
  liquiditySol: number;
  txBuysM5: number;
  txSellsM5: number;
  txBuysM15: number;
  txSellsM15: number;
  txBuysM30: number;
  txSellsM30: number;
  txBuysH1: number;
  txSellsH1: number;
  volumeM5Usd: number;
  volumeM15Usd: number;
  volumeH1Usd: number;
  priceChangeM5Pct: number;
  priceChangeH1Pct: number;
  marketCapUsd: number;
  fdvUsd: number;
  raw: Record<string, unknown>;
}

export interface MintAuthorityStatus {
  mint: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
  hasAnyAuthority: boolean;
}

export interface HardFilterResult {
  passed: boolean;
  reasons: string[];
  warnings: string[];
  quoteStabilityPct?: number;
  priceImpactPct?: number;
  authority?: MintAuthorityStatus;
}

export interface ScoreResult {
  total: number;
  freshness: number;
  flow: number;
  route: number;
  penalties: number;
  viralityDetail?: {
    accelScore: number;
    buyRatioScore: number;
    volAccelScore: number;
    momentumScore: number;
  };
}

export interface StrategyDecision {
  candidate: PoolCandidate;
  score: ScoreResult;
  filters: HardFilterResult;
  shouldTrade: boolean;
  reasonSummary: string;
}

export interface ActivePosition {
  id: number;
  tokenMint: string;
  openedTs: string;
  status: string;
  entryPriceSol: number;
  entryNotionalSol: number;
  quantityRaw: string;
  quantityRemainingRaw: string;
  decimals: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  stopLossPct: number;
  takeProfit1Pct: number;
  takeProfit2Pct: number;
  timeStopMinutes: number;
  metadata: Record<string, unknown>;
}

export interface SwapExecutionResult {
  status: "PAPER" | "CONFIRMED";
  signature?: string;
  inAmountRaw: string;
  outAmountRaw: string;
  expectedOutRaw: string;
  routeSummary: string[];
  simulationLogs?: string[];
  confirmationMs?: number;
  postBalances?: {
    inputBefore: string;
    inputAfter: string;
    outputBefore: string;
    outputAfter: string;
  };
  quote: Record<string, unknown>;
}

export interface ExitAction {
  reason: "TP1" | "TP2" | "TP3" | "STOP_LOSS" | "TIME_STOP" | "TRAILING_STOP";
  sellAmountRaw: string;
  markTp1: boolean;
  markTp2: boolean;
  markTp3: boolean;
}
