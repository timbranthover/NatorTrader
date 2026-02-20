import type { Logger } from "@autotrader/core";

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    percent: number;
    bps: number | null;
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      outAmountAfterSlippage: string;
    };
  }>;
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapRequest {
  userPublicKey: string;
  quoteResponse: JupiterQuoteResponse;
  priorityFeeLamports: number;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  simulationError?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JupiterClient {
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;

  public constructor(baseUrl: string, logger?: Logger) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.logger = logger;
  }

  public async getQuote(request: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    const url = new URL(`${this.baseUrl}/quote`);
    url.searchParams.set("inputMint", request.inputMint);
    url.searchParams.set("outputMint", request.outputMint);
    url.searchParams.set("amount", request.amount);
    url.searchParams.set("slippageBps", String(request.slippageBps));
    url.searchParams.set("swapMode", "ExactIn");

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter quote failed (${response.status}): ${body}`);
    }
    return (await response.json()) as JupiterQuoteResponse;
  }

  public async getQuoteWithRetries(
    request: JupiterQuoteRequest,
    maxAttempts = 3,
    baseBackoffMs = 300,
  ): Promise<JupiterQuoteResponse> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.getQuote(request);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger?.warn("QUOTE_RETRY", "QUOTE ATTEMPT FAILED", {
          attempt,
          maxAttempts,
          error: lastError.message,
        });
        if (attempt < maxAttempts) {
          await sleep(baseBackoffMs * attempt);
        }
      }
    }
    throw lastError ?? new Error("Jupiter quote failed after retries");
  }

  public async getSwapTransaction(request: JupiterSwapRequest): Promise<JupiterSwapResponse> {
    const body: Record<string, unknown> = {
      userPublicKey: request.userPublicKey,
      quoteResponse: request.quoteResponse,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    };
    if (request.priorityFeeLamports > 0) {
      body.prioritizationFeeLamports = request.priorityFeeLamports;
    }

    const response = await fetch(`${this.baseUrl}/swap`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`Jupiter swap build failed (${response.status}): ${responseBody}`);
    }

    return (await response.json()) as JupiterSwapResponse;
  }

  public parseRouteSummary(quote: JupiterQuoteResponse): string[] {
    const labels = quote.routePlan.map((part) => part.swapInfo.label).filter(Boolean);
    const unique: string[] = [];
    for (const label of labels) {
      if (!unique.includes(label)) {
        unique.push(label);
      }
    }
    return unique;
  }
}
