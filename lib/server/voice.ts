import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { kvGet, kvSet } from "./db";

const SAMPLE = path.join(process.cwd(), "public", "sunday_voice", "sunday.mp3");
const WAKE_DIR = path.join(process.cwd(), "public", "wake");

let cloning: Promise<string> | null = null;

/* ElevenLabs caps concurrent requests per plan (4 on lower tiers). Every TTS
 * call holds a slot until its audio has finished streaming. */
const MAX_VOICE_REQUESTS = Number(process.env.ELEVENLABS_CONCURRENCY ?? 3);
const slots = ((globalThis as unknown as { __sundayVoiceSlots?: { active: number; waiters: (() => void)[] } })
  .__sundayVoiceSlots ??= { active: 0, waiters: [] });

function releaseSlot() {
  slots.active--;
  slots.waiters.shift()?.();
}

export async function withVoiceSlot(signal: AbortSignal, run: () => Promise<Response>): Promise<Response> {
  if (slots.active >= MAX_VOICE_REQUESTS) {
    await new Promise<void>((resolve) => slots.waiters.push(resolve));
  }
  slots.active++;
  if (signal.aborted) {
    releaseSlot();
    return new Response(null, { status: 499 });
  }
  let res: Response;
  try {
    res = await run();
  } catch (err) {
    releaseSlot();
    throw err;
  }
  if (!res.ok || !res.body) {
    releaseSlot();
    return res;
  }
  // Hold the slot until the audio stream is fully delivered (or the listener hangs up).
  const reader = res.body.getReader();
  let released = false;
  const done = () => {
    if (!released) {
      released = true;
      releaseSlot();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: finished } = await reader.read();
        if (finished) {
          done();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}

/**
 * SUNDAY's ElevenLabs voice: ELEVENLABS_VOICE_ID if set, otherwise an instant
 * clone made once from public/sunday_voice/sunday.mp3 and remembered.
 */
export function elevenVoiceId(): Promise<string> {
  const fixed = process.env.ELEVENLABS_VOICE_ID ?? kvGet<string>("elevenlabs_voice_id");
  if (fixed) return Promise.resolve(fixed);
  cloning ??= cloneVoice().finally(() => {
    cloning = null;
  });
  return cloning;
}

async function cloneVoice(): Promise<string> {
  if (!existsSync(SAMPLE)) throw new Error("Voice sample public/sunday_voice/sunday.mp3 is missing.");
  const form = new FormData();
  form.append("name", "SUNDAY");
  form.append("description", "SUNDAY personal assistant voice");
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([readFileSync(SAMPLE)], { type: "audio/mpeg" }), "sunday.mp3");
  const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `ElevenLabs couldn't clone the voice (${res.status}). Instant voice cloning needs a paid plan — or set ELEVENLABS_VOICE_ID. ${(await res.text()).slice(0, 200)}`,
    );
  }
  const { voice_id } = (await res.json()) as { voice_id: string };
  kvSet("elevenlabs_voice_id", voice_id);
  return voice_id;
}

export function voiceStatus() {
  return {
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? kvGet<string>("elevenlabs_voice_id") ?? null,
    sample: existsSync(SAMPLE),
  };
}

/** Offline "Hey Sunday" detection needs the Vosk model archive in public/wake. */
export function wakeWordConfig() {
  let files: string[] = [];
  try {
    files = readdirSync(WAKE_DIR);
  } catch {}
  const model = files.find((f) => f.toLowerCase().endsWith(".tar.gz"));
  if (!model) return { ready: false as const, missing: ["public/wake/vosk-model-small-en-us-0.15.tar.gz"] };
  return { ready: true as const, modelPath: `/wake/${model}` };
}
