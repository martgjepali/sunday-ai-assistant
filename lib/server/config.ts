import "server-only";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR =
  process.env.SUNDAY_DATA_DIR ?? path.join(process.cwd(), ".sunday-data");

/** Main conversational model. */
export const MODEL = process.env.SUNDAY_MODEL ?? "claude-opus-5-5";
/** Low effort keeps voice replies quick; raise it for heavier reasoning. */
export const EFFORT = (process.env.SUNDAY_EFFORT ?? "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
/** Middle brain: quick, cheap Claude for multi-step everyday work. */
export const FAST_MODEL = process.env.SUNDAY_FAST_MODEL ?? "claude-haiku-5-5";
/** Everyday brain on sir's GPU, served by Ollama. Created from the base model with a bigger context. */
export const LOCAL_BASE_MODEL = process.env.SUNDAY_LOCAL_BASE_MODEL ?? "qwen3:14b";
export const LOCAL_MODEL = process.env.SUNDAY_LOCAL_MODEL ?? "sunday-local";
export const LOCAL_CONTEXT = Number(process.env.SUNDAY_LOCAL_CONTEXT ?? 8192);
/** How long the local model stays loaded in GPU memory after use (frees ~10 GB of VRAM when it lapses). */
export const LOCAL_KEEP_ALIVE = process.env.SUNDAY_LOCAL_KEEP_ALIVE ?? "30m";
export const OLLAMA_URL = (process.env.SUNDAY_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
/** Model for background memory extraction and conversation titles — runs after every reply, so keep it cheap. */
export const MEMORY_MODEL = process.env.SUNDAY_MEMORY_MODEL ?? FAST_MODEL;

/** Higgsfield image model endpoint (owner/model/variant) and the most one request may cost. */
export const IMAGE_MODEL = (process.env.SUNDAY_IMAGE_MODEL ?? "higgsfield-ai/soul/v2/standard").replace(/^\/+|\/+$/g, "");
export const IMAGE_MAX_USD = Number(process.env.SUNDAY_IMAGE_MAX_USD ?? 1);
/** Open a finished image straight away so sir can see it before choosing where it goes. */
export const IMAGE_PREVIEW = process.env.SUNDAY_IMAGE_PREVIEW !== "off";
export const HIGGSFIELD_URL = (process.env.SUNDAY_HIGGSFIELD_URL ?? "https://api.higgsfield.ai").replace(/\/+$/, "");

/** Haiku has no server-side fallback; sending `fallbacks` to it is an error. */
export function supportsFallbacks(model: string) {
  return !/haiku/i.test(model);
}

export const HOME = os.homedir();

/** Drive roots SUNDAY may read and organize, e.g. C:\ D:\ F:\ — only those that exist. */
export function driveRoots(): string[] {
  const configured = (process.env.SUNDAY_DRIVES ?? "C,D,F")
    .split(",")
    .map((d) => d.trim().replace(/[:\\/]+$/, "").toUpperCase())
    .filter(Boolean);
  return configured.map((d) => `${d}:\\`).filter((root) => existsSync(root));
}

export const features = {
  anthropic: () => Boolean(process.env.ANTHROPIC_API_KEY),
  elevenlabs: () => Boolean(process.env.ELEVENLABS_API_KEY),
  deepgram: () => Boolean(process.env.DEEPGRAM_API_KEY),
  google: () =>
    Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  higgsfield: () => Boolean(process.env.HF_CREDENTIALS?.includes(":")),
};

export function appOrigin(): string {
  const port = process.env.PORT ?? process.env.SUNDAY_PORT ?? "3210";
  return `http://127.0.0.1:${port}`;
}
