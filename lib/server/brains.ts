import "server-only";
import { FAST_MODEL, LOCAL_BASE_MODEL, LOCAL_CONTEXT, LOCAL_KEEP_ALIVE, LOCAL_MODEL, MODEL, OLLAMA_URL } from "./config";
import { kvGet, kvSet } from "./db";

/**
 * SUNDAY has three brains and picks one per message:
 *  - local: a model on sir's own GPU via Ollama — free, private, for everyday asks;
 *  - fast:  Claude Haiku — cheap and reliable for multi-step everyday work;
 *  - deep:  Claude Opus — coding, documents, computer use and anything hard.
 * The local and fast brains can hand a request up when it's beyond them.
 * Sir can also pin one brain ("brain mode") from the Systems panel or by voice.
 */
export type Brain = "local" | "fast" | "deep";
export type BrainMode = "auto" | Brain;

export const BRAIN_LABEL: Record<Brain, string> = { local: "local", fast: "Haiku", deep: "Opus" };

export function brainModel(brain: Brain) {
  return brain === "local" ? LOCAL_MODEL : brain === "fast" ? FAST_MODEL : MODEL;
}

/** "claude-haiku-5-5" → "Claude Haiku 5.5", "qwen3:14b" → "Qwen3 14B". */
export function modelName(id: string) {
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const [family, tag] = id.split(":");
  return `${family[0].toUpperCase()}${family.slice(1)}${tag && tag !== "latest" ? ` ${tag.toUpperCase()}` : ""}`;
}

/** What each brain is, in words SUNDAY can tell sir. */
export function brainFacts(brain: Brain) {
  if (brain === "local") {
    return `${modelName(LOCAL_BASE_MODEL)} (Ollama model "${LOCAL_MODEL}", built on ${LOCAL_BASE_MODEL}, ${LOCAL_CONTEXT}-token context), running offline on sir's own GPU through Ollama — free and private, but the least capable, with only everyday tools`;
  }
  if (brain === "fast") return `${modelName(FAST_MODEL)} (API model id ${FAST_MODEL}) by Anthropic, in the cloud — quick and very cheap, with almost all tools`;
  return `${modelName(MODEL)} (API model id ${MODEL}) by Anthropic, in the cloud — the most capable and the most expensive, with every tool`;
}

/** How SUNDAY says it out loud: short and human, no ids or context sizes. */
export function brainSpoken(brain: Brain) {
  if (brain === "local") return `my local brain — ${modelName(LOCAL_BASE_MODEL)}, running right here on your GPU`;
  return `my ${BRAIN_LABEL[brain]} brain — ${modelName(brainModel(brain))}, from Anthropic`;
}

/* ───────── Brain mode (auto or pinned) ───────── */

const MODES: BrainMode[] = ["auto", "local", "fast", "deep"];

export function brainMode(): BrainMode {
  const m = kvGet<BrainMode>("brain_mode");
  return m && MODES.includes(m) ? m : "auto";
}

export function setBrainMode(mode: BrainMode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown brain mode ${mode}.`);
  kvSet("brain_mode", mode);
  if (mode === "local") void warmLocal();
  return mode;
}

/* ───────── Routing ───────── */

/** Spoken one-off overrides: "think hard about…", "use Claude…", "stay local…". */
const FORCE_DEEP = /\b(think (hard|carefully|deeply)|use (claude|opus|your big brain)|deep mode|full power)\b/i;
const FORCE_LOCAL = /\b(stay local|local brain|offline mode)\b/i;

/** Work that always deserves the strongest brain. */
const DEEP_WORK = new RegExp(
  [
    // coding that needs real reasoning — debugging, refactoring, reviewing. Opening VS Code, creating a
    // file or a small function stays with the local brain (sir asked for that), which hands up what it can't do.
    String.raw`\b(debug\w*|refactor\w*|stack ?trace|lint(er|ing)?|code review|review (my|the|this) code)\b`,
    String.raw`\b(fix|find|track down) (a |an |the |this |that |my )?(bug|error|crash|issue|exception)s?\b`,
    String.raw`\b(my|the|this|that) (codebase|repo|build (is|fails|failed|broke))\b`,
    // making documents — just finding or opening one ("is the excel file there?") is everyday work
    String.raw`\b(make|create|write|build|draft|generate|prepare|put together|turn)\b[^.?!]{0,60}\b(word doc(ument)?|docx|excel|spreadsheet|xlsx|powerpoint|pptx|presentation|slides?|deck|pdf|cv|resume|cover letter)\b`,
    String.raw`\b(cv|resume|cover letter|presentation|slide deck)\b`,
    // 3D work in Blender
    String.raw`\b(blender|3d|three-?d|sculpt\w*|mesh(es)?|rig(ging)?|render(ing)? (a|the|my) model)\b`,
    // computer use and design
    String.raw`\b(use the (computer|mouse|keyboard)|take the wheel|click (on|the)|fill (in|out) (the|this) form|design|ui|ux|layout)\b`,
  ].join("|"),
  "i",
);

/** Multi-step everyday work: Haiku handles it well for a fraction of a cent. */
const FAST_WORK = new RegExp(
  [
    String.raw`\b(e-?mails?|gmail|inbox|mail|draft|reply to)\b`,
    // routines: schedules and standing instructions
    String.raw`\b(routines?|every (day|morning|evening|night|weekday|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (morning|evening|night|week|weekday)|on weekdays)\b`,
    // planning the day needs judgement across calendar, tasks and reminders
    String.raw`\b(plan (my|the|out my) (day|week|morning|afternoon)|what should i (do|focus on|work on))\b`,
    // adding or moving calendar events — date maths the local brain gets wrong; reading stays local
    String.raw`\b(add|put|book|schedule|reschedule|move|push|plan)\b[^.?!]{0,50}\b(calendar|meeting|appointment|event|call|dinner|lunch|session)\b`,
    String.raw`\b(search the web|look (it )?up|research|news|latest|price|how much is|who (is|won)|what happened)\b`,
    String.raw`\b(screen|look at|what am i looking|this error|clipboard|copied|notepad)\b`,
    String.raw`\b(this|that) (note|window|file|document|page|tab|spreadsheet|sheet|excel|word)\b`,
    String.raw`\b(move|rename|organi[sz]e|sort|tidy|clean up|folder|undo)\b`,
    String.raw`\b(skill|close (the )?app|shut ?down|restart|sleep)\b`,
    String.raw`\b(generate|draw|paint|render|images?|pictures?|photos?|illustrations?|wallpapers?|artwork|higgsfield)\b`,
  ].join("|"),
  "i",
);

/**
 * Coding goes to Claude even with the local brain pinned — sir's choice: the local model got stuck on
 * edits and couldn't find bugs. Debugging gets the deep brain, other coding the fast one.
 * Speech-to-text spellings included ("page. T s x", "DSX").
 */
const CODE_DEBUG = new RegExp(
  [
    String.raw`\b(debug\w*|refactor\w*|stack ?trace|lint(er|ing)?|code review|review (my|the|this) code)\b`,
    String.raw`\b(fix|find|track down|check|what'?s causing) (a |an |the |this |that |my |these |those )?(bug|error|crash|issue|exception|problem)s?\b`,
    String.raw`\b(errors?|bugs?|exceptions?|warnings?) (in|on|with|from)\b`,
    String.raw`\b(getting|having|seeing|there are|we have|i have|i'?ve got) (a |an |some |a bunch of |lots of |many )?(errors?|bugs?|red (lines|squiggles))\b`,
    String.raw`\b(won'?t|doesn'?t|does not|will not|can'?t) (run|compile|build|start|work|load)\b|\b(build|compile) (is |was )?(fail\w*|broke\w*|error\w*)\b`,
  ].join("|"),
  "i",
);
const CODE_WORK =
  /\b(code|coding|function|script|program|algorithm|class|component|python|javascript|typescript|react|next\.?\s?js|node\.?\s?js|npm|npx|install\w*|project|app folder|front ?end|back ?end|website|web ?app|single page|api|database|compile|syntax|variable|import|t\.? ?s\.? ?x|d ?s ?x|j\.? ?s\.? ?x|tsx|jsx)\b|\.(py|js|mjs|cjs|ts|tsx|jsx|html|css|json)\b|\bdot (py|js|ts|tsx|jsx|html|css|json)\b/i;
export const CODING_WHY = "coding goes to Claude even with the local brain pinned";
/** True when this brain was picked by the coding rule, so follow-ups ("now use quick sort") stay with it. */
export const isCodingRoute = (why: string) => why.includes(CODING_WHY);

/** Picks the brain for this message: sir's pinned choice, or the cheapest that can do it well. */
export async function chooseBrain(text: string): Promise<{ brain: Brain; why: string }> {
  if (FORCE_DEEP.test(text)) return { brain: "deep", why: "asked for full power on this one" };
  const mode = brainMode();
  if (mode === "fast" || mode === "deep") return { brain: mode, why: `sir pinned the ${BRAIN_LABEL[mode]} brain` };
  if (mode === "local" && !FORCE_LOCAL.test(text)) {
    if (CODE_DEBUG.test(text)) return { brain: "deep", why: `debugging — ${CODING_WHY}` };
    if (CODE_WORK.test(text)) return { brain: "fast", why: CODING_WHY };
  }

  const wantsLocal = mode === "local" || FORCE_LOCAL.test(text);
  if (!wantsLocal && DEEP_WORK.test(text)) return { brain: "deep", why: "coding, documents or computer use" };
  if (!wantsLocal && FAST_WORK.test(text)) return { brain: "fast", why: "multi-step everyday task" };
  const lent = gpuLent();
  if (lent) return { brain: "fast", why: `the GPU is busy with ${lent}` };
  const local = await localBrainStatus();
  if (!local.ready) return { brain: "fast", why: `local brain unavailable (${local.reason})` };
  if (!(await localLoaded())) {
    if (mode === "local") {
      // He chose local on purpose, so wait for it to load (~20s) rather than switch.
      await warmLocal();
      return { brain: "local", why: "sir pinned the local brain (it had to load first)" };
    }
    // Loading 9 GB into the GPU takes ~20s — don't make him wait; Haiku answers this one.
    void warmLocal();
    return { brain: "fast", why: "local brain warming up" };
  }
  return { brain: "local", why: mode === "local" ? "sir pinned the local brain" : wantsLocal ? "asked to stay local" : "everyday request" };
}

/** The next brain up, for hand-offs. */
export function escalate(brain: Brain): Brain {
  return brain === "local" ? "fast" : "deep";
}

/* ───────── Run history (for diagnostics) ───────── */

export type BrainRun = { at: number; brain: Brain; ms: number; outcome: "answered" | "handed-off" | "failed"; why: string; error?: string };

const g = globalThis as unknown as { __sundayBrainRuns?: BrainRun[] };
const runs = (g.__sundayBrainRuns ??= []);

export function recordBrainRun(run: BrainRun) {
  runs.push(run);
  if (runs.length > 200) runs.splice(0, runs.length - 200);
}

export function brainRuns() {
  return runs;
}

/* ───────── Local brain health ───────── */

type LocalStatus = { ready: true; model: string } | { ready: false; reason: string };

let cached: { at: number; status: LocalStatus } | null = null;
let creating: Promise<void> | null = null;

export async function ollamaApi(pathname: string, body?: unknown, timeoutMs = 2500) {
  const res = await fetch(`${OLLAMA_URL}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${pathname} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** Creates SUNDAY's local model: the base model with a bigger context window (Ollama defaults to 4K). */
export async function createLocalModel() {
  creating ??= ollamaApi("/api/create", { model: LOCAL_MODEL, from: LOCAL_BASE_MODEL, parameters: { num_ctx: LOCAL_CONTEXT }, stream: false }, 60_000)
    .then(() => {})
    .finally(() => (creating = null));
  await creating;
}

/** Is the local brain usable right now? Checked at most every 30s; creates SUNDAY's model the first time. */
export async function localBrainStatus(): Promise<LocalStatus> {
  if (process.env.SUNDAY_BRAINS === "claude") return { ready: false, reason: "turned off (SUNDAY_BRAINS=claude)" };
  if (cached && Date.now() - cached.at < 30_000) return cached.status;
  let status: LocalStatus;
  try {
    const tags = await ollamaApi("/api/tags");
    const names = ((tags.models as { name: string }[] | undefined) ?? []).map((m) => m.name);
    const has = (n: string) => names.includes(n) || names.includes(`${n}:latest`);
    if (has(LOCAL_MODEL)) status = { ready: true, model: LOCAL_MODEL };
    else if (has(LOCAL_BASE_MODEL)) {
      await createLocalModel();
      status = { ready: true, model: LOCAL_MODEL };
    } else status = { ready: false, reason: `${LOCAL_BASE_MODEL} not downloaded` };
  } catch {
    status = { ready: false, reason: "Ollama not running" };
  }
  cached = { at: Date.now(), status };
  return status;
}

/** Is the local model sitting in GPU memory right now? */
export async function localLoaded() {
  try {
    const ps = await ollamaApi("/api/ps");
    return ((ps.models as { name: string }[] | undefined) ?? []).some((m) => m.name.split(":")[0] === LOCAL_MODEL.split(":")[0]);
  } catch {
    return false;
  }
}

let warming: Promise<void> | null = null;
/**
 * Loads the local model (if needed) and keeps it in GPU memory for LOCAL_KEEP_ALIVE.
 * Called at startup and after every local reply, since each chat request
 * resets Ollama's timer to its 5-minute default.
 */
export function warmLocal(): Promise<void> {
  if (gpuLent()) return Promise.resolve();
  warming ??= localBrainStatus()
    .then((s) => (s.ready ? ollamaApi("/api/generate", { model: LOCAL_MODEL, keep_alive: LOCAL_KEEP_ALIVE }, 120_000) : null))
    .then(() => {})
    .catch(() => {})
    .finally(() => (warming = null));
  return warming;
}

/**
 * Lends the GPU to other local work (the local coding model needs all 12 GB): while lent, the
 * local brain stays unloaded and Haiku answers instead. Pass null to take the GPU back.
 */
const gpu = globalThis as unknown as { __sundayGpuLent?: string | null };
export function lendGpu(to: string | null) {
  gpu.__sundayGpuLent = to;
}
export function gpuLent() {
  return gpu.__sundayGpuLent ?? null;
}

/** Frees the ~10 GB of GPU memory the local model holds (games, Blender…). It reloads on next use. */
export async function unloadLocal() {
  await ollamaApi("/api/generate", { model: LOCAL_MODEL, keep_alive: 0 }, 30_000);
}

/** A failed local call: don't keep trying for a while. */
export function markLocalDown(reason: string) {
  cached = { at: Date.now(), status: { ready: false, reason } };
}

/** Forget the cached health check so the next call looks again. */
export function forgetLocalStatus() {
  cached = null;
}
