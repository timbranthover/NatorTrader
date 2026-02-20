import fs from "node:fs";
import type { BotConfig } from "./types.js";

export interface RiskContext {
  atRiskSol: number;
  tradesLastHour: number;
  cooldownActive: boolean;
  killSwitchActive: boolean;
  circuitOpen: boolean;
}

export interface RiskDecision {
  allow: boolean;
  reasons: string[];
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMinutes: number;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  public constructor(threshold: number, cooldownMinutes: number) {
    this.threshold = threshold;
    this.cooldownMinutes = cooldownMinutes;
  }

  public recordFailure(now = Date.now()): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold && this.openedAt === null) {
      this.openedAt = now;
    }
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  public isOpen(now = Date.now()): boolean {
    if (this.openedAt === null) {
      return false;
    }
    const cooldownMs = this.cooldownMinutes * 60_000;
    if (now - this.openedAt >= cooldownMs) {
      this.openedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  public state(now = Date.now()): { isOpen: boolean; consecutiveFailures: number; reopenAt?: string } {
    const open = this.isOpen(now);
    if (!open || this.openedAt === null) {
      return { isOpen: false, consecutiveFailures: this.consecutiveFailures };
    }
    return {
      isOpen: true,
      consecutiveFailures: this.consecutiveFailures,
      reopenAt: new Date(this.openedAt + this.cooldownMinutes * 60_000).toISOString(),
    };
  }
}

export function isKillSwitchActive(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

export function canOpenNewPosition(config: BotConfig, context: RiskContext): RiskDecision {
  const reasons: string[] = [];

  if (context.killSwitchActive) {
    reasons.push("KILL_SWITCH_ACTIVE");
  }
  if (context.circuitOpen) {
    reasons.push("CIRCUIT_BREAKER_OPEN");
  }
  if (context.cooldownActive) {
    reasons.push("TOKEN_COOLDOWN_ACTIVE");
  }
  if (context.tradesLastHour >= config.MAX_TRADES_PER_HOUR) {
    reasons.push("MAX_TRADES_PER_HOUR_REACHED");
  }
  if (context.atRiskSol + config.TRADE_SIZE_SOL > config.MAX_SOL_AT_RISK) {
    reasons.push("MAX_SOL_AT_RISK_EXCEEDED");
  }

  return {
    allow: reasons.length === 0,
    reasons,
  };
}

export function computeAtRiskSol(positions: Array<{ entryNotionalSol: number; quantityRaw: string; quantityRemainingRaw: string }>): number {
  let total = 0;
  for (const position of positions) {
    const initial = Number(position.quantityRaw);
    const remaining = Number(position.quantityRemainingRaw);
    if (!Number.isFinite(initial) || !Number.isFinite(remaining) || initial <= 0) {
      continue;
    }
    total += position.entryNotionalSol * (remaining / initial);
  }
  return total;
}
