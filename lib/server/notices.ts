import "server-only";

/**
 * Things SUNDAY should say on her own when background work finishes (a document
 * is ready, a computer task ended). The UI collects them with the reminders poll.
 * Kept in memory: work in flight doesn't survive a restart anyway.
 */
export type Notice = { title: string; text: string; at: number };

const g = globalThis as unknown as { __sundayNotices?: Notice[] };
const queue = (g.__sundayNotices ??= []);

export function pushNotice(title: string, text: string) {
  queue.push({ title, text, at: Date.now() });
  if (queue.length > 50) queue.splice(0, queue.length - 50);
}

/** Hands out every pending notice exactly once. */
export function claimNotices(): Notice[] {
  return queue.splice(0, queue.length);
}
