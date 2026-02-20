import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig, Logger, maskPubkey } from "@autotrader/core";
import { Store } from "@autotrader/store";
import { checkRpcHealth, createRpcConnection, getSolBalance, loadKeypairFromFile } from "@autotrader/solana";
import { uiKitCssPath } from "@autotrader/ui-kit";

const config = loadConfig();
const store = new Store(config.DB_PATH);
store.initialize();

const logger = new Logger({
  component: "WEB",
  level: config.LOG_LEVEL,
  sink: {
    write(entry) {
      store.insertLog(entry);
    },
  },
});

const connection = createRpcConnection(config.RPC_URL);
const app = express();
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, "../public");

app.use(express.json());

app.get("/assets/ui-kit.css", (_req, res) => {
  res.sendFile(uiKitCssPath);
});

app.use(express.static(publicDir));

app.get("/legacy", (_req, res) => {
  res.sendFile(path.join(publicDir, "legacy.html"));
});

app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/api/logs", (_req, res) => {
  const logs = store.getRecentLogs(250);
  res.json({ logs });
});

app.get("/api/config", (_req, res) => {
  res.json({
    mode: config.MODE,
    rpcUrl: config.RPC_URL,
    tradeSizeSol: config.TRADE_SIZE_SOL,
    maxSolAtRisk: config.MAX_SOL_AT_RISK,
    maxTradesPerHour: config.MAX_TRADES_PER_HOUR,
    minLiquiditySol: config.MIN_LIQUIDITY_SOL,
    slippageBps: config.SLIPPAGE_BPS,
    scoreThreshold: config.SCORE_THRESHOLD,
    killSwitchFilePath: config.KILL_SWITCH_FILE_PATH,
    pollSeconds: config.BOT_POLL_SECONDS,
    maxCandidatesPerScan: config.MAX_CANDIDATES_PER_SCAN,
    authorityPolicy: config.AUTHORITY_POLICY,
    priorityFeeLamports: config.PRIORITY_FEE_LAMPORTS,
  });
});

app.get("/api/positions", (_req, res) => {
  const positions = store.listActivePositions().map((position) => ({
    id: position.id,
    tokenMint: position.tokenMint,
    openedTs: position.openedTs,
    entryPriceSol: position.entryPriceSol,
    entryNotionalSol: position.entryNotionalSol,
    quantityRaw: position.quantityRaw,
    quantityRemainingRaw: position.quantityRemainingRaw,
    tp1Hit: position.tp1Hit,
    tp2Hit: position.tp2Hit,
    stopLossPct: position.stopLossPct,
    takeProfit1Pct: position.takeProfit1Pct,
    takeProfit2Pct: position.takeProfit2Pct,
    timeStopMinutes: position.timeStopMinutes,
    metadata: position.metadata,
  }));
  res.json({ positions });
});

app.get("/api/status", async (_req, res) => {
  const system = store.getRuntimeState("system_status");
  const scanner = store.getRuntimeState("scanner_status");
  const risk = store.getRuntimeState("risk_status");
  const stats = store.getScannerStats();

  let rpcFallback: { ok: boolean; slot?: number; error?: string } | null = null;
  if (!system) {
    rpcFallback = await checkRpcHealth(connection);
  }

  let liveWalletMasked = "N/A";
  let liveWalletBalance = 0;
  if (config.MODE === "live" && config.WALLET_KEYPAIR_PATH) {
    try {
      const wallet = loadKeypairFromFile(config.WALLET_KEYPAIR_PATH);
      liveWalletMasked = maskPubkey(wallet.publicKey.toBase58());
      liveWalletBalance = await getSolBalance(connection, wallet.publicKey);
    } catch (error) {
      logger.warn("WEB_WALLET_READ_FAIL", "FAILED TO READ LIVE WALLET", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  res.json({
    mode: config.MODE,
    system: system?.value ?? {
      mode: config.MODE,
      rpcOk: rpcFallback?.ok ?? false,
      rpcSlot: rpcFallback?.slot ?? null,
      rpcError: rpcFallback?.error ?? null,
      walletMasked: liveWalletMasked,
      walletBalanceSol: liveWalletBalance,
    },
    scanner: {
      ...(scanner?.value ?? {}),
      poolsSeenCount: stats.poolsSeenCount,
      candidatesCount: stats.candidatesCount,
    },
    risk: risk?.value ?? {
      killSwitchActive: false,
      atRiskSol: 0,
      tradesLastHour: 0,
      maxSolAtRisk: config.MAX_SOL_AT_RISK,
      maxTradesPerHour: config.MAX_TRADES_PER_HOUR,
    },
    updatedTs: new Date().toISOString(),
  });
});

app.get("/events/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastId = Number(req.query.lastId ?? 0);
  if (!Number.isFinite(lastId)) {
    lastId = 0;
  }

  const pushLogs = (): void => {
    const logs = store.getLogsAfter(lastId, 200);
    for (const log of logs) {
      lastId = log.id;
      res.write(`event: log\n`);
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }
  };

  const pushStatus = (): void => {
    const system = store.getRuntimeState("system_status");
    const scanner = store.getRuntimeState("scanner_status");
    const risk = store.getRuntimeState("risk_status");
    const payload = {
      system: system?.value ?? {},
      scanner: scanner?.value ?? {},
      risk: risk?.value ?? {},
    };
    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  pushLogs();
  pushStatus();

  const timer = setInterval(() => {
    pushLogs();
    pushStatus();
  }, 1000);

  req.on("close", () => {
    clearInterval(timer);
  });
});

app.listen(config.WEB_PORT, () => {
  logger.ok("WEB_BOOT", "WEB TERMINAL ONLINE", {
    url: `http://localhost:${config.WEB_PORT}`,
    dbPath: store.getDbPath(),
    mode: config.MODE,
  });
});
