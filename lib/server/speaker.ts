import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { SpeakerEmbeddingExtractor } from "sherpa-onnx-node";
import { db, kvGet, kvSet, logActivity } from "./db";

/**
 * Voice ID: SUNDAY recognises sir by voice, fully offline. Each utterance is
 * turned into a 256-number voiceprint by the WeSpeaker ResNet34 model and
 * compared with the voiceprint captured at enrollment. The enrolled voiceprint
 * never leaves this server process.
 */

const MODEL = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "models",
  "speaker",
  "wespeaker_en_voxceleb_resnet34.onnx",
);
export const SAMPLE_RATE = 16_000;
/** Cosine similarity at or above which a voice counts as sir's. */
const THRESHOLD = Number(process.env.SUNDAY_VOICE_THRESHOLD ?? 0.6);
/** Voice tokens let one verified utterance through /api/chat. */
const TOKEN_TTL_MS = 2 * 60 * 1000;
/** Typed messages are allowed this long after sir's voice was last recognised. */
const TEXT_GRACE_MS = 10 * 60 * 1000;

/** embeddings: the enrollment recordings. learned: recent confident matches the voiceprint adapts to. */
type OwnerVoice = { embeddings: number[][]; centroid: number[]; enrolledAt: number; learned?: number[][] };

const g = globalThis as unknown as {
  __sundaySpeaker?: {
    extractor: SpeakerEmbeddingExtractor | null;
    pending: number[][];
    tokens: Map<string, { exp: number; similarity: number }>;
    ownerHeardAt: number;
  };
};
g.__sundaySpeaker ??= { extractor: null, pending: [], tokens: new Map(), ownerHeardAt: 0 };
const state = g.__sundaySpeaker;

export const voiceIdDisabled = () => process.env.SUNDAY_VOICE_ID === "off";
export const modelAvailable = () => existsSync(MODEL);

function extractor() {
  if (!state.extractor) {
    if (!modelAvailable()) throw new Error("Speaker model missing (models/speaker/wespeaker_en_voxceleb_resnet34.onnx).");
    state.extractor = new SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 2, debug: false, provider: "cpu" });
  }
  return state.extractor;
}

/** 16-bit little-endian mono PCM at 16 kHz → Float32 samples. */
export function pcmToFloat(buf: ArrayBuffer): Float32Array {
  const ints = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i] / 32768;
  return out;
}

function rms(samples: Float32Array) {
  let s = 0;
  for (const v of samples) s += v * v;
  return Math.sqrt(s / Math.max(1, samples.length));
}

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb || 1);
};

export type ClipProblem = "too-short" | "too-quiet";

/** Voiceprint of one clip, or why it can't be used. */
export function embed(samples: Float32Array): { embedding: number[] } | { problem: ClipProblem } {
  if (samples.length < SAMPLE_RATE * 0.8) return { problem: "too-short" };
  if (rms(samples) < 0.004) return { problem: "too-quiet" };
  const ex = extractor();
  const stream = ex.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  stream.inputFinished();
  return { embedding: Array.from(ex.compute(stream)) };
}

export function ownerVoice(): OwnerVoice | null {
  if (voiceIdDisabled()) return null;
  const v = kvGet<OwnerVoice>("owner_voice");
  return v?.embeddings?.length ? v : null;
}

/**
 * Mid-conversation, sir's voice drifts from his enrollment (tired, late at night, further from
 * the mic) and short commands ("Stop.") give weak voiceprints. Within a few minutes of a confident
 * match, a somewhat lower score still counts as him; strangers still need the full threshold.
 */
const TRUST_MS = 10 * 60_000;
const TRUSTED_THRESHOLD = THRESHOLD - 0.12;
const SHORT_CLIP_S = 1.5;
const SHORT_TRUST_MS = 2 * 60_000;
const SHORT_THRESHOLD = THRESHOLD - 0.2;
/** Matches this confident (and long enough) teach the voiceprint how he sounds now. */
const LEARN_THRESHOLD = THRESHOLD + 0.08;
const LEARN_EVERY_MS = 30_000;
const LEARNED_MAX = 40;

type Check = { at: number; similarity: number; ok: boolean; seconds: number; how: "match" | "trusted" | "short" | "refused" };
const checks = ((g as unknown as { __sundayVoiceChecks?: Check[] }).__sundayVoiceChecks ??= []);
let strongAt = 0;
let learnedAt = 0;

/** Recent verification results, for diagnostics ("how well does she know my voice?"). */
export function voiceChecks() {
  return checks.slice(-30);
}

/** Is this clip sir? On success, returns a single-use token for /api/chat. */
export function verify(samples: Float32Array) {
  const owner = ownerVoice();
  if (!owner) return { enrolled: false as const, owner: true, token: null, similarity: null };
  const result = embed(samples);
  if ("problem" in result) return { enrolled: true as const, owner: false, problem: result.problem, token: null, similarity: null };
  // Compare with the averaged voiceprint only: taking the best of several samples
  // gives strangers extra chances to score high.
  const similarity = cosine(result.embedding, owner.centroid);
  const now = Date.now();
  const seconds = samples.length / SAMPLE_RATE;
  const how: Check["how"] =
    similarity >= THRESHOLD
      ? "match"
      : now - strongAt < TRUST_MS && similarity >= TRUSTED_THRESHOLD
        ? "trusted"
        : seconds < SHORT_CLIP_S && now - strongAt < SHORT_TRUST_MS && similarity >= SHORT_THRESHOLD
          ? "short"
          : "refused";
  const isOwner = how !== "refused";
  checks.push({ at: now, similarity: Math.round(similarity * 100) / 100, ok: isOwner, seconds: Math.round(seconds * 10) / 10, how });
  if (checks.length > 100) checks.splice(0, checks.length - 100);

  let token: string | null = null;
  if (isOwner) {
    state.ownerHeardAt = now;
    if (how === "match") strongAt = now;
    if (similarity >= LEARN_THRESHOLD && seconds >= SHORT_CLIP_S && now - learnedAt > LEARN_EVERY_MS) learn(owner, result.embedding);
    token = randomBytes(16).toString("hex");
    state.tokens.set(token, { exp: now + TOKEN_TTL_MS, similarity });
  } else {
    logActivity("security", "Voice not recognised", similarity.toFixed(2));
  }
  return { enrolled: true as const, owner: isOwner, similarity: Math.round(similarity * 100) / 100, token };
}

/**
 * Blends a confidently-matched clip into the voiceprint: half from enrollment (the anchor that
 * never changes), half from his most recent confident matches — so it follows how he sounds lately.
 */
function learn(owner: OwnerVoice, embedding: number[]) {
  learnedAt = Date.now();
  const learned = [...(owner.learned ?? []), embedding].slice(-LEARNED_MAX);
  const mean = (list: number[][]) => list[0].map((_, i) => list.reduce((s, e) => s + e[i], 0) / list.length);
  const anchor = mean(owner.embeddings);
  const recent = mean(learned);
  const centroid = anchor.map((v, i) => v * 0.5 + recent[i] * 0.5);
  kvSet("owner_voice", { ...owner, learned, centroid } satisfies OwnerVoice);
}

/**
 * Gate for /api/chat. Voice requests need a fresh single-use token from
 * verify(); typed requests need sir's voice to have been heard recently.
 */
/** How a request got through the gate — told to SUNDAY so she can explain it. */
export type ChatSecurity =
  | { ok: false }
  | { ok: true; via: "off" }
  | { ok: true; via: "voice"; similarity: number }
  | { ok: true; via: "recent-voice"; heardAgoMin: number }
  | { ok: true; via: "telegram" }
  | { ok: true; via: "routine" };

export function allowChat(mode: "voice" | "text", token?: string | null): ChatSecurity {
  if (!ownerVoice()) return { ok: true, via: "off" };
  const now = Date.now();
  for (const [t, v] of state.tokens) if (v.exp < now) state.tokens.delete(t);
  const pass = token ? state.tokens.get(token) : undefined;
  if (token && pass) {
    state.tokens.delete(token);
    return { ok: true, via: "voice", similarity: Math.round(pass.similarity * 100) / 100 };
  }
  if (mode === "text" && now - state.ownerHeardAt < TEXT_GRACE_MS) {
    return { ok: true, via: "recent-voice", heardAgoMin: Math.round((now - state.ownerHeardAt) / 60_000) };
  }
  return { ok: false };
}

/** Voices refused recently, so SUNDAY can mention attempts while sir was away. */
export function recentRefusals(hours = 24): { count: number; lastAt: number | null } {
  const since = Date.now() - hours * 3_600_000;
  const row = db()
    .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM activity WHERE kind = 'security' AND label = 'Voice not recognised' AND created_at >= ?")
    .get(since) as { n: number; last: number | null };
  return { count: row.n, lastAt: row.last };
}

export const voiceThreshold = () => THRESHOLD;

export const ownerRecentlyHeard = (withinMs = 5 * 60 * 1000) => Date.now() - state.ownerHeardAt < withinMs;

/* ───────── Enrollment ───────── */

export function enrollReset() {
  state.pending = [];
}

export function enrollAdd(samples: Float32Array) {
  const result = embed(samples);
  if ("problem" in result) return { ok: false as const, problem: result.problem, count: state.pending.length };
  state.pending.push(result.embedding);
  return { ok: true as const, count: state.pending.length };
}

export function enrollSave() {
  const samples = state.pending;
  if (samples.length < 4) return { ok: false as const, error: "Need at least 4 recordings." };
  const dim = samples[0].length;
  const centroid = Array.from({ length: dim }, (_, i) => samples.reduce((s, e) => s + e[i], 0) / samples.length);
  const consistency = samples.map((e) => cosine(e, centroid));
  // Every recording should sound like the same person.
  if (Math.min(...consistency) < THRESHOLD) {
    state.pending = [];
    return { ok: false as const, error: "The recordings didn't sound like the same voice. Let's try again in a quieter spot." };
  }
  kvSet("owner_voice", { embeddings: samples, centroid, enrolledAt: Date.now() } satisfies OwnerVoice);
  state.pending = [];
  state.ownerHeardAt = Date.now();
  logActivity("security", "Voice ID enrolled");
  return { ok: true as const, consistency: Math.round(Math.min(...consistency) * 100) / 100 };
}

export function enrollRemove() {
  kvSet("owner_voice", { embeddings: [], centroid: [], enrolledAt: 0 } satisfies OwnerVoice);
  logActivity("security", "Voice ID removed");
}
