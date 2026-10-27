import "server-only";

/**
 * Is sir at the PC? SUNDAY's window reports how long the computer has been idle
 * each time it polls for reminders. No poll for a while means the app is closed.
 * When he's away, reminders and notices go to his phone instead of an empty room.
 */

const AWAY_IDLE_S = Number(process.env.SUNDAY_AWAY_MINUTES ?? 10) * 60;
const NO_POLL_MS = 60_000;

const g = globalThis as unknown as { __sundayPresence?: { at: number; idle: number } };

export function reportPresence(idleSeconds: number) {
  g.__sundayPresence = { at: Date.now(), idle: Number.isFinite(idleSeconds) ? idleSeconds : 0 };
}

export function sirAway() {
  const p = g.__sundayPresence;
  return !p || Date.now() - p.at > NO_POLL_MS || p.idle >= AWAY_IDLE_S;
}
