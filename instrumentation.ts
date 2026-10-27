export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startIndexer } = await import("./lib/server/indexer");
  startIndexer();
  // Load the local brain into the GPU now, so the first "Hey Sunday" doesn't wait for it.
  const { warmLocal } = await import("./lib/server/brains");
  warmLocal();
  // Sir's phone: listen to his Telegram bot (no-op without TELEGRAM_BOT_TOKEN).
  const { startTelegram } = await import("./lib/server/telegram");
  startTelegram();
  // Scheduled routines ("every weekday at 8: my briefing").
  const { startRoutines } = await import("./lib/server/routines");
  startRoutines();
}
