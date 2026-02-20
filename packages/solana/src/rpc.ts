import fs from "node:fs";
import {
  Connection,
  Keypair,
  ParsedAccountData,
  PublicKey,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import type { MintAuthorityStatus } from "@autotrader/core";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface AssetBalance {
  amountRaw: string;
  decimals: number;
}

export function createRpcConnection(rpcUrl: string, commitment: Commitment = "confirmed"): Connection {
  return new Connection(rpcUrl, { commitment });
}

export function loadKeypairFromFile(path: string): Keypair {
  const payload = fs.readFileSync(path, "utf8");
  const raw = JSON.parse(payload) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export async function checkRpcHealth(connection: Connection): Promise<{ ok: boolean; slot?: number; error?: string }> {
  try {
    const blockhash = await connection.getLatestBlockhash("processed");
    return { ok: true, slot: blockhash.lastValidBlockHeight };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getSolBalance(connection: Connection, owner: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / 1_000_000_000;
}

export async function getAssetBalance(connection: Connection, owner: PublicKey, mint: string): Promise<AssetBalance> {
  if (mint === WSOL_MINT) {
    const lamports = await connection.getBalance(owner, "confirmed");
    return { amountRaw: String(lamports), decimals: 9 };
  }

  const mintPk = new PublicKey(mint);
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk }, "confirmed");
  let total = 0n;
  let decimals = 0;
  for (const item of accounts.value) {
    const parsed = item.account.data as ParsedAccountData;
    const tokenAmount = parsed.parsed.info.tokenAmount as {
      amount: string;
      decimals: number;
    };
    total += BigInt(tokenAmount.amount);
    decimals = tokenAmount.decimals;
  }
  return { amountRaw: total.toString(), decimals };
}

export async function getMintDecimals(connection: Connection, mint: string): Promise<number> {
  const mintPk = new PublicKey(mint);
  const parsed = await connection.getParsedAccountInfo(mintPk, "confirmed");
  if (!parsed.value || !("parsed" in parsed.value.data)) {
    throw new Error(`Mint account not parsed for ${mint}`);
  }
  const data = parsed.value.data as ParsedAccountData;
  const decimals = data.parsed.info.decimals;
  if (typeof decimals !== "number") {
    throw new Error(`Mint decimals missing for ${mint}`);
  }
  return decimals;
}

export async function getMintAuthorityStatus(connection: Connection, mint: string): Promise<MintAuthorityStatus> {
  const mintPk = new PublicKey(mint);
  const account = await connection.getParsedAccountInfo(mintPk, "confirmed");
  if (!account.value || !("parsed" in account.value.data)) {
    throw new Error(`Mint account not found/parsible: ${mint}`);
  }
  const parsed = account.value.data as ParsedAccountData;
  const info = parsed.parsed.info as {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    isInitialized: boolean;
  };

  const mintAuthority = info.mintAuthority ?? null;
  const freezeAuthority = info.freezeAuthority ?? null;

  return {
    mint,
    mintAuthority,
    freezeAuthority,
    isInitialized: Boolean(info.isInitialized),
    hasAnyAuthority: Boolean(mintAuthority || freezeAuthority),
  };
}

export async function simulateVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<{ ok: boolean; logs: string[]; error?: string }> {
  const result = await connection.simulateTransaction(transaction, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "processed",
  });

  const logs = result.value.logs ?? [];
  if (result.value.err) {
    return {
      ok: false,
      logs,
      error: JSON.stringify(result.value.err),
    };
  }
  return { ok: true, logs };
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<{ ok: boolean; error?: string }> {
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation.value.err) {
    return { ok: false, error: JSON.stringify(confirmation.value.err) };
  }
  return { ok: true };
}

export function atomicToUi(amountRaw: string, decimals: number): number {
  const base = 10 ** decimals;
  return Number(amountRaw) / base;
}

export function uiToAtomic(amountUi: number, decimals: number): string {
  const base = 10 ** decimals;
  return String(Math.floor(amountUi * base));
}

export async function getTokenHolderCount(
  heliusApiKey: string,
  mint: string,
): Promise<number | null> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  const body = {
    jsonrpc: "2.0",
    id: "holder-count",
    method: "getTokenAccounts",
    params: {
      mint,
      limit: 1000,
      options: { showZeroBalance: false },
    },
  };

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 600);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      result?: {
        total?: number;
        token_accounts?: unknown[];
      };
    };

    return data.result?.total ?? data.result?.token_accounts?.length ?? null;
  } catch {
    return null;
  }
}
