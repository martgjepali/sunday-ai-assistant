import type { AgentEvent } from "@/lib/server/agent";

export type { AgentEvent };

export function api(path: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    headers: { "x-sunday-client": "1", "Content-Type": "application/json", ...init.headers },
  });
}

export async function getJSON<T>(path: string): Promise<T> {
  const res = await api(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** The server refused because Voice ID didn't recognise sir. */
export class NotOwnerError extends Error {
  constructor() {
    super("not-owner");
  }
}

export type VoiceCheck = {
  enrolled: boolean;
  owner: boolean;
  token: string | null;
  similarity: number | null;
  problem?: "too-short" | "too-quiet";
};

/** Send one utterance (16 kHz mono 16-bit PCM) to be matched against sir's voiceprint. */
export async function verifyVoice(pcm: Int16Array): Promise<VoiceCheck | null> {
  try {
    const res = await fetch("/api/voiceprint?action=verify", {
      method: "POST",
      headers: { "x-sunday-client": "1", "Content-Type": "application/octet-stream" },
      body: pcm.slice().buffer,
    });
    return res.ok ? ((await res.json()) as VoiceCheck) : null;
  } catch {
    return null;
  }
}

/** The server sends a heartbeat every 15s while it works; this much silence means it's gone. */
const SILENCE_MS = 45_000;

export async function* streamChat(
  body: { conversationId: string | null; text: string; mode: "voice" | "text"; voiceToken?: string | null },
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const watchdog = new AbortController();
  let silent = false;
  const expire = () => {
    silent = true;
    watchdog.abort();
  };
  let timer = setTimeout(expire, SILENCE_MS);
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, SILENCE_MS);
  };
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify(body), signal: AbortSignal.any([signal, watchdog.signal]) });
    if (res.status === 403) throw new NotOwnerError();
    if (!res.ok || !res.body) throw new Error(`SUNDAY's core answered ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      heard();
      buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as AgentEvent;
        if (ev.type !== "ping") yield ev;
      }
    }
  } catch (err) {
    if (silent && !signal.aborted) {
      throw new Error("SUNDAY's core stopped answering — it may be restarting. Give it a few seconds and ask again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type BrainMode = "auto" | "local" | "fast" | "deep";

export type SystemStatus = {
  model: string;
  effort: string;
  brain: boolean;
  brains: { mode: BrainMode; local: { model: string; ready: boolean; reason?: string }; fast: string };
  drives: string[];
  index: Record<string, { state: string; count: number; finishedAt?: number }>;
  voice: { engine: "kokoro" | "elevenlabs" | "browser"; kokoroVoice: string | null; elevenlabs: boolean; voiceId: string | null; sample: boolean };
  stt: "deepgram" | "none";
  wake: { ready: true; modelPath: string } | { ready: false; missing: string[] };
  typesafe: boolean;
  gmail: { configured: boolean; account: string | null; calendar: boolean };
  telegram: { configured: boolean; bot: string | null; paired: string | null; error: string | null };
};

export type BrainData = {
  nodes: { id: string; label: string; group: string; val: number; detail?: string }[];
  links: { source: string; target: string; kind?: "core" | "assoc" }[];
};
