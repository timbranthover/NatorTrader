import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ActivePosition, BotConfig, LogEntry, Mode } from "@autotrader/core";

interface JsonPayload {
  [key: string]: unknown;
}

export interface SeenPoolInsert {
  poolId: string;
  baseMint: string;
  quoteMint: string;
  dexId: string;
  createdAt: string;
  liquiditySol: number;
  reserveUsd: number;
  raw: JsonPayload;
}

export interface TokenUpsert {
  mint: string;
  symbol: string;
  name: string;
  authority?: JsonPayload;
  raw?: JsonPayload;
}

export interface DecisionInsert {
  poolId: string;
  mint: string;
  score: number;
  passed: boolean;
  mode: Mode;
  reasons: string[];
  filters: JsonPayload;
  raw: JsonPayload;
}

export interface TradeInsert {
  side: "BUY" | "SELL";
  mode: Mode;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount?: string;
  expectedOut?: string;
  status: string;
  signature?: string;
  error?: string;
  quote?: JsonPayload;
  txMeta?: JsonPayload;
}

export interface PositionInsert {
  tokenMint: string;
  entryPriceSol: number;
  entryNotionalSol: number;
  quantityRaw: string;
  quantityRemainingRaw: string;
  decimals: number;
  stopLossPct: number;
  takeProfit1Pct: number;
  takeProfit2Pct: number;
  timeStopMinutes: number;
  metadata?: JsonPayload;
}

function parseJson(text: string | null): JsonPayload {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as JsonPayload;
  } catch {
    return {};
  }
}

export class Store {
  private readonly dbPath: string;
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    this.dbPath = dbPath;
    const directory = path.dirname(dbPath);
    fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
  }

  public initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_pools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id TEXT NOT NULL UNIQUE,
        base_mint TEXT NOT NULL,
        quote_mint TEXT NOT NULL,
        dex_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        liquidity_sol REAL NOT NULL,
        reserve_usd REAL NOT NULL,
        first_seen_ts TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL UNIQUE,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        last_seen_ts TEXT NOT NULL,
        authority_json TEXT,
        raw_json TEXT
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        pool_id TEXT,
        mint TEXT NOT NULL,
        score REAL NOT NULL,
        passed INTEGER NOT NULL,
        mode TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        side TEXT NOT NULL,
        mode TEXT NOT NULL,
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        in_amount TEXT NOT NULL,
        out_amount TEXT,
        expected_out TEXT,
        status TEXT NOT NULL,
        signature TEXT,
        error TEXT,
        quote_json TEXT,
        tx_meta_json TEXT
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_mint TEXT NOT NULL,
        opened_ts TEXT NOT NULL,
        closed_ts TEXT,
        status TEXT NOT NULL,
        entry_price_sol REAL NOT NULL,
        entry_notional_sol REAL NOT NULL,
        quantity_raw TEXT NOT NULL,
        quantity_remaining_raw TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        tp1_hit INTEGER NOT NULL DEFAULT 0,
        tp2_hit INTEGER NOT NULL DEFAULT 0,
        stop_loss_pct REAL NOT NULL,
        take_profit1_pct REAL NOT NULL,
        take_profit2_pct REAL NOT NULL,
        time_stop_minutes INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        mode TEXT NOT NULL,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_ts TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_seen_pools_created_at ON seen_pools(created_at);
      CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_output_mint ON trades(output_mint);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
    `);
  }

  public snapshotConfig(config: BotConfig): void {
    this.db
      .prepare(
        `INSERT INTO config_snapshots (ts, mode, config_json)
         VALUES (?, ?, ?)`,
      )
      .run(new Date().toISOString(), config.MODE, JSON.stringify(config));
  }

  public insertLog(entry: LogEntry): number {
    const result = this.db
      .prepare(
        `INSERT INTO logs (ts, level, component, code, message, data_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.ts, entry.level, entry.component, entry.code, entry.message, entry.data ? JSON.stringify(entry.data) : null);
    return Number(result.lastInsertRowid);
  }

  public getLogsAfter(afterId: number, limit = 200): Array<{
    id: number;
    ts: string;
    level: string;
    component: string;
    code: string;
    message: string;
    data: JsonPayload;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, component, code, message, data_json
         FROM logs
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(afterId, limit) as Array<{
      id: number;
      ts: string;
      level: string;
      component: string;
      code: string;
      message: string;
      data_json: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      level: row.level,
      component: row.component,
      code: row.code,
      message: row.message,
      data: parseJson(row.data_json),
    }));
  }

  public getRecentLogs(limit = 200): Array<{
    id: number;
    ts: string;
    level: string;
    component: string;
    code: string;
    message: string;
    data: JsonPayload;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, component, code, message, data_json
         FROM logs
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      ts: string;
      level: string;
      component: string;
      code: string;
      message: string;
      data_json: string | null;
    }>;

    return rows
      .reverse()
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        level: row.level,
        component: row.component,
        code: row.code,
        message: row.message,
        data: parseJson(row.data_json),
      }));
  }

  public setRuntimeState(key: string, value: JsonPayload): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runtime_state (key, value_json, updated_ts)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_ts=excluded.updated_ts`,
      )
      .run(key, JSON.stringify(value), now);
  }

  public getRuntimeState(key: string): { key: string; value: JsonPayload; updatedTs: string } | null {
    const row = this.db
      .prepare(
        `SELECT key, value_json, updated_ts
         FROM runtime_state
         WHERE key = ?`,
      )
      .get(key) as { key: string; value_json: string; updated_ts: string } | undefined;
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      value: parseJson(row.value_json),
      updatedTs: row.updated_ts,
    };
  }

  public hasSeenPool(poolId: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS ok FROM seen_pools WHERE pool_id = ?`).get(poolId) as { ok: number } | undefined;
    return Boolean(row);
  }

  public upsertSeenPool(input: SeenPoolInsert): void {
    this.db
      .prepare(
        `INSERT INTO seen_pools (
          pool_id, base_mint, quote_mint, dex_id, created_at, liquidity_sol, reserve_usd, first_seen_ts, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pool_id) DO UPDATE SET
          liquidity_sol=excluded.liquidity_sol,
          reserve_usd=excluded.reserve_usd,
          raw_json=excluded.raw_json`,
      )
      .run(
        input.poolId,
        input.baseMint,
        input.quoteMint,
        input.dexId,
        input.createdAt,
        input.liquiditySol,
        input.reserveUsd,
        new Date().toISOString(),
        JSON.stringify(input.raw),
      );
  }

  public upsertToken(input: TokenUpsert): void {
    this.db
      .prepare(
        `INSERT INTO tokens (mint, symbol, name, last_seen_ts, authority_json, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET
           symbol=excluded.symbol,
           name=excluded.name,
           last_seen_ts=excluded.last_seen_ts,
           authority_json=excluded.authority_json,
           raw_json=excluded.raw_json`,
      )
      .run(
        input.mint,
        input.symbol,
        input.name,
        new Date().toISOString(),
        input.authority ? JSON.stringify(input.authority) : null,
        input.raw ? JSON.stringify(input.raw) : null,
      );
  }

  public recordDecision(input: DecisionInsert): void {
    this.db
      .prepare(
        `INSERT INTO decisions (ts, pool_id, mint, score, passed, mode, reasons_json, filters_json, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.poolId,
        input.mint,
        input.score,
        input.passed ? 1 : 0,
        input.mode,
        JSON.stringify(input.reasons),
        JSON.stringify(input.filters),
        JSON.stringify(input.raw),
      );
  }

  public recordTrade(input: TradeInsert): void {
    this.db
      .prepare(
        `INSERT INTO trades (
          ts, side, mode, input_mint, output_mint, in_amount, out_amount, expected_out, status, signature, error, quote_json, tx_meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.side,
        input.mode,
        input.inputMint,
        input.outputMint,
        input.inAmount,
        input.outAmount ?? null,
        input.expectedOut ?? null,
        input.status,
        input.signature ?? null,
        input.error ?? null,
        input.quote ? JSON.stringify(input.quote) : null,
        input.txMeta ? JSON.stringify(input.txMeta) : null,
      );
  }

  public openPosition(input: PositionInsert): number {
    const result = this.db
      .prepare(
        `INSERT INTO positions (
          token_mint, opened_ts, status, entry_price_sol, entry_notional_sol, quantity_raw, quantity_remaining_raw, decimals,
          stop_loss_pct, take_profit1_pct, take_profit2_pct, time_stop_minutes, metadata_json
        ) VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenMint,
        new Date().toISOString(),
        input.entryPriceSol,
        input.entryNotionalSol,
        input.quantityRaw,
        input.quantityRemainingRaw,
        input.decimals,
        input.stopLossPct,
        input.takeProfit1Pct,
        input.takeProfit2Pct,
        input.timeStopMinutes,
        JSON.stringify(input.metadata ?? {}),
      );
    return Number(result.lastInsertRowid);
  }

  public listActivePositions(): ActivePosition[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM positions
         WHERE status = 'OPEN'
         ORDER BY opened_ts ASC`,
      )
      .all() as Array<{
      id: number;
      token_mint: string;
      opened_ts: string;
      status: string;
      entry_price_sol: number;
      entry_notional_sol: number;
      quantity_raw: string;
      quantity_remaining_raw: string;
      decimals: number;
      tp1_hit: number;
      tp2_hit: number;
      stop_loss_pct: number;
      take_profit1_pct: number;
      take_profit2_pct: number;
      time_stop_minutes: number;
      metadata_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      tokenMint: row.token_mint,
      openedTs: row.opened_ts,
      status: row.status,
      entryPriceSol: row.entry_price_sol,
      entryNotionalSol: row.entry_notional_sol,
      quantityRaw: row.quantity_raw,
      quantityRemainingRaw: row.quantity_remaining_raw,
      decimals: row.decimals,
      tp1Hit: row.tp1_hit === 1,
      tp2Hit: row.tp2_hit === 1,
      stopLossPct: row.stop_loss_pct,
      takeProfit1Pct: row.take_profit1_pct,
      takeProfit2Pct: row.take_profit2_pct,
      timeStopMinutes: row.time_stop_minutes,
      metadata: parseJson(row.metadata_json),
    }));
  }

  public updatePosition(
    id: number,
    updates: {
      quantityRemainingRaw?: string;
      tp1Hit?: boolean;
      tp2Hit?: boolean;
      metadata?: JsonPayload;
    },
  ): void {
    const row = this.db.prepare(`SELECT metadata_json, tp1_hit, tp2_hit, quantity_remaining_raw FROM positions WHERE id = ?`).get(id) as
      | { metadata_json: string; tp1_hit: number; tp2_hit: number; quantity_remaining_raw: string }
      | undefined;
    if (!row) {
      return;
    }

    const metadata = updates.metadata ?? parseJson(row.metadata_json);
    const quantity = updates.quantityRemainingRaw ?? row.quantity_remaining_raw;
    const tp1 = updates.tp1Hit ?? row.tp1_hit === 1;
    const tp2 = updates.tp2Hit ?? row.tp2_hit === 1;

    this.db
      .prepare(
        `UPDATE positions
         SET quantity_remaining_raw = ?, tp1_hit = ?, tp2_hit = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(quantity, tp1 ? 1 : 0, tp2 ? 1 : 0, JSON.stringify(metadata), id);
  }

  public closePosition(id: number, metadata?: JsonPayload): void {
    const row = this.db.prepare(`SELECT metadata_json FROM positions WHERE id = ?`).get(id) as { metadata_json: string } | undefined;
    const mergedMetadata = {
      ...parseJson(row?.metadata_json ?? null),
      ...(metadata ?? {}),
    };
    this.db
      .prepare(
        `UPDATE positions
         SET status = 'CLOSED', closed_ts = ?, quantity_remaining_raw = '0', metadata_json = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), JSON.stringify(mergedMetadata), id);
  }

  public getTradesLastHour(): number {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM trades
         WHERE ts >= ? AND status IN ('CONFIRMED', 'PAPER_FILLED', 'PAPER_EXIT')`,
      )
      .get(since) as { count: number };
    return row.count;
  }

  public getLastTradeTimestampForMint(mint: string): string | null {
    const row = this.db
      .prepare(
        `SELECT ts
         FROM trades
         WHERE (output_mint = ? OR input_mint = ?)
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get(mint, mint) as { ts: string } | undefined;
    return row?.ts ?? null;
  }

  public getScannerStats(): { poolsSeenCount: number; candidatesCount: number } {
    const pools = this.db.prepare(`SELECT COUNT(*) AS count FROM seen_pools`).get() as { count: number };
    const candidates = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM decisions
         WHERE ts >= ?`,
      )
      .get(new Date(Date.now() - 60 * 60 * 1000).toISOString()) as { count: number };

    return { poolsSeenCount: pools.count, candidatesCount: candidates.count };
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public close(): void {
    this.db.close();
  }
}
