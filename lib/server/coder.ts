import "server-only";
import { query, type HookCallback, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import { lendGpu, ollamaApi, unloadLocal, warmLocal } from "./brains";
import { MODEL, OLLAMA_URL } from "./config";
import { logActivity } from "./db";
import { pushNotice } from "./notices";
import { recordCost } from "./spend";
import { openInVSCode } from "./tools/code";
import {
  FileToolError,
  assertOnAllowedDrive,
  assertWritable,
  backupPathFor,
  createFolder,
  realOrSelf,
  recordOp,
  resolveUserPath,
} from "./tools/files";

/**
 * SUNDAY's coding engine: the Claude Code agent (Anthropic's Agent SDK) working on one of
 * sir's projects in the background — reading, editing, running builds and tests, keeping a
 * todo list — while the coding panel shows what it's doing.
 *
 * SUNDAY's rules sit on top, in a PreToolUse hook that runs for every tool call (even ones
 * his own Claude Code settings would allow): nothing is ever deleted, files are only changed
 * inside the project (each overwritten file is backed up first, so undo works), and any
 * command that isn't routine waits for sir's Allow / Deny.
 */

const SONNET = "claude-sonnet-5-5";
/**
 * Free local coding on sir's GPU through Ollama, with a coding-sized context. Qwen3 14B (his local
 * brain's model) calls tools reliably; qwen2.5-coder:14b wrote its tool calls out as text instead.
 */
const LOCAL_CODER_BASE = process.env.SUNDAY_LOCAL_CODER_BASE ?? "qwen3:14b";
const LOCAL_CODER = process.env.SUNDAY_LOCAL_CODER ?? "sunday-coder-qwen3";
const LOCAL_CODER_CONTEXT = Number(process.env.SUNDAY_LOCAL_CODER_CONTEXT ?? 32768);
export type CodeModel = "best" | "quick" | "local";
const MAX_USD = Number(process.env.SUNDAY_CODE_MAX_USD ?? 5);
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type CodeEvent = { at: number; kind: "start" | "read" | "search" | "edit" | "create" | "run" | "web" | "agent" | "note" | "blocked" | "ask"; text: string };
type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };
type Pending = { id: string; tool: string; detail: string; reason: string; resolve: (ok: boolean) => void; at: number };

type Session = {
  id: string;
  goal: string;
  root: string;
  model: string;
  local: boolean;
  status: "starting" | "working" | "waiting" | "done" | "failed" | "stopped";
  startedAt: number;
  finishedAt?: number;
  now: string;
  todos: Todo[];
  events: CodeEvent[];
  files: Set<string>;
  commands: number;
  cost: number;
  summary?: string;
  error?: string;
  sdkSession?: string;
  pending?: Pending;
  abort: AbortController;
};

/** Quick code edits a brain makes directly (create a file, insert a function) — shown in the same panel. */
type Quick = {
  request: string;
  brain: string;
  startedAt: number;
  lastAt: number;
  events: CodeEvent[];
  files: Set<string>;
  folder: string;
  snippet?: { file: string; label: string; code: string };
  dismissed?: boolean;
};

const g = globalThis as unknown as { __sundayCoder?: { current: Session | null; quick?: Quick; lastSdkSession?: { root: string; id: string } } };
const state = (g.__sundayCoder ??= { current: null });

/* ───────── Command safety ───────── */

/** Words that delete or destroy — refused outright, whatever the context. */
const NEVER = /(^|[\s;&|(`])(rm|rmdir|rd|del|erase|unlink|shred|rimraf|trash|remove-item|ri|format|diskpart|shutdown|restart-computer|stop-computer|cipher)(?=[\s;&|)]|$)/i;
const NEVER_GIT = /\bgit\s+(clean|reset\s+--hard|push\s+(.*\s)?(-f|--force)|checkout\s+--\s|restore\s+(?!--staged)|branch\s+-D|stash\s+(drop|clear)|filter-branch|reflog\s+expire|gc\s+--prune)/i;
const NEVER_OTHER = /\b(find\b.*\s-delete|reg\s+delete|Clear-Content|Clear-RecycleBin|\bnpm\s+publish|\bdocker\s+(rm|rmi|system\s+prune))/i;

/** First words of commands that are routine for coding — they run without asking. */
const ROUTINE = new Set([
  "ls", "dir", "pwd", "cd", "echo", "cat", "type", "head", "tail", "wc", "find", "where", "which", "whoami", "sort", "grep", "rg", "tree",
  "git", "node", "npm", "pnpm", "yarn", "bun", "npx", "tsc", "eslint", "prettier", "vitest", "jest", "next", "vite",
  "python", "python3", "py", "pip", "pip3", "pytest", "uv", "poetry",
  "dotnet", "java", "javac", "mvn", "gradle", "mkdir", "md", "touch", "cp", "copy", "mv", "move",
  "get-childitem", "gci", "get-content", "gc", "select-string", "test-path", "write-output", "new-item", "get-location", "set-location",
  "code",
]);
/** Git subcommands that only look or add history. */
const GIT_OK = /^git\s+(status|diff|log|show|branch(?!\s+-D)|init|add|commit|checkout\s+-b|switch|stash(\s+(list|push|save))?$|rev-parse|remote(\s+-v)?$|config\s+--get|fetch|pull|clone|tag(\s+-l)?$|ls-files|blame|describe)/i;

function classify(command: string): { verdict: "allow" | "ask" | "deny"; reason: string } {
  const cmd = command.trim();
  if (NEVER.test(cmd) || NEVER_GIT.test(cmd) || NEVER_OTHER.test(cmd)) {
    return { verdict: "deny", reason: "SUNDAY never deletes or destroys anything — move things aside instead, or ask sir to do it himself." };
  }
  // "> file" overwrites without a backup (">>" appends, "2>&1" and "> nul" are harmless).
  if (/(^|[^>&\d])>(?![>&])(?!\s*(\/dev\/null|nul)\b)/i.test(cmd)) return { verdict: "ask", reason: "overwrites a file with >" };
  const parts = cmd.split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const words = part.replace(/^(\w+=\S+\s+)+/, "").split(/\s+/);
    const first = (words[0] ?? "").replace(/^\.\//, "").toLowerCase();
    if (first === "git" && !GIT_OK.test(part)) return { verdict: "ask", reason: `unusual git command: ${part}` };
    if (!ROUTINE.has(first)) return { verdict: "ask", reason: `not a routine command: ${words[0]}` };
  }
  return { verdict: "allow", reason: "routine" };
}

/* ───────── Path safety for edits ───────── */

const inside = (child: string, root: string) => {
  const c = path.resolve(child).toLowerCase();
  const r = path.resolve(root).toLowerCase().replace(/\\+$/, "");
  return c === r || c.startsWith(r + "\\");
};

async function backupBeforeChange(file: string) {
  if (existsSync(file)) {
    const backup = backupPathFor(file, "code");
    await fs.copyFile(file, backup);
    recordOp("overwrite", backup, file);
  } else {
    recordOp("create-file", "", file);
  }
}

/* ───────── Approvals ───────── */

function askSir(s: Session, tool: string, detail: string, reason: string) {
  return new Promise<boolean>((resolve) => {
    const id = randomBytes(6).toString("hex");
    const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      if (s.pending?.id === id) s.pending = undefined;
      if (s.status === "waiting") s.status = "working";
      resolve(ok);
    };
    s.pending = { id, tool, detail, reason, resolve: settle, at: Date.now() };
    s.status = "waiting";
    note(s, "ask", `Needs your OK: ${detail}`);
    pushNotice("SUNDAY — coding needs your OK", `Sir, the coding task wants to run: ${detail.slice(0, 140)}. Allow or deny it in the coding panel, or just tell me.`);
  });
}

export function answerApproval(allow: boolean) {
  const p = state.current?.pending;
  if (!p) throw new FileToolError("Nothing is waiting for approval.");
  logActivity("code", allow ? "approved" : "denied", p.detail.slice(0, 160));
  p.resolve(allow);
  return { [allow ? "allowed" : "denied"]: p.detail };
}

/* ───────── Live feed ───────── */

function note(s: Session, kind: CodeEvent["kind"], text: string) {
  s.events.push({ at: Date.now(), kind, text: text.slice(0, 220) });
  if (s.events.length > 120) s.events.splice(0, s.events.length - 120);
  if (kind !== "note") s.now = text.slice(0, 160);
}

const rel = (s: Session, p: unknown) => {
  const str = String(p ?? "");
  return str && inside(str, s.root) ? path.relative(s.root, str) || "." : str;
};

function describeTool(s: Session, name: string, input: Record<string, unknown>) {
  switch (name) {
    case "Read":
      return note(s, "read", `Reading ${rel(s, input.file_path)}`);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      s.files.add(rel(s, input.file_path ?? input.notebook_path));
      return note(s, "edit", `Editing ${rel(s, input.file_path ?? input.notebook_path)}`);
    case "Write":
      s.files.add(rel(s, input.file_path));
      return note(s, existsSync(String(input.file_path)) ? "edit" : "create", `Writing ${rel(s, input.file_path)}`);
    case "Bash":
    case "PowerShell":
      s.commands++;
      return note(s, "run", `$ ${String(input.command ?? "").split("\n")[0]}`);
    case "Glob":
      return note(s, "search", `Looking for ${input.pattern}`);
    case "Grep":
      return note(s, "search", `Searching for "${input.pattern}"`);
    case "WebFetch":
    case "WebSearch":
      return note(s, "web", `Looking up ${input.url ?? input.query}`);
    case "TodoWrite":
      s.todos = (input.todos as Todo[]) ?? s.todos;
      return;
    case "Task":
    case "Agent":
      return note(s, "agent", `Helper: ${input.description ?? "subtask"}`);
    default:
      return note(s, "note", name);
  }
}

function onMessage(s: Session, m: SDKMessage) {
  if (m.type === "system" && m.subtype === "init") {
    s.sdkSession = m.session_id;
    s.status = "working";
    note(s, "start", `Started in ${s.root}`);
    return;
  }
  if (m.type === "assistant" && !m.parent_tool_use_id) {
    for (const block of m.message.content) {
      if (block.type === "text" && block.text.trim()) note(s, "note", block.text.trim().split("\n")[0]);
      if (block.type === "tool_use") describeTool(s, block.name, (block.input ?? {}) as Record<string, unknown>);
    }
    return;
  }
  if (m.type === "result") {
    s.cost = s.local ? 0 : m.total_cost_usd; // the local coder is free whatever the SDK estimates
    recordCost("coding", s.cost);
    if (m.subtype === "success" && !m.is_error && s.local && !s.files.size && !s.commands && /"name"\s*:\s*"(Write|Edit|Bash|PowerShell|Read)"/.test(m.result)) {
      // It wrote its tool calls out as text instead of making them — nothing actually happened.
      s.status = "failed";
      s.error = "The local model described the changes instead of making them. Try again with the quick or best model.";
    } else if (m.subtype === "success" && !m.is_error) {
      s.status = "done";
      s.summary = m.result.trim();
    } else {
      s.status = "failed";
      s.error =
        m.subtype === "error_max_budget_usd"
          ? `Stopped at the $${MAX_USD} budget for one coding task.`
          : m.subtype === "error_max_turns"
            ? "Ran out of steps before finishing."
            : "The coding agent hit an error.";
      if (m.subtype === "success") s.summary = m.result.trim();
    }
  }
}

/* ───────── Starting work ───────── */

const RULES = `You are the coding engine of SUNDAY, sir's personal AI on his Windows PC. Work like an expert senior engineer: understand the project before changing it, match its conventions, make focused changes, and verify them (build, type-check, run the tests) before you say you're done.

Hard rules (enforced — attempts are refused):
- Never delete files or folders, and never run destructive commands (rm, del, Remove-Item, git clean, git reset --hard, force-push). If something must go, rename or move it aside, or tell sir.
- Only change files inside the project folder.
- Routine commands run straight away; anything unusual waits for sir's approval, so prefer standard tooling.

Keep your todo list (TodoWrite) up to date — sir watches it live. When you finish, end with 2–4 plain sentences: what you changed, how to run or see it, and anything he should decide or check. If you need a decision from him before you can continue, stop and ask it clearly in your final message.`;

/** Starts a coding task in the background. */
export async function startCoding(input: {
  goal: string;
  project?: string;
  newProjectIn?: string;
  newProjectName?: string;
  editor?: "vscode" | "visual_studio" | "none";
  model?: CodeModel;
  planOnly?: boolean;
  continuePrevious?: boolean;
}) {
  const local = input.model === "local";
  if (!local && !process.env.ANTHROPIC_API_KEY) throw new FileToolError("Coding needs the Anthropic API key.");
  const busy = state.current;
  if (busy && (busy.status === "working" || busy.status === "waiting" || busy.status === "starting")) {
    throw new FileToolError(`A coding task is already running ("${busy.goal.slice(0, 60)}"). Wait for it, add to it with continue_previous after it finishes, or stop it.`);
  }

  let root: string;
  if (input.newProjectName) {
    const parent = resolveUserPath(input.newProjectIn ?? "D:\\Projects");
    const name = input.newProjectName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim();
    root = path.win32.join(parent, name);
    if (existsSync(root) && readdirSync(root).length) throw new FileToolError(`${root} already exists and isn't empty — pick another name or work on it as an existing project.`);
    await createFolder(root);
  } else if (input.project) {
    root = resolveUserPath(input.project);
    if (!existsSync(root)) throw new FileToolError(`${root} doesn't exist. To start a new project, give new_project_name.`);
  } else {
    throw new FileToolError("Which project? Give project (an existing folder) or new_project_name.");
  }
  assertOnAllowedDrive(root);
  assertWritable(root);
  assertWritable(await realOrSelf(root));

  const s: Session = {
    id: randomBytes(4).toString("hex"),
    goal: input.goal.trim(),
    root,
    model: local ? LOCAL_CODER : input.model === "quick" ? SONNET : MODEL,
    local,
    status: "starting",
    startedAt: Date.now(),
    now: "Starting…",
    todos: [],
    events: [],
    files: new Set(),
    commands: 0,
    cost: 0,
    abort: new AbortController(),
  };
  state.current = s;
  logActivity("code", "started coding", `${s.goal.slice(0, 100)} — ${root}`);

  if (input.editor !== "none") void openEditor(root, input.editor ?? "vscode").catch((e) => note(s, "note", `Couldn't open the editor: ${e instanceof Error ? e.message : e}`));

  const resume = input.continuePrevious && state.lastSdkSession?.root.toLowerCase() === root.toLowerCase() ? state.lastSdkSession.id : undefined;
  void run(s, input.planOnly ?? false, resume);
  return {
    started: true,
    project: root,
    model: local ? `${LOCAL_CODER_BASE} on his GPU (free)` : s.model,
    budget: local ? "free" : `up to $${MAX_USD}`,
    note: "Working in the background — the coding panel shows progress live and I'll announce when it's done. Tell sir it's underway in a sentence; don't wait in silence.",
  };
}

async function run(s: Session, planOnly: boolean, resume?: string) {
  const guard: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const name = hookInput.tool_name;
    const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    const decide = (decision: "allow" | "deny", reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: decision, permissionDecisionReason: reason },
    });

    if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) {
      const file = String(input.file_path ?? input.notebook_path ?? "");
      if (!file || !inside(file, s.root)) {
        note(s, "blocked", `Refused: change outside the project (${file})`);
        return decide("deny", `Only files inside ${s.root} may be changed.`);
      }
      if (/[\\/]\.git[\\/]/i.test(file)) return decide("deny", "Don't edit git internals.");
      await backupBeforeChange(path.resolve(file)).catch(() => {});
      return decide("allow", "inside the project; backed up");
    }
    if (name === "Bash" || name === "PowerShell") {
      const command = String(input.command ?? "");
      const { verdict, reason } = classify(command);
      if (verdict === "deny") {
        note(s, "blocked", `Refused: ${command.split("\n")[0]}`);
        return decide("deny", reason);
      }
      if (verdict === "allow") return decide("allow", reason);
      const ok = await askSir(s, name, command.split("\n")[0].slice(0, 300), reason);
      if (!ok) note(s, "blocked", `Sir said no: ${command.split("\n")[0]}`);
      return ok ? decide("allow", "sir approved") : decide("deny", "Sir didn't approve this command. Find another way, or explain in your final message why it's needed.");
    }
    return {};
  };

  // Anything not settled above that Claude Code would prompt for: reads on his drives are fine, the rest goes to sir.
  const canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite"].includes(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const ok = await askSir(s, toolName, `${toolName} ${JSON.stringify(input).slice(0, 200)}`, "not covered by SUNDAY's rules");
    return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Sir didn't approve that." };
  };

  try {
    if (s.local) await prepareLocalCoder(s);
    const common = {
      cwd: s.root,
      model: s.model,
      permissionMode: planOnly ? ("plan" as const) : ("default" as const),
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [guard], timeout: Math.ceil(APPROVAL_TIMEOUT_MS / 1000) + 30 }] },
      abortController: s.abort,
      ...(resume ? { resume } : {}),
    };
    const q = query({
      prompt: s.goal,
      options: s.local
        ? {
            ...common,
            // A 14B model on 12 GB: fewer tools and a short brief leave room for the project itself.
            tools: ["Read", "Write", "Edit", "Bash", "PowerShell", "Glob", "Grep", "TodoWrite"],
            systemPrompt: `${localRules(s.root)}\n\n${RULES}`,
            settingSources: [],
            maxTurns: 40,
            thinking: { type: "disabled" }, // thinking costs a 14B model minutes per step
            env: localCoderEnv(),
          }
        : {
            ...common,
            effort: "high",
            systemPrompt: { type: "preset", preset: "claude_code", append: RULES },
            settingSources: ["user", "project"],
            maxBudgetUsd: MAX_USD,
            env: { ...process.env } as Record<string, string>,
          },
    });
    for await (const m of q) onMessage(s, m);
    if (s.status === "working" || s.status === "starting") s.status = "done";
  } catch (err) {
    if (s.abort.signal.aborted) s.status = "stopped";
    else {
      s.status = "failed";
      s.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
  } finally {
    s.pending?.resolve(false);
    s.finishedAt = Date.now();
    if (s.local) {
      // Give the GPU back to SUNDAY's everyday brain.
      await ollamaApi("/api/generate", { model: LOCAL_CODER, keep_alive: 0 }, 30_000).catch(() => {});
      lendGpu(null);
      void warmLocal();
    }
    if (s.sdkSession) state.lastSdkSession = { root: s.root, id: s.sdkSession };
    const mins = Math.max(1, Math.round((s.finishedAt - s.startedAt) / 60_000));
    logActivity("code", `coding ${s.status}`, `${s.goal.slice(0, 80)} — ${s.files.size} files, $${s.cost.toFixed(2)}`);
    const spoken =
      s.status === "done"
        ? `Sir, the coding task is done (${mins} min, ${s.files.size} file${s.files.size === 1 ? "" : "s"} changed). ${firstSentences(s.summary ?? "", 2)}`
        : s.status === "stopped"
          ? "Sir, I stopped the coding task."
          : `Sir, the coding task didn't finish: ${s.error ?? "unknown error"}`;
    pushNotice(`SUNDAY — coding ${s.status}`, spoken);
  }
}

const localRules = (root: string) =>
  `You are a careful coding assistant working in the folder ${root} on Windows. Use the tools to look before you change anything: list and read the relevant files first, then make small, exact edits with the Edit tool (or Write for new files). After changing code, run it or its build/tests to check it works. Keep the todo list short and current.`;

/** Makes sure the local coder exists (with a coding-sized context) and has the GPU to itself. */
async function prepareLocalCoder(s: Session) {
  note(s, "start", `Loading ${LOCAL_CODER_BASE} on your GPU (local brain steps aside)…`);
  lendGpu("local coding");
  await unloadLocal().catch(() => {});
  const tags = await ollamaApi("/api/tags").catch(() => {
    throw new Error("Ollama isn't running, so the local coder can't start.");
  });
  const names = ((tags.models as { name: string }[] | undefined) ?? []).map((m) => m.name);
  const has = (n: string) => names.includes(n) || names.includes(`${n}:latest`);
  if (!has(LOCAL_CODER)) {
    if (!has(LOCAL_CODER_BASE)) throw new Error(`${LOCAL_CODER_BASE} isn't downloaded in Ollama yet.`);
    await ollamaApi("/api/create", { model: LOCAL_CODER, from: LOCAL_CODER_BASE, parameters: { num_ctx: LOCAL_CODER_CONTEXT }, stream: false }, 120_000);
  }
  // Load it now so the first step doesn't time out while 9 GB moves into the GPU.
  await ollamaApi("/api/generate", { model: LOCAL_CODER, keep_alive: "30m" }, 180_000);
}

/** Points Claude Code at Ollama instead of Anthropic, with every model slot set to the local coder. */
function localCoderEnv() {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ANTHROPIC_API_KEY;
  return {
    ...env,
    ANTHROPIC_BASE_URL: OLLAMA_URL,
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_MODEL: LOCAL_CODER,
    ANTHROPIC_DEFAULT_OPUS_MODEL: LOCAL_CODER,
    ANTHROPIC_DEFAULT_SONNET_MODEL: LOCAL_CODER,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: LOCAL_CODER,
    ANTHROPIC_SMALL_FAST_MODEL: LOCAL_CODER,
    CLAUDE_CODE_SUBAGENT_MODEL: LOCAL_CODER,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

const firstSentences = (text: string, n: number) =>
  text
    .replace(/[#*`]/g, "")
    .split(/(?<=[.!?])\s+/)
    .slice(0, n)
    .join(" ")
    .slice(0, 400);

export function stopCoding() {
  const s = state.current;
  if (!s || !["starting", "working", "waiting"].includes(s.status)) throw new FileToolError("No coding task is running.");
  s.abort.abort();
  return { stopping: s.goal };
}

export function dismissCoding() {
  const s = state.current;
  if (s && ["done", "failed", "stopped"].includes(s.status)) state.current = null;
  if (state.quick) state.quick.dismissed = true;
}

const BRAIN_NAME: Record<string, string> = { local: "local brain", fast: "Haiku", deep: "Opus" };
const CODE_FILE = /\.(py|js|mjs|cjs|ts|tsx|jsx|html|css|scss|java|cs|cpp|c|h|go|rs|php|rb|sql|sh|ps1|bat|json|ya?ml|toml|xml)$/i;
const QUICK_WINDOW_MS = 3 * 60_000;

/** Records one direct code action for the panel; consecutive actions on the same request group together. */
export function recordQuickCode(e: { tool: string; input: Record<string, unknown>; result: unknown; request: string; brain: string }) {
  const file = String(e.input.path ?? (e.result as { path?: string } | null)?.path ?? e.input.folder ?? "");
  if (e.tool === "create_text_file" && !CODE_FILE.test(file)) return; // notes aren't coding
  const now = Date.now();
  let q = state.quick;
  if (!q || q.dismissed || now - q.lastAt > QUICK_WINDOW_MS || (e.request && q.request !== e.request && now - q.lastAt > 20_000)) {
    q = state.quick = { request: e.request, brain: BRAIN_NAME[e.brain] ?? e.brain, startedAt: now, lastAt: now, events: [], files: new Set(), folder: "" };
  }
  q.lastAt = now;
  q.brain = BRAIN_NAME[e.brain] ?? e.brain;
  if (e.request) q.request = e.request;
  const name = file ? path.basename(file) : "";
  if (file) q.folder = path.dirname(file);
  const push = (kind: CodeEvent["kind"], text: string) => {
    q!.events.push({ at: now, kind, text: text.slice(0, 220) });
    if (q!.events.length > 40) q!.events.splice(0, q!.events.length - 40);
  };
  const lines = (code: unknown) => String(code ?? "").split(/\r?\n/).length;
  switch (e.tool) {
    case "create_text_file":
    case "write_file":
      q.files.add(name);
      push("create", `Wrote ${name} (${lines(e.input.content)} lines)`);
      q.snippet = { file: name, label: "new file", code: String(e.input.content ?? "") };
      break;
    case "insert_code": {
      const at = (e.result as { inserted_at_line?: number })?.inserted_at_line;
      q.files.add(name);
      push("edit", `Added ${lines(e.input.code)} lines to ${name}${at ? ` at line ${at}` : ""}`);
      q.snippet = { file: name, label: at ? `added at line ${at}` : "added", code: String(e.input.code ?? "") };
      break;
    }
    case "edit_file": {
      const at = (e.result as { line?: number })?.line;
      q.files.add(name);
      push("edit", `Changed ${name}${at ? ` at line ${at}` : ""}`);
      q.snippet = { file: name, label: at ? `changed at line ${at}` : "changed", code: String(e.input.new_text ?? "") };
      break;
    }
    case "read_code":
      push("read", `Read ${name}`);
      break;
    case "search_in_files":
      push("search", `Searched for "${e.input.query}"`);
      break;
    case "open_in_vscode":
      push("note", `Opened ${name || "the project"} in VS Code`);
      break;
  }
}

function quickView(q: Quick) {
  const working = Date.now() - q.lastAt < 8000;
  return {
    active: true as const,
    kind: "quick" as const,
    goal: q.request || "Quick code edit",
    project: q.folder,
    model: q.brain,
    status: working ? ("working" as const) : ("done" as const),
    startedAt: q.startedAt,
    finishedAt: working ? null : q.lastAt,
    now: q.events.at(-1)?.text ?? "",
    todos: [] as Todo[],
    events: q.events.slice(-8),
    files: [...q.files],
    commands: 0,
    cost: 0,
    summary: null,
    error: null,
    pending: null,
    snippet: q.snippet ?? null,
  };
}

/** What the coding panel and SUNDAY see. */
export function codingState() {
  const s = state.current;
  const q = state.quick;
  const busy = s && ["starting", "working", "waiting"].includes(s.status);
  // A recent quick edit shows unless a full coding task is running (or newer).
  if (q && !q.dismissed && !busy && Date.now() - q.lastAt < QUICK_WINDOW_MS && (!s || q.lastAt > (s.finishedAt ?? 0))) return quickView(q);
  if (!s) return { active: false as const };
  return {
    active: true as const,
    kind: "task" as const,
    snippet: null,
    goal: s.goal,
    project: s.root,
    model: s.model,
    status: s.status,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt ?? null,
    now: s.now,
    todos: s.todos,
    events: s.events.slice(-14),
    files: [...s.files].slice(-30),
    commands: s.commands,
    cost: Math.round(s.cost * 100) / 100,
    summary: s.summary ?? null,
    error: s.error ?? null,
    pending: s.pending ? { tool: s.pending.tool, detail: s.pending.detail, reason: s.pending.reason } : null,
  };
}

/** One line for SUNDAY's context while a coding task exists. */
export function codingLine() {
  const s = state.current;
  if (!s) return "";
  const t = s.todos.length ? ` — todo ${s.todos.filter((x) => x.status === "completed").length}/${s.todos.length}` : "";
  if (s.status === "waiting") return `Coding: WAITING for sir's OK to run "${s.pending?.detail.slice(0, 80)}" (code_approve once he answers).`;
  if (s.status === "working" || s.status === "starting") return `Coding: working on "${s.goal.slice(0, 70)}" in ${s.root}${t}; now: ${s.now.slice(0, 80)}.`;
  return `Coding: last task ${s.status} ("${s.goal.slice(0, 60)}", ${s.files.size} files)${s.summary ? ` — ${firstSentences(s.summary, 1)}` : ""}`;
}

/* ───────── Editors & the dev environment ───────── */

function devenvPath() {
  for (const base of ["C:\\Program Files\\Microsoft Visual Studio", "C:\\Program Files (x86)\\Microsoft Visual Studio"]) {
    try {
      for (const year of readdirSync(base)) {
        for (const edition of readdirSync(path.join(base, year))) {
          const exe = path.join(base, year, edition, "Common7", "IDE", "devenv.exe");
          if (existsSync(exe)) return exe;
        }
      }
    } catch {}
  }
  return null;
}

async function openEditor(root: string, editor: "vscode" | "visual_studio") {
  if (editor === "visual_studio") {
    const exe = devenvPath();
    if (!exe) throw new Error("Visual Studio isn't installed.");
    const sln = readdirSync(root).find((f) => /\.(sln|slnx|csproj)$/i.test(f));
    const { spawn } = await import("node:child_process");
    spawn(exe, [sln ? path.join(root, sln) : root], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  await openInVSCode(root);
}

const version = (cmd: string, args: string[]) =>
  new Promise<string | null>((resolve) =>
    execFile(cmd, args, { timeout: 8000, windowsHide: true, shell: true }, (err, out, errOut) =>
      resolve(err ? null : (out || errOut).trim().split(/\r?\n/)[0].slice(0, 80)),
    ),
  );

/** What sir's PC can build with — for "check the system" before starting a project. */
export async function devEnvironment(project?: string) {
  const [node, npm, git, python, dotnet, java, code] = await Promise.all([
    version("node", ["--version"]),
    version("npm", ["--version"]),
    version("git", ["--version"]),
    version("python", ["--version"]),
    version("dotnet", ["--version"]),
    version("java", ["-version"]),
    version("code", ["--version"]),
  ]);
  const out: Record<string, unknown> = {
    node, npm, git, python, dotnet, java,
    vscode: code,
    visual_studio: devenvPath(),
  };
  if (project) {
    const root = resolveUserPath(project);
    if (existsSync(root)) {
      const files = readdirSync(root);
      out.project = {
        path: root,
        kind: [
          files.includes("package.json") && "Node/JavaScript",
          files.some((f) => /\.(sln|csproj)$/i.test(f)) && ".NET",
          (files.includes("pyproject.toml") || files.includes("requirements.txt")) && "Python",
          (files.includes("pom.xml") || files.includes("build.gradle")) && "Java",
        ].filter(Boolean),
        git: files.includes(".git") ? await version("git", ["-C", root, "status", "--short", "--branch"]) : "not a git repo",
      };
    }
  }
  return out;
}
