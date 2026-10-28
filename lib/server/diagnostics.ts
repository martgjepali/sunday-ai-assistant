import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BRAIN_LABEL,
  brainFacts,
  brainMode,
  brainRuns,
  createLocalModel,
  forgetLocalStatus,
  localBrainStatus,
  ollamaApi,
  setBrainMode,
  unloadLocal,
  warmLocal,
  type Brain,
} from "./brains";
import { FAST_MODEL, IMAGE_MAX_USD, IMAGE_MODEL, LOCAL_BASE_MODEL, LOCAL_KEEP_ALIVE, LOCAL_MODEL, MODEL, OLLAMA_URL, driveRoots, features } from "./config";
import { indexerStatus } from "./indexer";
import { ownerVoice, voiceChecks, voiceIdDisabled, voiceThreshold } from "./speaker";

/** "last 12 checks: 10 passed (avg match 0.71, 2 via trust), 2 refused (0.41, 0.38)" */
function voiceSummary() {
  const c = voiceChecks();
  if (!c.length) return "no voice checks since SUNDAY started";
  const ok = c.filter((x) => x.ok);
  const bad = c.filter((x) => !x.ok);
  const avg = ok.length ? (ok.reduce((s, x) => s + x.similarity, 0) / ok.length).toFixed(2) : "–";
  const trusted = ok.filter((x) => x.how !== "match").length;
  const learned = ownerVoice()?.learned?.length ?? 0;
  return `last ${c.length} checks: ${ok.length} passed (avg ${avg}, threshold ${voiceThreshold()}${trusted ? `, ${trusted} via conversation trust` : ""}), ${bad.length} refused${bad.length ? ` (${bad.slice(-4).map((x) => `${x.similarity} over ${x.seconds}s`).join(", ")})` : ""}; voiceprint has learned from ${learned} recent clips`;
}
import { gmailAccount } from "./tools/gmail";
import { typesafeEnabled } from "./typesafe";
import { voiceStatus, wakeWordConfig } from "./voice";

/**
 * SUNDAY's self-check: every brain end to end, the GPU, her senses and services,
 * disk space and recent failures — with a plain list of problems and fixes.
 * `test: true` also sends each brain a tiny message (costs a fraction of a cent).
 */

/* ───────── Recent issues from anywhere in SUNDAY ───────── */

type Issue = { at: number; source: string; message: string };
const g = globalThis as unknown as { __sundayIssues?: Issue[] };
const issues = (g.__sundayIssues ??= []);

export function recordIssue(source: string, message: string) {
  issues.push({ at: Date.now(), source, message: message.slice(0, 300) });
  if (issues.length > 50) issues.splice(0, issues.length - 50);
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function run(file: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );
}

const OLLAMA_APP = path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama", "ollama app.exe");

async function ollamaProcesses() {
  try {
    const out = await run("tasklist.exe", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq ollama*"]);
    return out
      .split(/\r?\n/)
      .map((l) => l.split('","').map((c) => c.replace(/"/g, "")))
      .filter((c) => /^ollama/i.test(c[0] ?? ""))
      .map((c) => ({ name: c[0], pid: Number(c[1]) }));
  } catch {
    return [];
  }
}

/* ───────── The local brain ───────── */

async function checkLocal(test: boolean, problems: string[]) {
  const out: Record<string, unknown> = { model: LOCAL_MODEL, base: LOCAL_BASE_MODEL, server: OLLAMA_URL };
  try {
    out.ollamaVersion = (await ollamaApi("/api/version")).version;
  } catch {
    const procs = await ollamaProcesses();
    out.ollama = "not answering";
    out.processes = procs;
    if (procs.length) {
      problems.push(
        `Ollama is running (${procs.map((p) => `${p.name} PID ${p.pid}`).join(", ")}) but its server isn't answering — usually a stuck copy holding its settings file. Fix: Task Manager → Details → End task on those PIDs, then open Ollama once from the Start menu and wait ~10s (clicking repeatedly opens more copies). I won't end processes myself.`,
      );
    } else {
      problems.push("Ollama isn't running. I can start it (repair: start_ollama), or sir can open it from the Start menu.");
    }
    return out;
  }

  const tags = ((await ollamaApi("/api/tags")).models as { name: string; size: number }[] | undefined) ?? [];
  const find = (n: string) => tags.find((t) => t.name === n || t.name === `${n}:latest`);
  out.downloaded = find(LOCAL_BASE_MODEL) ? `${LOCAL_BASE_MODEL} (${(find(LOCAL_BASE_MODEL)!.size / 1e9).toFixed(1)} GB)` : false;
  out.sundayModel = Boolean(find(LOCAL_MODEL));
  if (!out.downloaded) problems.push(`The local model ${LOCAL_BASE_MODEL} isn't downloaded (sir: "ollama pull ${LOCAL_BASE_MODEL}", ~9 GB — models live on F:).`);
  else if (!out.sundayModel) problems.push(`SUNDAY's local model "${LOCAL_MODEL}" is missing; repair reload_local recreates it.`);

  const ps = ((await ollamaApi("/api/ps")).models as { name: string; size: number; size_vram: number; expires_at?: string; context_length?: number }[] | undefined) ?? [];
  const loaded = ps.find((m) => m.name.split(":")[0] === LOCAL_MODEL.split(":")[0]);
  if (loaded) {
    const gpuShare = loaded.size ? Math.round((loaded.size_vram / loaded.size) * 100) : 0;
    out.loaded = {
      memoryGB: +(loaded.size / 1e9).toFixed(1),
      onGpu: `${gpuShare}%`,
      context: loaded.context_length ?? null,
      unloadsAt: loaded.expires_at ? new Date(loaded.expires_at).toLocaleTimeString("en-GB") : null,
    };
    if (gpuShare < 100) problems.push(`Only ${gpuShare}% of the local model fits in GPU memory, so it runs slower. Closing GPU-heavy apps helps.`);
  } else {
    out.loaded = false;
    if (out.sundayModel) problems.push(`The local model isn't loaded right now (it unloads after ${LOCAL_KEEP_ALIVE} idle). Haiku answers while it loads; repair reload_local loads it now.`);
  }
  const others = ps.filter((m) => m !== loaded).map((m) => m.name);
  if (others.length) out.otherModelsLoaded = others;

  if (test && out.sundayModel) {
    const t0 = Date.now();
    try {
      const r = await ollamaApi(
        "/api/chat",
        { model: LOCAL_MODEL, messages: [{ role: "user", content: "Reply with just: OK" }], stream: false, think: false, keep_alive: LOCAL_KEEP_ALIVE },
        120_000,
      );
      const evalCount = Number(r.eval_count ?? 0);
      const evalNs = Number(r.eval_duration ?? 0);
      out.test = {
        ok: true,
        ms: Date.now() - t0,
        reply: String((r.message as { content?: string })?.content ?? "").trim().slice(0, 40),
        tokensPerSecond: evalNs ? Math.round(evalCount / (evalNs / 1e9)) : null,
      };
    } catch (err) {
      out.test = { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
      problems.push(`The local brain failed a test message: ${(out.test as { error: string }).error}`);
    }
  }
  return out;
}

/* ───────── The Claude brains ───────── */

let client: Anthropic | null = null;

async function checkClaude(brain: Brain, model: string, test: boolean, problems: string[]) {
  const out: Record<string, unknown> = { model };
  if (!features.anthropic()) {
    problems.push("ANTHROPIC_API_KEY is missing from .env — the Haiku and Opus brains can't work.");
    return { ...out, ok: false };
  }
  client ??= new Anthropic();
  try {
    // Free: confirms the key works and has access to this model.
    const info = await client.models.retrieve(model);
    out.access = info.display_name ?? info.id;
  } catch (err) {
    const message = err instanceof Anthropic.AuthenticationError ? "API key rejected" : err instanceof Error ? err.message : String(err);
    out.access = false;
    out.error = message;
    problems.push(`The ${BRAIN_LABEL[brain]} brain (${model}) isn't reachable: ${message}.`);
    return out;
  }
  if (test) {
    const t0 = Date.now();
    try {
      const r = await client.messages.create({
        model,
        max_tokens: 200,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "Reply with just: OK" }],
      });
      const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      out.test = { ok: true, ms: Date.now() - t0, reply: text.slice(0, 40) };
    } catch (err) {
      out.test = { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
      problems.push(`The ${BRAIN_LABEL[brain]} brain failed a test message: ${(out.test as { error: string }).error}`);
    }
  }
  return out;
}

/* ───────── PC ───────── */

async function checkGpu(problems: string[]) {
  try {
    const line = await run("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"]);
    const [name, used, total, util, temp] = line.split(",").map((s) => s.trim());
    const usedPct = Math.round((Number(used) / Number(total)) * 100);
    if (Number(temp) >= 85) problems.push(`The GPU is hot (${temp}°C).`);
    return { name, memory: `${(Number(used) / 1024).toFixed(1)} / ${(Number(total) / 1024).toFixed(1)} GB (${usedPct}%)`, load: `${util}%`, temperature: `${temp}°C` };
  } catch {
    return { error: "nvidia-smi not available" };
  }
}

async function checkDisks(problems: string[]) {
  const out: Record<string, string> = {};
  for (const root of driveRoots()) {
    try {
      const s = await fs.statfs(root);
      const free = (s.bavail * s.bsize) / 1e9;
      const total = (s.blocks * s.bsize) / 1e9;
      out[root.slice(0, 2)] = `${free.toFixed(0)} GB free of ${total.toFixed(0)} GB`;
      if (free < 10) problems.push(`Drive ${root.slice(0, 2)} is almost full (${free.toFixed(1)} GB free).`);
    } catch {
      out[root.slice(0, 2)] = "unknown";
    }
  }
  return out;
}

function checkSenses(problems: string[]) {
  const voice = voiceStatus();
  const wake = wakeWordConfig();
  const owner = ownerVoice();
  if (voice.engine === "browser") problems.push("No voice engine (Kokoro model or ElevenLabs key), so I speak with the browser's voice.");
  if (!features.deepgram()) problems.push("DEEPGRAM_API_KEY is missing, so live speech recognition is off.");
  if (!wake.ready) problems.push(`The "Hey Sunday" wake word needs: ${wake.missing.join(", ")}.`);
  return {
    voice:
      voice.engine === "kokoro"
        ? `Kokoro (${voice.kokoroVoice}, free, on this PC${voice.elevenlabs ? "; ElevenLabs available with SUNDAY_VOICE_ENGINE=elevenlabs" : ""})`
        : voice.engine === "elevenlabs"
          ? `ElevenLabs${voice.kokoroVoice ? " (Kokoro covers when credits run out)" : ""}`
          : "browser voice",
    ears: features.deepgram() ? "Deepgram live" : "off",
    wakeWord: wake.ready ? "armed" : "not ready",
    voiceId: voiceIdDisabled() ? "turned off (SUNDAY_VOICE_ID=off)" : owner ? `enrolled — strangers refused; ${voiceSummary()}` : "not set up",
    instinct: typesafeEnabled() ? "Jev (TypeSafe) on" : "off",
    gmail: gmailAccount() ?? (features.google() ? "not connected" : "not configured"),
    images: features.higgsfield() ? `Higgsfield (${IMAGE_MODEL}, max $${IMAGE_MAX_USD} per request)` : "not connected (HF_CREDENTIALS missing from .env.local)",
    fileIndex: Object.fromEntries(Object.entries(indexerStatus()).map(([d, s]) => [d.slice(0, 2), `${s.state}, ${s.count} items`])),
  };
}

/* ───────── The report ───────── */

export async function brainDiagnostics({ test = false } = {}) {
  const problems: string[] = [];
  const [local, fast, deep, gpu, disks] = await Promise.all([
    checkLocal(test, problems),
    checkClaude("fast", FAST_MODEL, test, problems),
    checkClaude("deep", MODEL, test, problems),
    checkGpu(problems),
    checkDisks(problems),
  ]);
  const senses = checkSenses(problems);

  const recent = brainRuns().slice(-60);
  const usage = Object.fromEntries(
    (["local", "fast", "deep"] as Brain[]).map((b) => {
      const mine = recent.filter((r) => r.brain === b);
      const answered = mine.filter((r) => r.outcome === "answered");
      return [
        BRAIN_LABEL[b],
        {
          answered: answered.length,
          handedOff: mine.filter((r) => r.outcome === "handed-off").length,
          failed: mine.filter((r) => r.outcome === "failed").length,
          avgSeconds: answered.length ? +(answered.reduce((s, r) => s + r.ms, 0) / answered.length / 1000).toFixed(1) : null,
        },
      ];
    }),
  );
  const failures = recent.filter((r) => r.outcome === "failed").slice(-5);
  for (const f of failures.slice(-2)) problems.push(`The ${BRAIN_LABEL[f.brain]} brain failed ${ago(f.at)}: ${f.error}`);
  const recentIssues = issues.slice(-8).map((i) => `${ago(i.at)} · ${i.source}: ${i.message}`);

  return {
    mode: brainMode(),
    brains: {
      local: { what: brainFacts("local"), ...local },
      Haiku: { what: brainFacts("fast"), ...fast },
      Opus: { what: brainFacts("deep"), ...deep },
    },
    usageSinceStart: usage,
    recentFailures: failures.map((f) => ({ when: ago(f.at), brain: BRAIN_LABEL[f.brain], why: f.why, error: f.error })),
    recentIssues,
    gpu,
    disks,
    senses,
    problems: problems.length ? problems : ["None found — all systems normal."],
  };
}

/* ───────── Self-repair ───────── */

export type RepairAction = "reload_local" | "unload_local" | "start_ollama" | "reset_brain_mode";

export async function repairBrain(action: RepairAction) {
  switch (action) {
    case "reload_local": {
      forgetLocalStatus();
      const status = await localBrainStatus();
      if (!status.ready) return { fixed: false, reason: status.reason };
      await createLocalModel(); // re-applies SUNDAY's settings (context window) to her local model
      forgetLocalStatus();
      await warmLocal();
      const ps = ((await ollamaApi("/api/ps")).models as { name: string }[] | undefined) ?? [];
      const loaded = ps.some((m) => m.name.split(":")[0] === LOCAL_MODEL.split(":")[0]);
      return { fixed: loaded, note: loaded ? "Local brain rebuilt and loaded into the GPU." : "Rebuilt, but it didn't load — check GPU memory." };
    }
    case "unload_local":
      await unloadLocal();
      return { fixed: true, note: "Local brain unloaded — ~10 GB of GPU memory is free. It reloads by itself the next time it's needed." };
    case "start_ollama": {
      try {
        await ollamaApi("/api/version");
        return { fixed: true, note: "Ollama is already running." };
      } catch {}
      const procs = await ollamaProcesses();
      if (procs.length) {
        return {
          fixed: false,
          note: `A copy of Ollama is stuck (${procs.map((p) => `${p.name} PID ${p.pid}`).join(", ")}). Sir needs to end it in Task Manager → Details, then open Ollama once from the Start menu. I don't end processes myself.`,
        };
      }
      if (!existsSync(OLLAMA_APP)) return { fixed: false, note: "Ollama isn't installed where I expected it." };
      // Through Explorer, like clicking its icon, so it runs as its own app.
      await run("explorer.exe", [OLLAMA_APP]).catch(() => {});
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          await ollamaApi("/api/version");
          forgetLocalStatus();
          void warmLocal();
          return { fixed: true, note: "Ollama started; the local brain is loading (~20s)." };
        } catch {}
      }
      return { fixed: false, note: "I opened Ollama but its server didn't answer within 30s." };
    }
    case "reset_brain_mode":
      setBrainMode("auto");
      return { fixed: true, note: "Brain mode back to automatic." };
  }
}
