const lines = [
  "===== NATORTRADER QUICK START =====",
  "",
  "PAPER MODE (BOT + WEB):",
  "  corepack pnpm dev",
  "",
  "LIVE MODE (BOT + WEB):",
  "  corepack pnpm live",
  "",
  "WEB ONLY:",
  "  corepack pnpm web",
  "",
  "BOT ONLY (PAPER):",
  "  corepack pnpm bot:paper",
  "",
  "DB RESET:",
  "  corepack pnpm db:reset",
  "",
  "PERFORMANCE SNAPSHOT:",
  "  corepack pnpm perf",
  "",
  "REMINDER:",
  "  - Main panel URL is usually http://localhost:8787",
  "  - In VS Code you can run task: 'NatorTrader: Dev (Paper Full App)'",
];

for (const line of lines) {
  // eslint-disable-next-line no-console
  console.log(line);
}
