import { AutoTraderBot } from "./bot.js";

const bot = new AutoTraderBot();

process.on("SIGINT", () => {
  bot.stop();
});
process.on("SIGTERM", () => {
  bot.stop();
});

void bot.start();
