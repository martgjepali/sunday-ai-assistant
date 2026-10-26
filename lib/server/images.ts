import "server-only";
import {
  AuthenticationError,
  BadInputError,
  NotEnoughCreditsError,
  TimeoutError,
  ValidationError,
  createHiggsfieldClient,
  type HiggsfieldClient,
  type V2Response,
} from "@higgsfield/client/v2";
import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, HIGGSFIELD_URL, HOME, IMAGE_MAX_USD, IMAGE_MODEL, IMAGE_PREVIEW, features } from "./config";
import { logActivity } from "./db";
import { indexPath } from "./indexer";
import { pushNotice } from "./notices";
import { openPath } from "./tools/apps";
import { FileToolError, assertWritable, realOrSelf, recordOp, resolveUserPath, uniqueTarget } from "./tools/files";

/**
 * SUNDAY's image studio, powered by Higgsfield's API. A generation runs in the
 * background; finished images wait in SUNDAY's own data folder, she opens a
 * preview and asks sir where they should go. Nothing lands in his folders
 * until he names the place (save_image) — and saving never overwrites.
 */

const API = HIGGSFIELD_URL;
const PENDING_DIR = path.join(DATA_DIR, "images", "pending");
const POLL_TIMEOUT_MS = 10 * 60_000;

/** What Soul v2 accepts (checked against the live estimate endpoint). */
export const ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

type ImageJob = {
  id: string;
  prompt: string;
  status: "working" | "ready" | "saved" | "failed";
  startedAt: number;
  finishedAt?: number;
  estimateUsd?: number;
  /** Downloaded copies in SUNDAY's data folder, waiting for sir to say where they go. */
  files: string[];
  saved: string[];
  error?: string;
};

const g = globalThis as unknown as { __sundayImageJobs?: Map<string, ImageJob> };
const jobs = (g.__sundayImageJobs ??= new Map<string, ImageJob>());

let client: HiggsfieldClient | undefined;
/** The official SDK client; it polls each request until it finishes. */
function sdk() {
  return (client ??= createHiggsfieldClient({ credentials: process.env.HF_CREDENTIALS, baseURL: API, maxPollTime: POLL_TIMEOUT_MS }));
}

/** Plain REST for what the SDK doesn't cover (price estimates, deleting our copy on Higgsfield). */
async function hf(pathname: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Key ${process.env.HF_CREDENTIALS}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}
  return { status: res.status, ok: res.ok, body, text };
}

/** Higgsfield's error, in words SUNDAY can repeat to sir. */
function explain(status: number, text: string) {
  if (status === 401) return "Higgsfield rejected the API key — check HF_CREDENTIALS in .env.local (key-id:key-secret).";
  if (status === 403) return "Higgsfield refused — usually not enough API credit (top up at cloud.higgsfield.ai; it's separate from the website plan).";
  if (status === 402) return "The Higgsfield API balance is empty — top it up at cloud.higgsfield.ai (API credit is separate from the website plan).";
  if (status === 429) return "Higgsfield is busy with my other requests — try again in a minute.";
  return `Higgsfield said ${status}: ${text.slice(0, 160)}`;
}

/** Starts a generation and returns straight away; the images arrive in the background. */
export async function generateImage(input: {
  prompt: string;
  aspectRatio?: AspectRatio;
  count?: number;
  highRes?: boolean;
}) {
  if (!features.higgsfield()) {
    throw new FileToolError(
      "Higgsfield isn't connected yet — sir needs to add HF_CREDENTIALS (key-id:key-secret, from the API keys page at cloud.higgsfield.ai) to .env.local and restart me.",
    );
  }
  const body: Record<string, unknown> = {
    prompt: input.prompt.trim(),
    aspect_ratio: input.aspectRatio ?? "4:3",
    num_images: Math.min(Math.max(input.count ?? 1, 1), 4),
    resolution: input.highRes ? "1080p" : "720p",
  };

  // Free price check first; refuse anything over sir's per-request limit.
  const est = await hf(`/estimate/${IMAGE_MODEL}`, { method: "POST", body: JSON.stringify(body) });
  if (est.status === 401 || est.status === 403 || est.status === 402) throw new FileToolError(explain(est.status, est.text));
  const usd = est.ok ? Number(est.body.usd) : NaN;
  if (Number.isFinite(usd) && usd > IMAGE_MAX_USD) {
    throw new FileToolError(
      `That would cost about $${usd.toFixed(2)}, over the $${IMAGE_MAX_USD.toFixed(2)} limit per request (SUNDAY_IMAGE_MAX_USD). Ask sir for fewer images or a lower resolution.`,
    );
  }

  const job: ImageJob = {
    id: randomBytes(4).toString("hex"),
    prompt: String(body.prompt),
    status: "working",
    startedAt: Date.now(),
    estimateUsd: Number.isFinite(usd) ? usd : undefined,
    files: [],
    saved: [],
  };
  jobs.set(job.id, job);
  logActivity("image", "started image", job.prompt.slice(0, 120));
  void runImageJob(job, body);

  return {
    started: true,
    job: job.id,
    cost: Number.isFinite(usd) ? `about $${usd.toFixed(2)} from his Higgsfield balance` : "unknown",
    note: "Generating in the background (usually under a minute). When it's ready I'll open a preview and ask him where to save it — tell him it's underway. Don't pick a folder yourself.",
  };
}

async function runImageJob(job: ImageJob, body: Record<string, unknown>) {
  try {
    let state: V2Response;
    try {
      state = await sdk().subscribe(IMAGE_MODEL, { input: body, withPolling: true });
    } catch (err) {
      // Some model versions take only a prompt — retry once with just that.
      if (!(err instanceof ValidationError || err instanceof BadInputError)) throw err;
      state = await sdk().subscribe(IMAGE_MODEL, { input: { prompt: body.prompt }, withPolling: true });
    }
    const status = state.status as string;
    if (status === "nsfw") throw new Error("Higgsfield blocked it as unsafe content (no charge).");
    if (status !== "completed") throw new Error(`Higgsfield ${status} (no charge).`);
    const requestId = state.request_id;

    const urls = (state.images ?? []).map((i) => i.url).filter(Boolean);
    if (!urls.length) throw new Error("Higgsfield finished but sent no images.");
    await fs.mkdir(PENDING_DIR, { recursive: true });
    for (const [i, url] of urls.entries()) {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Couldn't download image ${i + 1} (${res.status}).`);
      const type = res.headers.get("content-type") ?? "";
      const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : /\.png(\?|$)/i.test(url) ? ".png" : ".jpg";
      const file = path.join(PENDING_DIR, `${job.id}-${i + 1}${ext}`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      job.files.push(file);
    }
    // Our copies are safe, so Higgsfield needn't keep its own for 7 days.
    void hf(`/requests/${requestId}`, { method: "DELETE" }).catch(() => {});

    Object.assign(job, { status: "ready", finishedAt: Date.now() });
    logActivity("image", `image ready (${job.files.length})`, job.prompt.slice(0, 120));
    if (IMAGE_PREVIEW) await openPath(job.files[0]).catch(() => {});
    const many = job.files.length > 1;
    const shown = IMAGE_PREVIEW ? ` — I've opened ${many ? "the first one" : "it"} so you can see` : "";
    pushNotice(
      "SUNDAY — image ready",
      `Sir, your ${many ? `${job.files.length} images are` : "image is"} ready${shown}. Where would you like me to save ${many ? "them" : "it"}?`,
    );
  } catch (err) {
    const message =
      err instanceof AuthenticationError
        ? explain(401, "")
        : err instanceof NotEnoughCreditsError
          ? explain(403, "")
          : err instanceof TimeoutError
            ? "Higgsfield didn't finish within 10 minutes (it may have been canceled)."
            : err instanceof Error
              ? err.message
              : String(err);
    Object.assign(job, { status: "failed", finishedAt: Date.now(), error: message.slice(0, 300) });
    logActivity("image", "image failed", message.slice(0, 200));
    pushNotice("SUNDAY — image failed", `Sir, the image didn't work out: ${message.slice(0, 160)}`);
  }
}

/** Windows-safe file name from his name for it, or the first words of the prompt. */
function imageName(name: string | undefined, prompt: string) {
  const base = (name ?? prompt.split(/\s+/).slice(0, 6).join(" "))
    .replace(/\.(png|jpe?g|webp)$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80);
  return base || "SUNDAY image";
}

const plain = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const AGREES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|sounds good|perfect|please|that works|fine|great)\b/i;

/**
 * Did sir himself name this folder? True when his message mentions it (or a part
 * of its path, e.g. "desktop" for C:\Users\…\Desktop) — or when he just said "yes"
 * to the place SUNDAY suggested in her last reply.
 */
export function sirNamedPlace(folder: string, userText: string, lastReply: string) {
  const said = plain(AGREES.test(userText) ? `${userText} ${lastReply}` : userText);
  const full = resolveUserPath(folder);
  const inHome = full.toLowerCase().startsWith(HOME.toLowerCase() + "\\");
  const parts = (inHome ? full.slice(HOME.length + 1) : full.slice(3)).split("\\").filter(Boolean);
  if (!parts.length) {
    const d = full[0].toLowerCase();
    return new RegExp(` (${d} drive|drive ${d}|${d}) `).test(said);
  }
  // A folder counts only when named as a place — "in my Pictures", "on the desktop", "to D:\Art" —
  // so "save it" doesn't match "Sunday Saves" and "nice picture" doesn't mean Pictures.
  return parts.some((part) => {
    const words = plain(part).trim().split(" ").filter(Boolean);
    if (!words.length) return false;
    const name = words.map((w) => `${w.replace(/s$/, "")}s?`).join("(?: \\w+)?? ");
    return new RegExp(` (?:in|into|to|on|onto|inside|under|at|folder)(?: \\w+){0,3}? ${name} `).test(said);
  });
}

/** Copies a finished generation to the folder sir chose. Never overwrites; undo sets the copies aside. */
export async function saveImages(input: { folder: string; filename?: string; job?: string }) {
  const job = input.job
    ? jobs.get(input.job)
    : [...jobs.values()].filter((j) => j.status === "ready").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  if (!job) throw new FileToolError(input.job ? `No image job ${input.job}.` : "There's no finished image waiting to be saved.");
  if (job.status === "working") throw new FileToolError("That image is still being made — I'll ask once it's ready.");
  if (job.status === "failed") throw new FileToolError(`That image failed: ${job.error}`);

  const folder = resolveUserPath(input.folder);
  assertWritable(folder);
  assertWritable(await realOrSelf(path.win32.dirname(folder)));
  await fs.mkdir(folder, { recursive: true });

  const name = imageName(input.filename, job.prompt);
  const saved: string[] = [];
  for (const [i, src] of job.files.entries()) {
    const suffix = job.files.length > 1 ? ` ${i + 1}` : "";
    const target = uniqueTarget(path.win32.join(folder, `${name}${suffix}${path.extname(src)}`));
    await fs.copyFile(src, target, constants.COPYFILE_EXCL);
    recordOp("create-file", "", target);
    indexPath(target, false);
    saved.push(target);
  }
  job.saved.push(...saved);
  job.status = "saved";
  logActivity("image", `saved ${saved.length} image${saved.length > 1 ? "s" : ""}`, folder);
  return { saved, note: "Saved. Undo sets them aside." };
}

/** One line for SUNDAY's context: images being made, waiting for a folder, or saved in the last hour. */
export function imageJobsLine() {
  const recent = [...jobs.values()].filter(
    (j) => j.status === "working" || j.status === "ready" || Date.now() - (j.finishedAt ?? 0) < 3_600_000,
  );
  if (!recent.length) return "";
  const parts = recent.map((j) => {
    const what = `image job ${j.id} ("${j.prompt.slice(0, 50)}${j.prompt.length > 50 ? "…" : ""}")`;
    if (j.status === "working") return `${what}: still generating (${Math.round((Date.now() - j.startedAt) / 1000)}s so far)`;
    if (j.status === "ready") return `${what}: READY, ${j.files.length} image(s) waiting — ask sir where to save, then save_image`;
    if (j.status === "saved") return `${what}: saved to ${j.saved.join(", ")}`;
    return `${what}: failed (${j.error})`;
  });
  return `Images: ${parts.join("; ")}.`;
}
