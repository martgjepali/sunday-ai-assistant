export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Background errors get logged instead of taking SUNDAY down; real crashes restart cleanly.
  const { installCrashGuard } = await import("./lib/server/crash-guard");
  installCrashGuard();
  const { startIndexer } = await import("./lib/server/indexer");
  startIndexer();
  // Load the local brain into the GPU now, so the first "Hey Sunday" doesn't wait for it.
  const { warmLocal } = await import("./lib/server/brains");
  warmLocal();
  // Her free Kokoro voice takes a few seconds to load — do it now, not on her first sentence.
  const { kokoroAvailable, loadKokoro } = await import("./lib/server/kokoro");
  if (kokoroAvailable()) loadKokoro().catch((err) => console.error("[sunday] Kokoro voice failed to load:", err));
  // Sir's phone: listen to his Telegram bot (no-op without TELEGRAM_BOT_TOKEN).
  const { startTelegram } = await import("./lib/server/telegram");
  startTelegram();
  // Scheduled routines ("every weekday at 8: my briefing").
  const { startRoutines } = await import("./lib/server/routines");
  startRoutines();
}
