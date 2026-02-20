import fs from "node:fs";
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

function serializeActivePositions(): Array<{
  id: number;
  tokenMint: string;
  openedTs: string;
  entryPriceSol: number;
  entryNotionalSol: number;
  quantityRaw: string;
  quantityRemainingRaw: string;
  tp1Hit: boolean;
  tp2Hit: boolean;
  stopLossPct: number;
  takeProfit1Pct: number;
  takeProfit2Pct: number;
  timeStopMinutes: number;
  metadata: Record<string, unknown>;
}> {
  return store.listActivePositions().map((position) => ({
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
}

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

app.get("/api/performance", (_req, res) => {
  const performance = store.getPerformanceSnapshot();
  res.json({ performance });
});

app.get("/api/activity", (req, res) => {
  const limitRaw = Number(req.query.limit ?? 80);
  const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(300, Math.floor(limitRaw))) : 80;
  const events = store.getRecentActivity(limit);
  res.json({ events });
});

app.get("/api/dashboard", (req, res) => {
  const limitRaw = Number(req.query.limit ?? 80);
  const limit = Number.isFinite(limitRaw) ? Math.max(20, Math.min(200, Math.floor(limitRaw))) : 80;
  res.json({
    positions: serializeActivePositions(),
    performance: store.getPerformanceSnapshot(),
    events: store.getRecentActivity(limit),
    updatedTs: new Date().toISOString(),
  });
});

app.get("/api/logs", (_req, res) => {
  const logs = store.getRecentLogs(250);
  res.json({ logs });
});

app.post("/api/kill-switch", (req, res) => {
  const requested = req.body?.active;
  if (typeof requested !== "boolean") {
    res.status(400).json({ ok: false, error: "active(boolean) is required" });
    return;
  }

  const killPath = config.KILL_SWITCH_FILE_PATH;
  if (requested) {
    fs.mkdirSync(path.dirname(killPath), { recursive: true });
    if (!fs.existsSync(killPath)) {
      fs.writeFileSync(killPath, `KILL SWITCH ENABLED ${new Date().toISOString()}\n`);
      logger.warn("KILL_SWITCH_ON", "WARNING KILL SWITCH ENABLED VIA UI", { path: killPath });
    }
  } else {
    if (fs.existsSync(killPath)) {
      fs.rmSync(killPath, { force: true });
      logger.ok("KILL_SWITCH_OFF", "CONFIRMED KILL SWITCH DISABLED VIA UI", { path: killPath });
    }
  }

  const riskState = store.getRuntimeState("risk_status");
  store.setRuntimeState("risk_status", {
    ...(riskState?.value ?? {}),
    killSwitchActive: requested,
    killSwitchFilePath: killPath,
    killSwitchUpdatedTs: new Date().toISOString(),
  });

  res.json({ ok: true, active: requested, path: killPath });
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
  res.json({ positions: serializeActivePositions() });
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

  let configuredWalletPubkey = "N/A";
  let configuredWalletMasked = "N/A";
  let configuredWalletBalance = 0;
  if (config.WALLET_KEYPAIR_PATH) {
    try {
      const wallet = loadKeypairFromFile(config.WALLET_KEYPAIR_PATH);
      configuredWalletPubkey = wallet.publicKey.toBase58();
      configuredWalletMasked = maskPubkey(configuredWalletPubkey);
      configuredWalletBalance = await getSolBalance(connection, wallet.publicKey);
    } catch (error) {
      logger.warn("WEB_WALLET_READ_FAIL", "FAILED TO READ CONFIGURED WALLET", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const systemFallback = {
    mode: config.MODE,
    rpcOk: rpcFallback?.ok ?? false,
    rpcSlot: rpcFallback?.slot ?? null,
    rpcError: rpcFallback?.error ?? null,
    walletPubkey: configuredWalletPubkey,
    walletMasked: configuredWalletMasked,
    walletBalanceSol: configuredWalletBalance,
  };

  res.json({
    mode: config.MODE,
    system: {
      ...systemFallback,
      ...(system?.value ?? {}),
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
    const serialized = JSON.stringify(payload);
    if (serialized === lastStatusPayload) {
      return;
    }
    lastStatusPayload = serialized;
    res.write(`event: status\n`);
    res.write(`data: ${serialized}\n\n`);
  };

  let lastStatusPayload = "";

  pushLogs();
  pushStatus();

  const timer = setInterval(() => {
    pushLogs();
    pushStatus();
  }, 2000);

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
