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
/** Model for background memory extraction and conversation titles. */
export const MEMORY_MODEL = process.env.SUNDAY_MEMORY_MODEL ?? MODEL;

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
};

export function appOrigin(): string {
  const port = process.env.PORT ?? process.env.SUNDAY_PORT ?? "3210";
  return `http://127.0.0.1:${port}`;
}
