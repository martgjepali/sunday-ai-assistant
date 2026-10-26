import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Lets a tool ask SUNDAY's window for something only the desktop app can do
 * (e.g. a screenshot): the request travels down the chat's event stream, the
 * window answers via POST /api/bridge, and the waiting tool resumes.
 */

type Pending = { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> };
const g = globalThis as unknown as { __sundayBridge?: Map<string, Pending> };
const pending: Map<string, Pending> = (g.__sundayBridge ??= new Map<string, Pending>());

export type BridgeEmit = (event: { type: "request"; id: string; kind: string; payload?: unknown }) => void;

export function requestFromClient<T>(emit: BridgeEmit, kind: string, payload?: unknown, timeoutMs = 20_000): Promise<T> {
  const id = randomBytes(12).toString("hex");
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: "SUNDAY's window didn't respond in time." } as T);
    }, timeoutMs);
    pending.set(id, { resolve: (d: unknown) => resolve(d as T), timer });
    emit({ type: "request", id, kind, payload });
  });
}

export function fulfill(id: string, data: unknown): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(data);
  return true;
}
