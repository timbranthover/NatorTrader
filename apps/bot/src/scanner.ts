import type { Logger, PoolCandidate } from "@autotrader/core";
import { WSOL_MINT } from "@autotrader/solana";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERzD8u6rK53iBLmks5n5G9N8mP8oJwWuj";
const USDH_MINT = "USDH1SM1s8B8m8AN4x9Q8A56hAew5s9wVnDXnq4fV6D";

const EXCLUDED_MINTS = new Set<string>([WSOL_MINT, USDC_MINT, USDT_MINT, USDH_MINT]);

function mintFromId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const idx = value.indexOf("_");
  return idx === -1 ? value : value.slice(idx + 1);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function fetchPoolCandidates(
  geckoBaseUrl: string,
  solPriceUsd: number,
  logger: Logger,
): Promise<PoolCandidate[]> {
  const url = `${geckoBaseUrl.replace(/\/+$/, "")}/networks/solana/new_pools?page=1`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GeckoTerminal new_pools failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{
      id?: string;
      attributes?: Record<string, unknown>;
      relationships?: Record<string, { data?: { id?: string; type?: string } }>;
    }>;
  };

  const candidates: PoolCandidate[] = [];
  const data = payload.data ?? [];

  for (const pool of data) {
    const attributes = pool.attributes ?? {};
    const relationships = pool.relationships ?? {};
    const baseMint = mintFromId(relationships.base_token?.data?.id);
    const quoteMint = mintFromId(relationships.quote_token?.data?.id);
    const dexId = String(relationships.dex?.data?.id ?? "unknown");
    const createdAt = String(attributes.pool_created_at ?? new Date().toISOString());
    const reserveUsd = toNumber(attributes.reserve_in_usd);
    const liquiditySol = solPriceUsd > 0 ? reserveUsd / solPriceUsd : 0;

    const tradeMint = EXCLUDED_MINTS.has(baseMint) ? quoteMint : baseMint;
    if (!tradeMint || EXCLUDED_MINTS.has(tradeMint)) {
      continue;
    }

    const transactions = (attributes.transactions as Record<string, unknown> | undefined) ?? {};
    const txM5 = (transactions.m5 as Record<string, unknown> | undefined) ?? {};
    const txM15 = (transactions.m15 as Record<string, unknown> | undefined) ?? {};
    const txM30 = (transactions.m30 as Record<string, unknown> | undefined) ?? {};
    const txH1 = (transactions.h1 as Record<string, unknown> | undefined) ?? {};
    const volume = (attributes.volume_usd as Record<string, unknown> | undefined) ?? {};
    const priceChange = (attributes.price_change_percentage as Record<string, unknown> | undefined) ?? {};

    candidates.push({
      poolId: String(pool.id ?? ""),
      dexId,
      baseMint,
      quoteMint,
      tradeMint,
      createdAt,
      reserveUsd,
      liquiditySol,
      txBuysM5: toNumber(txM5.buys),
      txSellsM5: toNumber(txM5.sells),
      txBuysM15: toNumber(txM15.buys),
      txSellsM15: toNumber(txM15.sells),
      txBuysM30: toNumber(txM30.buys),
      txSellsM30: toNumber(txM30.sells),
      txBuysH1: toNumber(txH1.buys),
      txSellsH1: toNumber(txH1.sells),
      volumeM5Usd: toNumber(volume.m5),
      volumeM15Usd: toNumber(volume.m15),
      volumeH1Usd: toNumber(volume.h1),
      priceChangeM5Pct: toNumber(priceChange.m5),
      priceChangeH1Pct: toNumber(priceChange.h1),
      marketCapUsd: toNumber(attributes.market_cap_usd),
      fdvUsd: toNumber(attributes.fdv_usd),
      raw: {
        id: pool.id,
        attributes,
        relationships,
      },
    });
  }

  candidates.sort((a, b) => {
    if (a.createdAt === b.createdAt) {
      return a.poolId.localeCompare(b.poolId);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });

  logger.debug("SCANNER_FETCH", "FETCHED NEW POOL CANDIDATES", {
    fetched: data.length,
    candidates: candidates.length,
  });
  if (candidates.length > 0) {
    const sample = candidates[0];
    if (!sample) {
      return candidates;
    }
    logger.debug("SCANNER_SAMPLE", "SCANNER ENRICHED SAMPLE", {
      poolId: sample.poolId,
      mint: sample.tradeMint,
      txBuysM30: sample.txBuysM30,
      priceChangeM5Pct: sample.priceChangeM5Pct,
      marketCapUsd: sample.marketCapUsd,
      fdvUsd: sample.fdvUsd,
    });
  }

  return candidates;
}
