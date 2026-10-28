import "server-only";

/**
 * A stray failed promise in background work (indexer, Telegram, routines…) must not take SUNDAY
 * down — Node would exit the whole server. Log it instead (Electron saves the log). A real crash
 * is recorded, then the server exits so Electron restarts a clean one.
 */
export function installCrashGuard() {
  const g = globalThis as unknown as { __sundayCrashGuard?: boolean };
  if (g.__sundayCrashGuard) return;
  g.__sundayCrashGuard = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[sunday] unhandled rejection:", reason instanceof Error ? reason.stack : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[sunday] fatal error:", err.stack ?? err);
    process.exit(1);
  });
}
