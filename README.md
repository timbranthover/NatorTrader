# SOLANA // BRANTSWAP TERMINAL (v1)

Autonomous Solana autotrader with:
- `MODE=paper` default dry-run behavior
- optional `MODE=live` hot-wallet execution
- deterministic scanner/decision/execution loop
- SQLite persistence and structured logs
- retro CRT web control panel with live log stream

## Architecture

```
apps/
  bot/        scanner + scorer + risk + executor + strategy loop
  web/        terminal dashboard + API + SSE log stream
packages/
  core/       config validation, logger, risk controls, shared types
  solana/     RPC helpers, keypair load, mint authority checks, balances
  jupiter/    quote/swap HTTP client + route parsing
  store/      SQLite schema + repository
  ui-kit/     terminal CSS tokens/components/classes
```

## Safety Controls Implemented

- Dedicated-wallet-only live mode (`WALLET_KEYPAIR_PATH`)
- Hard caps:
  - `TRADE_SIZE_SOL`
  - `MAX_SOL_AT_RISK`
  - `MAX_TRADES_PER_HOUR`
- File kill switch: if `KILL_SWITCH_FILE_PATH` exists, new entries stop immediately
- Per-token cooldown (`TOKEN_COOLDOWN_MINUTES`)
- Circuit breaker after consecutive failures:
  - `FAILURE_CIRCUIT_BREAKER_N`
  - `CIRCUIT_BREAKER_COOLDOWN_MINUTES`
- Slippage cap (`SLIPPAGE_BPS`)
- Authority policy (`AUTHORITY_POLICY=strict|permissive`)
- Decision and trade logs persisted with reasons and tx metadata

## Operating Modes

- `MODE=paper`:
  - no signing/sending
  - logs `WOULD_TRADE`
  - opens/closes simulated positions using quote outputs
- `MODE=live`:
  - signs and sends via Jupiter swap tx
  - simulates tx pre-send
  - confirms tx and verifies post-balance deltas

## Setup

Prerequisites:
- Node.js 20+ (22 LTS recommended)
- `pnpm` (or `corepack pnpm`)

1. Install dependencies:
   - `pnpm install`
2. Approve native package builds (required for `better-sqlite3` on pnpm v10):
   - `pnpm approve-builds`
   - select `better-sqlite3` and approve
3. If no prebuilt binary exists for your Node version, build tools are required:
   - Windows: Visual Studio Build Tools with `Desktop development with C++`
4. Create env file:
   - `Copy-Item .env.example .env` (PowerShell)
5. Set `RPC_URL` to your provider URL.
6. Start paper mode bot + web:
   - `pnpm dev`
7. Open dashboard:
   - `http://localhost:8787`

Wallet generation helper (recommended):
- `pnpm wallet:new`
- output file defaults to `./keys/hot-wallet.json`

### Paper-mode demo command

`pnpm dev`

You should see:
- scanner polling every `BOT_POLL_SECONDS`
- decisions in `#log`
- status/risk/scanner modules updating live

## Live Mode Steps (use tiny funds only)

1. Create a dedicated hot wallet JSON keypair file:
   - `pnpm wallet:new`
2. Fund only a few dollars of SOL to that wallet.
3. Set:
   - `MODE=live`
   - `WALLET_KEYPAIR_PATH=...`
4. Start:
   - `pnpm live`
5. Keep kill switch path ready:
   - `New-Item -ItemType File $env:KILL_SWITCH_FILE_PATH`

## Scanner + Decision Logic

Discovery source:
- GeckoTerminal `new_pools` endpoint polled every `BOT_POLL_SECONDS`
- Scanner evaluates at most `MAX_CANDIDATES_PER_SCAN` pools each cycle (rate-limit guard)

Hard filters:
- min liquidity in SOL (`MIN_LIQUIDITY_SOL`)
- quote stability check (3 quotes in ~2s)
- price impact cap
- sell route existence check
- mint/freeze authority checks

Scoring:
- freshness
- swap-count/volume acceleration proxy
- route quality (hops + price impact)
- authority penalty (strict/permissive)

Trade only if:
- hard filters pass
- score >= `SCORE_THRESHOLD`
- risk gate allows entry

## Strategy

Entry:
- buy `TRADE_SIZE_SOL` (or simulated)

Exit monitoring:
- TP1: sell 50% at `TP1_PCT`
- TP2: sell remaining at `TP2_PCT`
- stop loss: full exit at `-SL_PCT`
- time stop: full exit at `TIME_STOP_MINUTES`

## UI Contract

Default route (`/`) is amber CRT terminal:
- title: `SOLANA // BRANTSWAP TERMINAL`
- required classes/IDs preserved:
  - `.nav`, `.block`, `.block-title`, `.stat-row`, `.stat-val`
  - `.btn-connect`, `.btn-swap`, `.blink`
  - `#log`
  - state classes `.ok .info .dim .hi .warn .err .green`

Legacy green variant:
- `/legacy`

Dropdown hover highlight:
- globally disabled in CSS.

## Database Tables

- `seen_pools`
- `tokens`
- `decisions`
- `trades`
- `positions`
- `config_snapshots`
- extra runtime support tables:
  - `logs`
  - `runtime_state`

Reset DB:
- `pnpm db:reset`

## API Endpoints

- `GET /api/status`
- `GET /api/config`
- `GET /api/positions`
- `GET /api/logs`
- `GET /events/logs` (SSE)
- `GET /legacy`

## Fast Launch Options

- Full app (paper): `pnpm dev`
- Full app (live): `pnpm live`
- Bot only (paper): `pnpm bot:paper`
- Bot only (live): `pnpm bot:live`
- Web only: `pnpm web`

## Explicit Assumptions (No Silent Guessing)

1. Discovery uses GeckoTerminal `new_pools` as a reliable v1 source for newly tradeable pools.
2. Jupiter API base URL is `https://lite-api.jup.ag/swap/v1`.
3. `priceImpactPct` from Jupiter is consumed as a numeric percent-like field; tune `PRICE_IMPACT_PCT_CAP` for your feed behavior.
4. Holder concentration is wired as a TODO warning (`HOLDER_CONCENTRATION_TODO`) and not enforced yet.
5. Paper mode simulates fills from quotes and does not submit/simulate real chain transactions.
6. Position PnL tracking in v1 is quote-driven and may differ from realized execution due to fees/latency.

## Limitations / TODO

- Holder concentration implementation
- MEV-aware routing / protection
- social signal ingestion
- richer token metadata hygiene
- websocket discovery path (current implementation uses polling)
- public Jupiter endpoint can rate-limit (`429`); tune poll/candidate limits or use higher-capacity endpoint

## Warnings

- This is experimental software.
- Never run live mode with your primary wallet.
- Keep SOL size tiny.
- Always keep kill switch available.
