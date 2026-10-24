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

export async function* streamChat(
  body: { conversationId: string | null; text: string; mode: "voice" | "text"; voiceToken?: string | null },
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const res = await api("/api/chat", { method: "POST", body: JSON.stringify(body), signal });
  if (res.status === 403) throw new NotOwnerError();
  if (!res.ok || !res.body) throw new Error(`SUNDAY's core answered ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as AgentEvent;
    }
  }
}

export type SystemStatus = {
  model: string;
  effort: string;
  brain: boolean;
  drives: string[];
  index: Record<string, { state: string; count: number; finishedAt?: number }>;
  voice: { elevenlabs: boolean; voiceId: string | null; sample: boolean };
  stt: "deepgram" | "none";
  wake: { ready: true; modelPath: string } | { ready: false; missing: string[] };
  typesafe: boolean;
  gmail: { configured: boolean; account: string | null };
};

export type BrainData = {
  nodes: { id: string; label: string; group: string; val: number; detail?: string }[];
  links: { source: string; target: string; kind?: "core" | "assoc" }[];
};
