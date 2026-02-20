import { existsSync } from "node:fs";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  CircuitBreaker,
  Logger,
  canOpenNewPosition,
  computeAtRiskSol,
  loadConfig,
  maskPubkey,
  type BotConfig,
  type ExitAction,
  type HardFilterResult,
  type PoolCandidate,
  type ScoreResult,
  type StrategyDecision,
  type SwapExecutionResult,
} from "@autotrader/core";
import { JupiterClient, type JupiterQuoteResponse } from "@autotrader/jupiter";
import {
  WSOL_MINT,
  checkRpcHealth,
  confirmSignature,
  createRpcConnection,
  getAssetBalance,
  getMintAuthorityStatus,
  getMintDecimals,
  getSolBalance,
  getTokenHolderCount,
  loadKeypairFromFile,
  simulateVersionedTransaction,
} from "@autotrader/solana";
import { Store } from "@autotrader/store";
import { fetchPoolCandidates } from "./scanner.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface EvaluatedCandidate {
  decision: StrategyDecision;
  quote: JupiterQuoteResponse | undefined;
}

function computeTradeSize(score: number, config: BotConfig): number {
  if (!config.DYNAMIC_POSITION_SIZING) {
    return config.TRADE_SIZE_SOL;
  }
  const range = config.TRADE_SIZE_SOL_MAX - config.TRADE_SIZE_SOL_MIN;
  const ratio = score >= 90 ? 1.0 : score >= 80 ? 0.8 : score >= 70 ? 0.6 : 0.0;
  return config.TRADE_SIZE_SOL_MIN + range * ratio;
}

function computeFractionRaw(quantityRaw: string, ratio: number): bigint {
  const safeRatio = clamp(ratio, 0, 1);
  const ratioBps = BigInt(Math.floor(safeRatio * 10_000));
  return (BigInt(quantityRaw) * ratioBps) / 10_000n;
}

export class AutoTraderBot {
  private readonly config: BotConfig;
  private readonly store: Store;
  private readonly logger: Logger;
  private readonly jupiter: JupiterClient;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly connection;
  private readonly statusWallet: Keypair | null;
  private readonly wallet: Keypair | null;
  private running = false;

  private solPriceCacheUsd = 0;
  private solPriceCacheExpiresAt = 0;
  private scannerBackoffMs = 0;
  private scannerBackoffUntil = 0;

  public constructor() {
    this.config = loadConfig();
    this.store = new Store(this.config.DB_PATH);
    this.store.initialize();
    this.store.snapshotConfig(this.config);

    this.logger = new Logger({
      component: "BOT",
      level: this.config.LOG_LEVEL,
      sink: {
        write: (entry) => {
          this.store.insertLog(entry);
        },
      },
    });
    this.jupiter = new JupiterClient(this.config.JUPITER_BASE_URL, this.logger);
    this.connection = createRpcConnection(this.config.RPC_URL);
    this.circuitBreaker = new CircuitBreaker(
      this.config.FAILURE_CIRCUIT_BREAKER_N,
      this.config.CIRCUIT_BREAKER_COOLDOWN_MINUTES,
    );

    let configuredWallet: Keypair | null = null;
    if (this.config.WALLET_KEYPAIR_PATH) {
      try {
        configuredWallet = loadKeypairFromFile(this.config.WALLET_KEYPAIR_PATH);
      } catch (error) {
        this.logger.warn("WALLET_READ_FAIL", "FAILED TO READ WALLET KEYPAIR FILE", {
          path: this.config.WALLET_KEYPAIR_PATH,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.statusWallet = configuredWallet;
    this.wallet = this.config.MODE === "live" ? configuredWallet : null;
  }

  public async start(): Promise<void> {
    this.running = true;
    this.logger.ok("BOOT", "===== BRANTSWAP BOT START =====", {
      mode: this.config.MODE,
      pollSeconds: this.config.BOT_POLL_SECONDS,
      dbPath: this.config.DB_PATH,
      wallet: this.statusWallet ? this.statusWallet.publicKey.toBase58() : "N/A",
    });

    while (this.running) {
      const loopStart = Date.now();
      try {
        await this.tick();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.circuitBreaker.recordFailure();
        this.logger.error("LOOP_ERROR", "ERROR IN MAIN LOOP", {
          error: message,
          circuit: this.circuitBreaker.state(),
        });
      }

      const elapsed = Date.now() - loopStart;
      const waitMs = Math.max(0, this.config.BOT_POLL_SECONDS * 1000 - elapsed);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }

  public stop(): void {
    this.running = false;
    this.logger.warn("STOP", "STOP SIGNAL RECEIVED", {});
  }

  private async tick(): Promise<void> {
    const killSwitchActive = existsSync(this.config.KILL_SWITCH_FILE_PATH);
    const rpcHealth = await checkRpcHealth(this.connection);
    const walletPubkey = this.statusWallet ? this.statusWallet.publicKey.toBase58() : "N/A";
    const walletMasked = this.statusWallet ? maskPubkey(walletPubkey) : "N/A";
    let walletBalanceSol = 0;
    if (this.statusWallet) {
      walletBalanceSol = await getSolBalance(this.connection, this.statusWallet.publicKey);
    }

    this.store.setRuntimeState("system_status", {
      mode: this.config.MODE,
      rpcOk: rpcHealth.ok,
      rpcSlot: rpcHealth.slot ?? null,
      rpcError: rpcHealth.error ?? null,
      walletPubkey,
      walletMasked,
      walletBalanceSol,
      heartbeatTs: new Date().toISOString(),
    });

    const nowMs = Date.now();
    if (nowMs < this.scannerBackoffUntil) {
      const waitSec = Math.ceil((this.scannerBackoffUntil - nowMs) / 1000);
      this.logger.warn("SCANNER_BACKOFF", "WARNING SCANNER BACKOFF ACTIVE", {
        waitSec,
        backoffMs: this.scannerBackoffMs,
      });
      await this.monitorPositions();
      this.store.setRuntimeState("scanner_status", {
        lastScanTime: new Date().toISOString(),
        poolsSeenCount: this.store.getScannerStats().poolsSeenCount,
        candidatesCount: this.store.getScannerStats().candidatesCount,
        evaluatedThisScan: 0,
        newPoolsThisScan: 0,
        backoffActive: true,
        backoffUntilTs: new Date(this.scannerBackoffUntil).toISOString(),
      });
      return;
    }

    const solPriceUsd = await this.getSolPriceUsd();
    let scannerCandidates: PoolCandidate[] = [];
    try {
      scannerCandidates = await fetchPoolCandidates(this.config.GECKO_TERMINAL_BASE_URL, solPriceUsd, this.logger);
      this.scannerBackoffMs = 0;
      this.scannerBackoffUntil = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isScannerRateLimited(message)) {
        const base = this.scannerBackoffMs > 0 ? this.scannerBackoffMs * 2 : 20_000;
        this.scannerBackoffMs = Math.min(base, 5 * 60_000);
        this.scannerBackoffUntil = Date.now() + this.scannerBackoffMs;
        this.logger.warn("SCANNER_RATE_LIMIT", "WARNING SCANNER RATE LIMITED - BACKING OFF", {
          backoffMs: this.scannerBackoffMs,
          backoffUntilTs: new Date(this.scannerBackoffUntil).toISOString(),
          error: message,
        });

        await this.monitorPositions();
        this.store.setRuntimeState("scanner_status", {
          lastScanTime: new Date().toISOString(),
          poolsSeenCount: this.store.getScannerStats().poolsSeenCount,
          candidatesCount: this.store.getScannerStats().candidatesCount,
          evaluatedThisScan: 0,
          newPoolsThisScan: 0,
          backoffActive: true,
          backoffUntilTs: new Date(this.scannerBackoffUntil).toISOString(),
          lastError: message,
        });
        return;
      }
      throw error;
    }
    const fetchWindow = scannerCandidates.slice(0, this.config.MAX_SCAN_POOL_FETCH);
    const unseenCandidates = fetchWindow.filter((candidate) => !this.store.hasSeenPool(candidate.poolId));
    const preScored = unseenCandidates.map((candidate) => ({
      candidate,
      preScore: this.computePreScore(candidate),
    }));
    this.logger.debug("PRE_SCORE", "UNSEEN CANDIDATE PRE-SCORES", {
      count: preScored.length,
      top: preScored
        .slice()
        .sort((a, b) => b.preScore - a.preScore)
        .slice(0, 20)
        .map((item) => ({
          poolId: item.candidate.poolId,
          mint: item.candidate.tradeMint,
          preScore: Number(item.preScore.toFixed(3)),
        })),
    });
    const ranked = preScored.sort((a, b) => b.preScore - a.preScore).map((item) => item.candidate);
    const candidatesToEvaluate = ranked.slice(0, this.config.MAX_CANDIDATES_PER_SCAN);
    if (fetchWindow.length > candidatesToEvaluate.length) {
      this.logger.debug("SCAN_LIMIT", "CANDIDATE LIST TRUNCATED", {
        fetched: scannerCandidates.length,
        fetchWindow: fetchWindow.length,
        unseen: unseenCandidates.length,
        evaluating: candidatesToEvaluate.length,
      });
    }
    let evaluatedCount = 0;
    let scannedNewPools = unseenCandidates.length;
    let openedTradeThisTick = false;

    for (const candidate of candidatesToEvaluate) {
      this.store.upsertSeenPool({
        poolId: candidate.poolId,
        baseMint: candidate.baseMint,
        quoteMint: candidate.quoteMint,
        dexId: candidate.dexId,
        createdAt: candidate.createdAt,
        liquiditySol: candidate.liquiditySol,
        reserveUsd: candidate.reserveUsd,
        raw: candidate.raw,
      });
      const evaluated = await this.evaluateCandidate(candidate);
      evaluatedCount += 1;
      this.store.recordDecision({
        poolId: candidate.poolId,
        mint: candidate.tradeMint,
        score: evaluated.decision.score.total,
        passed: evaluated.decision.shouldTrade,
        mode: this.config.MODE,
        reasons: [...evaluated.decision.filters.reasons, ...evaluated.decision.filters.warnings],
        filters: evaluated.decision.filters as unknown as Record<string, unknown>,
        raw: evaluated.decision as unknown as Record<string, unknown>,
      });

      if (!evaluated.decision.shouldTrade || openedTradeThisTick) {
        continue;
      }

      const plannedTradeSizeSol = computeTradeSize(evaluated.decision.score.total, this.config);
      const risk = this.getRiskSnapshot(candidate.tradeMint, killSwitchActive);
      this.store.setRuntimeState("risk_status", risk);
      const riskDecision = canOpenNewPosition(this.config, {
        atRiskSol: risk.atRiskSol,
        tradesLastHour: risk.tradesLastHour,
        cooldownActive: risk.cooldownActive,
        killSwitchActive: risk.killSwitchActive,
        circuitOpen: risk.circuitOpen,
      }, plannedTradeSizeSol);
      if (!riskDecision.allow) {
        this.logger.warn("RISK_BLOCK", "WARNING ENTRY BLOCKED BY RISK RULES", {
          mint: candidate.tradeMint,
          plannedTradeSizeSol,
          reasons: riskDecision.reasons,
        });
        continue;
      }

      if (!evaluated.quote) {
        this.logger.warn("NO_QUOTE", "WARNING ENTRY SKIPPED: NO QUOTE", { mint: candidate.tradeMint });
        continue;
      }

      const opened = await this.openPosition(candidate, evaluated.quote, evaluated.decision.score.total);
      if (opened) {
        openedTradeThisTick = true;
      }
    }

    await this.monitorPositions();

    const scannerStats = this.store.getScannerStats();
    this.store.setRuntimeState("scanner_status", {
      lastScanTime: new Date().toISOString(),
      poolsSeenCount: scannerStats.poolsSeenCount,
      candidatesCount: scannerStats.candidatesCount,
      evaluatedThisScan: evaluatedCount,
      newPoolsThisScan: scannedNewPools,
      backoffActive: false,
      backoffUntilTs: null,
    });

    const riskState = this.getRiskSnapshot(undefined, killSwitchActive);
    this.store.setRuntimeState("risk_status", riskState);
  }

  private computePreScore(candidate: PoolCandidate): number {
    const m5Total = candidate.txBuysM5 + candidate.txSellsM5;
    const m15Total = candidate.txBuysM15 + candidate.txSellsM15;
    const baselinePer5 = m15Total > 0 ? m15Total / 3 : 1;
    const accel = baselinePer5 > 0 ? m5Total / baselinePer5 : 0;
    const buyRatio = m5Total >= 5 ? candidate.txBuysM5 / m5Total : 0.5;
    const priceSignal = candidate.priceChangeM5Pct > 5 ? 1 : 0;
    return accel * 10 + buyRatio * 20 + priceSignal * 10;
  }

  private getRiskSnapshot(targetMint?: string, killSwitchOverride?: boolean): {
    killSwitchActive: boolean;
    atRiskSol: number;
    maxSolAtRisk: number;
    tradesLastHour: number;
    maxTradesPerHour: number;
    cooldownActive: boolean;
    circuitOpen: boolean;
    circuitReopenAt: string | null;
    consecutiveFailures: number;
  } {
    const positions = this.store.listActivePositions();
    const atRiskSol = computeAtRiskSol(
      positions.map((position) => ({
        entryNotionalSol: position.entryNotionalSol,
        quantityRaw: position.quantityRaw,
        quantityRemainingRaw: position.quantityRemainingRaw,
      })),
    );
    const tradesLastHour = this.store.getTradesLastHour();
    const killSwitchActive = killSwitchOverride ?? existsSync(this.config.KILL_SWITCH_FILE_PATH);
    const circuit = this.circuitBreaker.state();

    let cooldownActive = false;
    if (targetMint) {
      const lastTradeTs = this.store.getLastTradeTimestampForMint(targetMint);
      if (lastTradeTs) {
        const ageMinutes = (Date.now() - new Date(lastTradeTs).getTime()) / 60_000;
        cooldownActive = ageMinutes < this.config.TOKEN_COOLDOWN_MINUTES;
      }
    }

    return {
      killSwitchActive,
      atRiskSol,
      maxSolAtRisk: this.config.MAX_SOL_AT_RISK,
      tradesLastHour,
      maxTradesPerHour: this.config.MAX_TRADES_PER_HOUR,
      cooldownActive,
      circuitOpen: circuit.isOpen,
      circuitReopenAt: circuit.reopenAt ?? null,
      consecutiveFailures: circuit.consecutiveFailures,
    };
  }

  private async getSolPriceUsd(): Promise<number> {
    const now = Date.now();
    if (this.solPriceCacheUsd > 0 && now < this.solPriceCacheExpiresAt) {
      return this.solPriceCacheUsd;
    }

    try {
      const oneSolLamports = "1000000000";
      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const quote = await this.jupiter.getQuoteWithRetries({
        inputMint: WSOL_MINT,
        outputMint: usdcMint,
        amount: oneSolLamports,
        slippageBps: 30,
      });

      const usdcOut = toNumber(quote.outAmount) / 1_000_000;
      if (usdcOut > 0) {
        this.solPriceCacheUsd = usdcOut;
        this.solPriceCacheExpiresAt = now + this.config.SOL_PRICE_CACHE_SECONDS * 1000;
        return this.solPriceCacheUsd;
      }
    } catch (error) {
      this.logger.warn("SOL_PRICE_FALLBACK", "WARNING FAILED TO REFRESH SOL PRICE", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.solPriceCacheUsd <= 0) {
      this.solPriceCacheUsd = 120;
      this.solPriceCacheExpiresAt = now + 30_000;
    }
    return this.solPriceCacheUsd;
  }

  private async evaluateCandidate(candidate: PoolCandidate): Promise<EvaluatedCandidate> {
    const filters: HardFilterResult = {
      passed: false,
      reasons: [],
      warnings: [],
    };
    const now = Date.now();
    const ageMinutes = (now - new Date(candidate.createdAt).getTime()) / 60_000;
    let finalQuote: JupiterQuoteResponse | undefined;

    if (ageMinutes > this.config.FRESH_POOL_WINDOW_MINUTES) {
      filters.reasons.push("POOL_TOO_OLD");
    }

    if (candidate.liquiditySol < this.config.MIN_LIQUIDITY_SOL) {
      filters.reasons.push("LIQUIDITY_BELOW_MIN");
    }

    const effectiveMc = candidate.marketCapUsd > 0 ? candidate.marketCapUsd : candidate.fdvUsd;
    if (effectiveMc > 0 && effectiveMc < this.config.MIN_MC_USD) {
      filters.reasons.push("MC_TOO_LOW");
    }
    if (effectiveMc > 0 && effectiveMc > this.config.MAX_MC_USD) {
      filters.reasons.push("MC_TOO_HIGH");
    }
    if (effectiveMc === 0) {
      this.logger.warn("MC_UNAVAILABLE", "MC_UNAVAILABLE - PROCEEDING WITHOUT MC FILTER", {
        poolId: candidate.poolId,
        mint: candidate.tradeMint,
      });
    }

    if (candidate.volumeM5Usd < this.config.MIN_VOLUME_M5_USD) {
      filters.reasons.push("VOLUME_M5_TOO_LOW");
    }

    const m5Total = candidate.txBuysM5 + candidate.txSellsM5;
    const m5BuyRatio = m5Total >= 10 ? candidate.txBuysM5 / m5Total : 0.5;
    if (m5Total >= 10 && m5BuyRatio < 0.5) {
      filters.reasons.push("SELL_DOMINATED_M5");
    }

    const cheapFiltersPassed = filters.reasons.length === 0;
    const tradeAmountLamports = String(Math.floor(this.config.TRADE_SIZE_SOL * 1_000_000_000));
    const quotes: JupiterQuoteResponse[] = [];
    if (cheapFiltersPassed) {
      for (let i = 0; i < 3; i += 1) {
        try {
          const quote = await this.jupiter.getQuoteWithRetries({
            inputMint: WSOL_MINT,
            outputMint: candidate.tradeMint,
            amount: tradeAmountLamports,
            slippageBps: this.config.SLIPPAGE_BPS,
          });
          quotes.push(quote);
        } catch (error) {
          filters.reasons.push("NO_BUY_ROUTE");
          this.logger.warn("FILTER_NO_BUY_ROUTE", "WARNING CANDIDATE FAILED BUY ROUTE", {
            mint: candidate.tradeMint,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        if (i < 2) {
          await sleep(650);
        }
      }
    }

    if (quotes.length === 3) {
      const outAmounts = quotes.map((quote) => toNumber(quote.outAmount));
      const maxOut = Math.max(...outAmounts);
      const minOut = Math.min(...outAmounts);
      const avgOut = outAmounts.reduce((sum, value) => sum + value, 0) / outAmounts.length;
      const stabilityPct = avgOut > 0 ? ((maxOut - minOut) / avgOut) * 100 : 100;
      filters.quoteStabilityPct = stabilityPct;
      if (stabilityPct > this.config.QUOTE_STABILITY_PCT_CAP) {
        filters.reasons.push("QUOTE_INSTABILITY");
      }
      finalQuote = quotes[1] ?? quotes[0];
    }

    if (finalQuote) {
      let impactPct = toNumber(finalQuote.priceImpactPct);
      if (impactPct > 0 && impactPct < 0.0001) {
        impactPct = 0;
      }
      filters.priceImpactPct = impactPct;
      if (impactPct > this.config.PRICE_IMPACT_PCT_CAP) {
        filters.reasons.push("PRICE_IMPACT_TOO_HIGH");
      }

      try {
        await this.jupiter.getQuoteWithRetries(
          {
            inputMint: candidate.tradeMint,
            outputMint: WSOL_MINT,
            amount: finalQuote.outAmount,
            slippageBps: this.config.SLIPPAGE_BPS,
          },
          2,
          200,
        );
      } catch (error) {
        filters.reasons.push("NO_SELL_ROUTE");
        this.logger.warn("FILTER_NO_SELL_ROUTE", "WARNING CANDIDATE FAILED SELL ROUTE", {
          mint: candidate.tradeMint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (cheapFiltersPassed && this.config.HELIUS_API_KEY && this.config.MIN_HOLDER_COUNT > 0) {
      const holderCount = await getTokenHolderCount(this.config.HELIUS_API_KEY, candidate.tradeMint);
      if (holderCount === null) {
        this.logger.warn("HELIUS_TIMEOUT", "HELIUS_TIMEOUT - SKIPPING HOLDER CHECK", {
          poolId: candidate.poolId,
          mint: candidate.tradeMint,
        });
      } else if (holderCount < this.config.MIN_HOLDER_COUNT) {
        filters.reasons.push("HOLDER_COUNT_TOO_LOW");
      }
    }

    try {
      const authority = await getMintAuthorityStatus(this.connection, candidate.tradeMint);
      filters.authority = authority;
      if (authority.hasAnyAuthority) {
        if (this.config.AUTHORITY_POLICY === "strict") {
          filters.reasons.push("AUTHORITY_ENABLED_STRICT_REJECT");
        } else {
          filters.warnings.push("AUTHORITY_ENABLED_PERMISSIVE_WARNING");
        }
      }
      this.store.upsertToken({
        mint: candidate.tradeMint,
        symbol: candidate.tradeMint.slice(0, 6),
        name: `${candidate.tradeMint.slice(0, 4)}...${candidate.tradeMint.slice(-4)}`,
        authority: authority as unknown as Record<string, unknown>,
        raw: candidate.raw,
      });
    } catch (error) {
      filters.warnings.push("AUTHORITY_CHECK_FAILED");
      this.logger.warn("AUTH_CHECK_FAIL", "WARNING AUTHORITY CHECK FAILED", {
        mint: candidate.tradeMint,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    filters.warnings.push("HOLDER_CONCENTRATION_TODO");

    const score = this.computeScore(candidate, finalQuote, filters, ageMinutes);
    if (score.total < this.config.SCORE_THRESHOLD) {
      filters.reasons.push("SCORE_BELOW_THRESHOLD");
    }
    filters.passed = filters.reasons.length === 0;

    const decision: StrategyDecision = {
      candidate,
      score,
      filters,
      shouldTrade: filters.reasons.length === 0,
      reasonSummary: filters.reasons.length > 0 ? filters.reasons.join(",") : "PASS",
    };

    const decisionData = {
      mint: candidate.tradeMint,
      score: score.total,
      virality: score.viralityDetail,
      reasons: filters.reasons,
      warnings: filters.warnings,
    };
    if (filters.reasons.length === 0) {
      this.logger.info("DECISION", "SCANNER DECISION", decisionData);
    } else if (filters.reasons.includes("NO_BUY_ROUTE") || filters.reasons.includes("NO_SELL_ROUTE")) {
      this.logger.warn("DECISION", "SCANNER DECISION", decisionData);
    } else {
      this.logger.debug("DECISION", "SCANNER DECISION", decisionData);
    }

    return { decision, quote: finalQuote };
  }

  private computeScore(
    candidate: PoolCandidate,
    quote: JupiterQuoteResponse | undefined,
    filters: HardFilterResult,
    ageMinutes: number,
  ): ScoreResult {
    const freshness = clamp(
      25 - (ageMinutes / this.config.FRESH_POOL_WINDOW_MINUTES) * 25,
      0,
      25,
    );

    const m5Total = candidate.txBuysM5 + candidate.txSellsM5;
    const m15Total = candidate.txBuysM15 + candidate.txSellsM15;
    const m30Total = candidate.txBuysM30 + candidate.txSellsM30;
    const baselinePer5 = m30Total > 0
      ? m30Total / 6
      : (m15Total > 0 ? m15Total / 3 : 1);
    const accel = baselinePer5 > 0 ? m5Total / baselinePer5 : 0;
    const accelScore = clamp((accel - 1) * 4, 0, 12);

    const buyRatio = m5Total >= 5 ? candidate.txBuysM5 / m5Total : 0.5;
    const buyRatioScore = clamp(((buyRatio - 0.5) / 0.35) * 10, 0, 10);

    const h1BaselinePer5 = candidate.volumeH1Usd > 0 ? candidate.volumeH1Usd / 12 : 0;
    const volAccel = h1BaselinePer5 > 100
      ? candidate.volumeM5Usd / h1BaselinePer5
      : (candidate.volumeM5Usd > 1000 ? 2.0 : 0);
    const volAccelScore = clamp((volAccel - 1) * 5, 0, 10);

    const momentumScore = candidate.priceChangeM5Pct > 0
      ? clamp((candidate.priceChangeM5Pct / 15) * 8, 0, 8)
      : 0;

    const virality = clamp(accelScore + buyRatioScore + volAccelScore + momentumScore, 0, 40);

    let route = 0;
    if (quote) {
      const hops = quote.routePlan.length;
      const hopScore = hops <= 1 ? 13 : hops === 2 ? 9 : 5;
      const impact = toNumber(quote.priceImpactPct);
      const impactScore = clamp(12 - impact * 2, 0, 12);
      route = clamp(hopScore + impactScore, 0, 25);
    }

    let penalties = 0;
    if (filters.authority?.hasAnyAuthority) {
      penalties += this.config.AUTHORITY_POLICY === "strict" ? 30 : 12;
    }
    if (
      filters.quoteStabilityPct !== undefined
      && filters.quoteStabilityPct > this.config.QUOTE_STABILITY_PCT_CAP
    ) {
      penalties += 12;
    }
    if (m5Total >= 10 && buyRatio < 0.4) {
      penalties += 8;
    }

    const total = clamp(freshness + virality + route - penalties, 0, 100);
    return {
      total,
      freshness,
      flow: virality,
      route,
      penalties,
      viralityDetail: {
        accelScore,
        buyRatioScore,
        volAccelScore,
        momentumScore,
      },
    };
  }

  private async openPosition(
    candidate: PoolCandidate,
    quote: JupiterQuoteResponse,
    score: number,
  ): Promise<boolean> {
    const tradeSizeSol = computeTradeSize(score, this.config);
    const inAmountRaw = String(Math.floor(tradeSizeSol * 1_000_000_000));
    try {
      const execution = await this.executeSwap({
        inputMint: WSOL_MINT,
        outputMint: candidate.tradeMint,
        amountRaw: inAmountRaw,
        side: "BUY",
        fallbackQuote: quote,
      });

      const decimals = await getMintDecimals(this.connection, candidate.tradeMint);
      const tokenAmountUi = toNumber(execution.outAmountRaw) / 10 ** decimals;
      if (tokenAmountUi <= 0) {
        throw new Error("Bought token amount is zero");
      }
      const entryPriceSol = tradeSizeSol / tokenAmountUi;
      const positionId = this.store.openPosition({
        tokenMint: candidate.tradeMint,
        entryPriceSol,
        entryNotionalSol: tradeSizeSol,
        quantityRaw: execution.outAmountRaw,
        quantityRemainingRaw: execution.outAmountRaw,
        decimals,
        stopLossPct: this.config.SL_PCT,
        takeProfit1Pct: this.config.TP1_PCT,
        takeProfit2Pct: this.config.TP2_PCT,
        timeStopMinutes: this.config.TIME_STOP_MINUTES,
        metadata: {
          poolId: candidate.poolId,
          dexId: candidate.dexId,
          routeSummary: execution.routeSummary,
          openedBy: "AUTO_ENTRY",
          openedTs: new Date().toISOString(),
          entryScore: score,
          plannedTradeSizeSol: tradeSizeSol,
          realizedReturnedSol: 0,
          realizedPnlSol: 0,
          tp3Hit: false,
          highWaterPriceSol: entryPriceSol,
        },
      });

      this.store.recordTrade({
        side: "BUY",
        mode: this.config.MODE,
        inputMint: WSOL_MINT,
        outputMint: candidate.tradeMint,
        inAmount: inAmountRaw,
        outAmount: execution.outAmountRaw,
        expectedOut: execution.expectedOutRaw,
        status: execution.status === "PAPER" ? "PAPER_FILLED" : "CONFIRMED",
        ...(execution.signature ? { signature: execution.signature } : {}),
        quote: execution.quote,
        txMeta: {
          routeSummary: execution.routeSummary,
          simulationLogs: execution.simulationLogs?.slice(0, 12),
          confirmationMs: execution.confirmationMs ?? null,
          postBalances: execution.postBalances ?? null,
        },
      });

      if (this.config.MODE === "live") {
        try {
          await this.jupiter.getQuoteWithRetries({
            inputMint: candidate.tradeMint,
            outputMint: WSOL_MINT,
            amount: execution.outAmountRaw,
            slippageBps: this.config.SLIPPAGE_BPS,
          });
          this.logger.ok("SELL_ROUTE_OK", "CONFIRMED LIVE SELL ROUTE EXISTS", {
            mint: candidate.tradeMint,
            positionId,
          });
        } catch (error) {
          this.logger.warn("SELL_ROUTE_WARN", "WARNING LIVE SELL ROUTE CHECK FAILED", {
            mint: candidate.tradeMint,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.circuitBreaker.recordSuccess();
      this.logger.ok("ENTRY_OPENED", "CONFIRMED POSITION OPENED", {
        mint: candidate.tradeMint,
        positionId,
        qtyRaw: execution.outAmountRaw,
        tradeSizeSol,
        score,
        mode: this.config.MODE,
      });
      return true;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordTrade({
        side: "BUY",
        mode: this.config.MODE,
        inputMint: WSOL_MINT,
        outputMint: candidate.tradeMint,
        inAmount: inAmountRaw,
        expectedOut: quote.outAmount,
        status: "FAILED",
        error: message,
        quote: quote as unknown as Record<string, unknown>,
      });
      this.logger.error("ENTRY_FAIL", "ERROR FAILED TO OPEN POSITION", {
        mint: candidate.tradeMint,
        error: message,
      });
      return false;
    }
  }

  private determineExitAction(position: {
    tp1Hit: boolean;
    tp2Hit: boolean;
    tp3Hit: boolean;
    quantityRaw: string;
    quantityRemainingRaw: string;
    takeProfit1Pct: number;
    takeProfit2Pct: number;
    stopLossPct: number;
    timeStopMinutes: number;
  }, pnlPct: number, elapsedMinutes: number): ExitAction | null {
    const remaining = BigInt(position.quantityRemainingRaw);
    if (remaining <= 0n) {
      return null;
    }

    if (!position.tp1Hit && pnlPct >= position.takeProfit1Pct) {
      let sell = computeFractionRaw(position.quantityRaw, this.config.TP1_SELL_RATIO);
      if (sell <= 0n || sell > remaining) {
        sell = remaining;
      }
      return {
        reason: "TP1",
        sellAmountRaw: sell.toString(),
        markTp1: true,
        markTp2: false,
        markTp3: false,
      };
    }

    if (position.tp1Hit && !position.tp2Hit && pnlPct >= position.takeProfit2Pct) {
      let sell = computeFractionRaw(position.quantityRaw, this.config.TP1_SELL_RATIO);
      if (sell <= 0n || sell > remaining) {
        sell = remaining;
      }
      return {
        reason: "TP2",
        sellAmountRaw: sell.toString(),
        markTp1: true,
        markTp2: true,
        markTp3: false,
      };
    }

    if (position.tp2Hit && !position.tp3Hit && pnlPct >= this.config.TP3_PCT) {
      return {
        reason: "TP3",
        sellAmountRaw: remaining.toString(),
        markTp1: true,
        markTp2: true,
        markTp3: true,
      };
    }

    if (pnlPct <= -position.stopLossPct) {
      return {
        reason: "STOP_LOSS",
        sellAmountRaw: remaining.toString(),
        markTp1: position.tp1Hit,
        markTp2: position.tp2Hit,
        markTp3: position.tp3Hit,
      };
    }

    if (elapsedMinutes >= position.timeStopMinutes) {
      return {
        reason: "TIME_STOP",
        sellAmountRaw: remaining.toString(),
        markTp1: position.tp1Hit,
        markTp2: position.tp2Hit,
        markTp3: position.tp3Hit,
      };
    }

    return null;
  }

  private async monitorPositions(): Promise<void> {
    const positions = this.store.listActivePositions();
    if (positions.length === 0) {
      return;
    }

    for (const position of positions) {
      const remaining = BigInt(position.quantityRemainingRaw);
      if (remaining <= 0n) {
        this.store.closePosition(position.id, { closeReason: "ZERO_REMAINING" });
        continue;
      }

      try {
        const quote = await this.jupiter.getQuoteWithRetries({
          inputMint: position.tokenMint,
          outputMint: WSOL_MINT,
          amount: position.quantityRemainingRaw,
          slippageBps: this.config.SLIPPAGE_BPS,
        });

        const currentValueSol = toNumber(quote.outAmount) / 1_000_000_000;
        const ratio = toNumber(position.quantityRemainingRaw) / Math.max(1, toNumber(position.quantityRaw));
        const entryRemainingSol = position.entryNotionalSol * ratio;
        const pnlPct = entryRemainingSol > 0 ? ((currentValueSol - entryRemainingSol) / entryRemainingSol) * 100 : 0;
        const elapsedMinutes = (Date.now() - new Date(position.openedTs).getTime()) / 60_000;
        const quantityRemainingUi = toNumber(position.quantityRemainingRaw) / 10 ** position.decimals;
        const currentPriceSol = quantityRemainingUi > 0 ? currentValueSol / quantityRemainingUi : 0;
        const tp3Hit = Boolean(position.metadata["tp3Hit"] ?? false);

        let highWaterPriceSol = Number(position.metadata["highWaterPriceSol"] ?? position.entryPriceSol);
        let trailingStopArmed = false;
        let dropFromHwmPct = 0;
        if (position.tp1Hit && !position.tp2Hit) {
          highWaterPriceSol = Math.max(highWaterPriceSol, currentPriceSol);
          dropFromHwmPct = highWaterPriceSol > 0
            ? ((highWaterPriceSol - currentPriceSol) / highWaterPriceSol) * 100
            : 0;
          trailingStopArmed = this.config.TRAILING_STOP_PCT > 0 && dropFromHwmPct >= this.config.TRAILING_STOP_PCT;
        }

        const nextMetadata = {
          ...position.metadata,
          currentValueSol,
          currentPriceSol,
          pnlPct,
          elapsedMinutes,
          tp3Hit,
          highWaterPriceSol,
          dropFromHwmPct,
          lastQuoteTs: new Date().toISOString(),
        };
        this.store.updatePosition(position.id, { metadata: nextMetadata });

        let action: ExitAction | null = null;
        if (trailingStopArmed) {
          action = {
            reason: "TRAILING_STOP",
            sellAmountRaw: position.quantityRemainingRaw,
            markTp1: position.tp1Hit,
            markTp2: position.tp2Hit,
            markTp3: tp3Hit,
          };
        } else {
          action = this.determineExitAction({
            ...position,
            tp3Hit,
          }, pnlPct, elapsedMinutes);
        }
        if (!action) {
          continue;
        }

        this.logger.info("EXIT_SIGNAL", "EXIT SIGNAL TRIGGERED", {
          positionId: position.id,
          mint: position.tokenMint,
          reason: action.reason,
          pnlPct,
          sellAmountRaw: action.sellAmountRaw,
        });

        const execution = await this.executeSwap({
          inputMint: position.tokenMint,
          outputMint: WSOL_MINT,
          amountRaw: action.sellAmountRaw,
          side: "SELL",
        });
        this.store.recordTrade({
          side: "SELL",
          mode: this.config.MODE,
          inputMint: position.tokenMint,
          outputMint: WSOL_MINT,
          inAmount: action.sellAmountRaw,
          outAmount: execution.outAmountRaw,
          expectedOut: execution.expectedOutRaw,
          status: execution.status === "PAPER" ? "PAPER_EXIT" : "CONFIRMED",
          ...(execution.signature ? { signature: execution.signature } : {}),
          quote: execution.quote,
          txMeta: {
            reason: action.reason,
            routeSummary: execution.routeSummary,
            simulationLogs: execution.simulationLogs?.slice(0, 12),
            confirmationMs: execution.confirmationMs ?? null,
            postBalances: execution.postBalances ?? null,
          },
        });

        const sellRatio = toNumber(action.sellAmountRaw) / Math.max(1, toNumber(position.quantityRaw));
        const entryPortionSol = position.entryNotionalSol * sellRatio;
        const returnedSol = toNumber(execution.outAmountRaw) / 1_000_000_000;
        const realizedPnlSolDelta = returnedSol - entryPortionSol;
        const realizedReturnedSolPrev = Number(position.metadata["realizedReturnedSol"] ?? 0);
        const realizedPnlSolPrev = Number(position.metadata["realizedPnlSol"] ?? 0);

        const newRemaining = (BigInt(position.quantityRemainingRaw) - BigInt(action.sellAmountRaw)).toString();
        const nextTp3Hit = action.markTp3 || tp3Hit;
        const mergedMetadata = {
          ...nextMetadata,
          tp3Hit: nextTp3Hit,
          lastExitReason: action.reason,
          lastExitTs: new Date().toISOString(),
          realizedReturnedSol: realizedReturnedSolPrev + returnedSol,
          realizedPnlSol: realizedPnlSolPrev + realizedPnlSolDelta,
        };
        if (BigInt(newRemaining) <= 0n) {
          this.store.closePosition(position.id, mergedMetadata);
          this.logger.ok("POSITION_CLOSED", "CONFIRMED POSITION CLOSED", {
            positionId: position.id,
            reason: action.reason,
          });
        } else {
          this.store.updatePosition(position.id, {
            quantityRemainingRaw: newRemaining,
            tp1Hit: action.markTp1 || position.tp1Hit,
            tp2Hit: action.markTp2 || position.tp2Hit,
            metadata: mergedMetadata,
          });
          this.logger.ok("POSITION_REDUCED", "CONFIRMED POSITION REDUCED", {
            positionId: position.id,
            reason: action.reason,
            remainingRaw: newRemaining,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.circuitBreaker.recordFailure();
        this.store.recordTrade({
          side: "SELL",
          mode: this.config.MODE,
          inputMint: position.tokenMint,
          outputMint: WSOL_MINT,
          inAmount: position.quantityRemainingRaw,
          status: "FAILED",
          error: message,
        });
        this.logger.error("EXIT_FAIL", "ERROR FAILED TO EXECUTE EXIT", {
          positionId: position.id,
          mint: position.tokenMint,
          error: message,
        });
      }
    }
  }

  private async executeSwap(input: {
    inputMint: string;
    outputMint: string;
    amountRaw: string;
    side: "BUY" | "SELL";
    fallbackQuote?: JupiterQuoteResponse;
  }): Promise<SwapExecutionResult> {
    const quote = input.fallbackQuote
      ?? (await this.jupiter.getQuoteWithRetries({
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        amount: input.amountRaw,
        slippageBps: this.config.SLIPPAGE_BPS,
      }));
    const routeSummary = this.jupiter.parseRouteSummary(quote);
    this.logger.info("GET_QUOTE", "GET QUOTE", {
      side: input.side,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inAmountRaw: input.amountRaw,
      expectedOutRaw: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
      routeSummary,
    });

    if (this.config.MODE === "paper") {
      this.logger.ok("WOULD_TRADE", "PAPER MODE WOULD EXECUTE SWAP", {
        side: input.side,
        inAmountRaw: input.amountRaw,
        outAmountRaw: quote.outAmount,
      });
      return {
        status: "PAPER",
        inAmountRaw: input.amountRaw,
        outAmountRaw: quote.outAmount,
        expectedOutRaw: quote.outAmount,
        routeSummary,
        quote: quote as unknown as Record<string, unknown>,
      };
    }

    if (!this.wallet) {
      throw new Error("LIVE mode requires loaded wallet");
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const refreshedQuote = attempt === 1 && input.fallbackQuote
          ? input.fallbackQuote
          : await this.jupiter.getQuoteWithRetries({
              inputMint: input.inputMint,
              outputMint: input.outputMint,
              amount: input.amountRaw,
              slippageBps: this.config.SLIPPAGE_BPS,
            });
        const route = this.jupiter.parseRouteSummary(refreshedQuote);

        const swapResponse = await this.jupiter.getSwapTransaction({
          userPublicKey: this.wallet.publicKey.toBase58(),
          quoteResponse: refreshedQuote,
          priorityFeeLamports: this.config.PRIORITY_FEE_LAMPORTS,
        });

        const txBytes = Buffer.from(swapResponse.swapTransaction, "base64");
        const versionedTx = VersionedTransaction.deserialize(txBytes);
        const simulation = await simulateVersionedTransaction(this.connection, versionedTx);
        if (!simulation.ok) {
          throw new Error(`Simulation failed: ${simulation.error ?? "unknown error"}`);
        }

        const inputBefore = await getAssetBalance(this.connection, this.wallet.publicKey, input.inputMint);
        const outputBefore = await getAssetBalance(this.connection, this.wallet.publicKey, input.outputMint);

        versionedTx.sign([this.wallet]);
        const sendStarted = Date.now();
        const signature = await this.connection.sendRawTransaction(versionedTx.serialize(), {
          skipPreflight: true,
          maxRetries: 2,
        });

        this.logger.info("TX_SENT", "EXECUTE TX SENT", {
          side: input.side,
          signature,
          attempt,
        });

        const confirmed = await confirmSignature(
          this.connection,
          signature,
          versionedTx.message.recentBlockhash,
          swapResponse.lastValidBlockHeight,
        );
        if (!confirmed.ok) {
          throw new Error(`Confirmation failed: ${confirmed.error ?? "unknown error"}`);
        }

        const inputAfter = await getAssetBalance(this.connection, this.wallet.publicKey, input.inputMint);
        const outputAfter = await getAssetBalance(this.connection, this.wallet.publicKey, input.outputMint);

        const inputDelta = BigInt(inputBefore.amountRaw) - BigInt(inputAfter.amountRaw);
        const outputDelta = BigInt(outputAfter.amountRaw) - BigInt(outputBefore.amountRaw);

        if (inputDelta <= 0n || outputDelta <= 0n) {
          throw new Error("Balance delta verification failed");
        }

        const confirmationMs = Date.now() - sendStarted;
        this.logger.ok("CONFIRMED", "CONFIRMED SWAP EXECUTION", {
          side: input.side,
          signature,
          confirmationMs,
          outputDeltaRaw: outputDelta.toString(),
          inputDeltaRaw: inputDelta.toString(),
        });
        this.circuitBreaker.recordSuccess();

        return {
          status: "CONFIRMED",
          signature,
          inAmountRaw: input.amountRaw,
          outAmountRaw: outputDelta.toString(),
          expectedOutRaw: refreshedQuote.outAmount,
          routeSummary: route,
          simulationLogs: simulation.logs.slice(0, 20),
          confirmationMs,
          postBalances: {
            inputBefore: inputBefore.amountRaw,
            inputAfter: inputAfter.amountRaw,
            outputBefore: outputBefore.amountRaw,
            outputAfter: outputAfter.amountRaw,
          },
          quote: refreshedQuote as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(message);
        this.logger.warn("EXEC_RETRY", "WARNING EXECUTION ATTEMPT FAILED", {
          attempt,
          side: input.side,
          error: message,
        });

        if (attempt >= 3 || !this.isTransientError(message)) {
          break;
        }
        await sleep(400 * attempt);
      }
    }

    throw lastError ?? new Error("Execution failed with unknown error");
  }

  private isTransientError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("blockhash") ||
      lower.includes("429") ||
      lower.includes("rate limit") ||
      lower.includes("timeout") ||
      lower.includes("route") ||
      lower.includes("expired") ||
      lower.includes("too many requests")
    );
  }

  private isScannerRateLimited(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("(429)") || lower.includes("rate limit") || lower.includes("error_code\":429");
  }
}
