import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { z } from "zod";
import { reindexNow, searchIndex } from "../indexer";
import { listSkills, loadSkill } from "../skills";
import {
  MEMORY_CATEGORIES,
  recallMemories,
  saveMemory,
  searchPastConversations,
} from "../memory";
import { browserSearch, openApplication, openPath, openUrl } from "./apps";
import {
  createFolder,
  fileInfo,
  listDirectory,
  moveItems,
  readTextFile,
  renameItem,
  undoFileOperations,
} from "./files";
import { editFile, openInVSCode, readCode, searchInFiles, vscodeWorkspaces, writeFile } from "./code";
import {
  closeApplication,
  lockPc,
  mediaControl,
  power,
  readClipboard,
  showDesktop,
  systemStatus,
  volume,
  writeClipboard,
} from "./system";
import { logActivity } from "../db";
import { createDraft, gmailAccount, readEmail, searchEmail, triageEmail } from "./gmail";
import { computerTask } from "../computer";
import { createDocument } from "../documents";
import { cancelReminder, createReminder, listReminders, markBriefed, todaysReminders, weather } from "../reminders";

export type ToolContext = {
  conversationId: string;
  /** Ask SUNDAY's window for something only the desktop app can do (e.g. "screenshot"). */
  requestClient: <T>(kind: string, payload?: unknown) => Promise<T>;
  /** Fires when sir interrupts or sends something new. */
  signal?: AbortSignal;
};
export type ToolImage = { data: string; mediaType: "image/jpeg" | "image/png" };
export type ToolOutcome = { result: unknown; activate: string[]; image?: ToolImage };

type ToolDef<S extends z.ZodObject> = {
  name: string;
  hub: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome | unknown>;
};

const dirId = (p: string) => `dir:${p.toLowerCase()}`;
const browser = z.enum(["firefox", "chrome", "edge", "brave", "default"]).optional();

function def<S extends z.ZodObject>(d: ToolDef<S>) {
  return d as unknown as ToolDef<z.ZodObject>;
}

const TOOLS = [
  def({
    name: "remember",
    hub: "memory",
    description:
      "Save a durable fact about sir to long-term memory (identity, preferences, people, projects, routines, events). Use when he tells you something worth knowing next week, or explicitly asks you to remember.",
    schema: z.object({
      fact: z.string().describe("Self-contained fact, e.g. 'Sir's sister is called Ana and lives in Tirana.'"),
      category: z.enum(MEMORY_CATEGORIES),
      importance: z.number().int().min(1).max(5).describe("1 trivia … 5 core"),
    }),
    run: async ({ fact, category, importance }, ctx) => {
      const id = saveMemory(fact, category, importance, ctx.conversationId);
      return { result: { saved: true, id }, activate: [`cat:${category}`] };
    },
  }),
  def({
    name: "recall",
    hub: "memory",
    description:
      "Search long-term memory and past conversations. Use before saying you don't know something about sir, or when he refers to something from before.",
    schema: z.object({ query: z.string() }),
    run: async ({ query }, ctx) => {
      const memories = recallMemories(query, 10);
      const conversations = searchPastConversations(query, ctx.conversationId, 6).map((c) => ({
        when: new Date(c.created_at).toISOString().slice(0, 16).replace("T", " "),
        who: c.role === "user" ? "sir" : "you",
        excerpt: c.snippet,
      }));
      return {
        result: { memories: memories.map((m) => ({ fact: m.content, category: m.category })), conversations },
        activate: memories.map((m) => `mem:${m.id}`),
      };
    },
  }),
  def({
    name: "search_files",
    hub: "files",
    description:
      "Find files or folders by name across sir's drives using the file index. Supports filtering by drive, extension and kind. Results are verified to still exist.",
    schema: z.object({
      query: z.string().describe("Words from the file or folder name. May be empty when filtering by extension."),
      drive: z.string().optional().describe("Drive letter like 'D'"),
      extension: z.string().optional().describe("e.g. 'pdf', 'mp4'"),
      kind: z.enum(["file", "folder", "any"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    run: async ({ query, ...opts }) => {
      const results = searchIndex(query, opts);
      return { result: { count: results.length, results }, activate: [] };
    },
  }),
  def({
    name: "list_directory",
    hub: "files",
    description: "List what's inside a folder. Accepts absolute paths, drive letters ('D:'), or known names like 'Downloads'.",
    schema: z.object({ path: z.string(), limit: z.number().int().min(1).max(500).optional() }),
    run: async ({ path: p, limit }) => {
      const listing = await listDirectory(p, limit);
      return { result: listing, activate: [dirId(listing.path)] };
    },
  }),
  def({
    name: "file_info",
    hub: "files",
    description: "Get size, dates and type of a file or folder.",
    schema: z.object({ path: z.string() }),
    run: async ({ path: p }) => fileInfo(p),
  }),
  def({
    name: "read_file",
    hub: "files",
    description: "Read the text contents of a file (code, notes, csv, json, txt, md…). Binary files are reported, not read.",
    schema: z.object({ path: z.string() }),
    run: async ({ path: p }) => readTextFile(p),
  }),
  def({
    name: "create_folder",
    hub: "files",
    description: "Create a new folder (parents are created too). Cannot be used inside Windows or Program Files.",
    schema: z.object({ path: z.string() }),
    run: async ({ path: p }) => {
      const r = await createFolder(p);
      return { result: r, activate: [dirId(path.win32.dirname(r.path))] };
    },
  }),
  def({
    name: "move_items",
    hub: "files",
    description:
      "Move files and/or folders into a destination folder (created if missing). Never overwrites — clashing names get ' (2)'. Works across drives. Every move can be undone. There is no delete.",
    schema: z.object({
      sources: z.array(z.string()).min(1).max(500),
      destination_folder: z.string(),
    }),
    run: async ({ sources, destination_folder }) => {
      const r = await moveItems(sources, destination_folder);
      return { result: r, activate: [dirId(r.destination)] };
    },
  }),
  def({
    name: "rename_item",
    hub: "files",
    description: "Rename a file or folder in place. Can be undone.",
    schema: z.object({ path: z.string(), new_name: z.string() }),
    run: async ({ path: p, new_name }) => renameItem(p, new_name),
  }),
  def({
    name: "undo_file_operations",
    hub: "files",
    description: "Undo the most recent moves, renames and file edits SUNDAY made, newest first (edited files are restored from backup).",
    schema: z.object({ count: z.number().int().min(1).max(200).optional() }),
    run: async ({ count }) => undoFileOperations(count ?? 1),
  }),
  def({
    name: "refresh_file_index",
    hub: "files",
    description: "Re-scan all drives in the background so new files become searchable.",
    schema: z.object({}),
    run: async () => {
      reindexNow();
      return { started: true };
    },
  }),
  def({
    name: "look_at_screen",
    hub: "screen",
    description:
      "See what's on sir's screen right now (the monitor his mouse is on; SUNDAY's own window is hidden from the capture). Use whenever he refers to something visible — 'this', 'that error', 'what am I looking at', 'read this', 'what do you think of this design'. Say what's relevant to his question, not a description of everything.",
    schema: z.object({ focus: z.string().optional().describe("What he wants you to look at, if he said") }),
    run: async ({ focus }, ctx) => {
      const shot = await ctx.requestClient<{ data?: string; width?: number; height?: number; error?: string }>("screenshot");
      if (!shot?.data) return { result: { error: shot?.error ?? "I couldn't capture the screen." }, activate: ["hub:screen"] };
      logActivity("screen", "looked at the screen", focus);
      return {
        result: { captured: `${shot.width}x${shot.height} screenshot attached`, focus: focus ?? null },
        activate: ["hub:screen"],
        image: { data: shot.data, mediaType: "image/jpeg" },
      };
    },
  }),
  def({
    name: "read_clipboard",
    hub: "screen",
    description: "Read the text sir has copied (Ctrl+C). Use when he says 'what I copied', 'this text', 'translate/fix/summarise what's in my clipboard'.",
    schema: z.object({}),
    run: async () => readClipboard(),
  }),
  def({
    name: "write_clipboard",
    hub: "screen",
    description: "Put text on sir's clipboard so he can paste it with Ctrl+V — for a rewritten paragraph, a command, code, an address. Tell him it's ready to paste.",
    schema: z.object({ text: z.string().min(1).max(100_000) }),
    run: async ({ text }) => writeClipboard(text),
  }),
  def({
    name: "media_control",
    hub: "pc",
    description: "Play/pause, next track, previous track or stop — works with Spotify, YouTube in the browser and most players.",
    schema: z.object({ action: z.enum(["play_pause", "next", "previous", "stop"]) }),
    run: async ({ action }) => mediaControl(action),
  }),
  def({
    name: "volume",
    hub: "pc",
    description: "Read or change the PC's master volume: get, set (level 0-100), up/down (by step, default 10), mute, unmute.",
    schema: z.object({
      action: z.enum(["get", "set", "up", "down", "mute", "unmute"]),
      level: z.number().int().min(0).max(100).optional(),
      step: z.number().int().min(1).max(50).optional(),
    }),
    run: async ({ action, level, step }) => volume(action, level, step),
  }),
  def({
    name: "system_status",
    hub: "pc",
    description: "PC health: CPU load, RAM use, disk space on each drive, uptime, battery, and the apps using the most memory.",
    schema: z.object({}),
    run: async () => systemStatus(),
  }),
  def({
    name: "lock_pc",
    hub: "pc",
    description: "Lock Windows right away (SUNDAY locks with it).",
    schema: z.object({}),
    run: async () => lockPc(),
  }),
  def({
    name: "show_desktop",
    hub: "pc",
    description: "Minimise all windows to show the desktop.",
    schema: z.object({}),
    run: async () => showDesktop(),
  }),
  def({
    name: "power",
    hub: "pc",
    description:
      "Shut down, restart or sleep the PC, or cancel a pending shutdown/restart. NEVER act on the first request: ask sir to confirm out loud ('Shut down now, sir? Anything unsaved will close.'), and only after a clear yes call it with confirmed=true. Shutdown/restart wait delay_minutes (default 1) so he can still cancel.",
    schema: z.object({
      action: z.enum(["shutdown", "restart", "sleep", "cancel"]),
      confirmed: z.boolean(),
      delay_minutes: z.number().min(0).max(240).optional(),
    }),
    run: async ({ action, confirmed, delay_minutes }) => power(action, confirmed, delay_minutes ?? 1),
  }),
  def({
    name: "close_application",
    hub: "pc",
    description:
      "Close an app's windows politely, like clicking X (e.g. 'close Spotify'). Apps with unsaved work will ask him to save. Never force-quits.",
    schema: z.object({ name: z.string().min(2) }),
    run: async ({ name }) => closeApplication(name),
  }),
  def({
    name: "computer_task",
    hub: "pc",
    description:
      "Operate the PC like a person — sees the screen, moves the mouse, clicks, scrolls and types — for things no other tool can do: working inside an app's UI, changing an app's setting, filling in a form, navigating a site he's signed in to. Prefer the dedicated tools when they fit (open_application, open_url, files, media, volume, email) — they're faster and safer. Give a complete goal with every detail needed. Sir watches; moving his mouse, saying stop or pressing Ctrl+Shift+Space takes control back. It never types passwords, deletes, pays or changes security settings. If it returns needs_approval, ask sir its question; only after a clear yes call again with the same goal and approved_step set to that step. Desktop app only.",
    schema: z.object({
      goal: z.string().min(8).describe("What to achieve, with all details (names, text to type, where to save…)"),
      approved_step: z.string().optional().describe("A step sir explicitly approved after a needs_approval"),
    }),
    run: async ({ goal, approved_step }, ctx) => computerTask({ goal, approvedStep: approved_step }, ctx),
  }),
  def({
    name: "set_reminder",
    hub: "time",
    description:
      "Set a reminder that SUNDAY will announce out loud (and as a Windows notification) at a specific time. Use 'at' for a clock time — a LOCAL date-time 'YYYY-MM-DDTHH:mm' worked out from the current time in your context — or 'in_minutes' for relative times ('in 2 hours' = 120).",
    schema: z.object({
      text: z.string().describe("What to remind him of, phrased to be read back, e.g. 'call the bank'"),
      at: z.string().optional(),
      in_minutes: z.number().positive().max(60 * 24 * 366).optional(),
    }),
    run: async ({ text, at, in_minutes }) => {
      const r = createReminder({ kind: "reminder", text, at, inMinutes: in_minutes });
      return { result: r, activate: ["hub:time"] };
    },
  }),
  def({
    name: "set_timer",
    hub: "time",
    description: "Start a countdown timer ('5 minute timer', 'timer for the pasta'). SUNDAY announces it when it ends.",
    schema: z.object({
      minutes: z.number().positive().max(24 * 60),
      label: z.string().optional().describe("What the timer is for"),
    }),
    run: async ({ minutes, label }) => createReminder({ kind: "timer", text: label?.trim() || `${minutes} minute timer`, inMinutes: minutes }),
  }),
  def({
    name: "list_reminders",
    hub: "time",
    description: "List pending reminders and timers (with ids), optionally including ones that fired in the last day.",
    schema: z.object({ include_recent: z.boolean().optional() }),
    run: async ({ include_recent }) => listReminders(include_recent ?? false),
  }),
  def({
    name: "cancel_reminder",
    hub: "time",
    description: "Cancel a pending reminder or timer by id (get ids from list_reminders).",
    schema: z.object({ id: z.number().int() }),
    run: async ({ id }) => cancelReminder(id),
  }),
  def({
    name: "get_weather",
    hub: "web",
    description: "Current weather and today's forecast. Pass city the first time (it's remembered as sir's home city); omit it afterwards.",
    schema: z.object({ city: z.string().optional() }),
    run: async ({ city }) => weather(city),
  }),
  def({
    name: "morning_briefing",
    hub: "time",
    description:
      "Gather sir's morning briefing: date, weather, today's reminders, and the important unread emails. Use when he says good morning or asks for his briefing/rundown of the day, then deliver it conversationally — weather in a line, then what's on today, then anything urgent in the inbox.",
    schema: z.object({ city: z.string().optional().describe("Only if he names a city or none is remembered yet") }),
    run: async ({ city }) => {
      const [w, mail] = await Promise.all([
        weather(city).catch((e) => ({ error: String(e) })),
        gmailAccount()
          ? triageEmail("is:unread newer_than:2d", 20)
              .then((t) => ({
                unread: t.count,
                important: t.emails.filter((e) => "urgency" in e && (e.urgency === "today" || e.urgency === "this week")).slice(0, 5),
              }))
              .catch((e) => ({ error: String(e) }))
          : Promise.resolve({ note: "Gmail not connected" }),
      ]);
      markBriefed();
      return {
        result: {
          date: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
          weather: w,
          reminders_today: todaysReminders(),
          email: mail,
        },
        activate: ["hub:time", "hub:mail", "hub:web"],
      };
    },
  }),
  def({
    name: "create_document",
    hub: "docs",
    description:
      "Make a real Word (docx), Excel (xlsx), PowerPoint (pptx) or PDF file — reports, letters, CVs, budgets, trackers, pitch decks, invoices. Runs in the background (1-3 min) and SUNDAY announces it when ready; saved in Documents\\SUNDAY Documents unless he names a folder. Put everything that matters into request: purpose, audience, structure, facts, numbers, tone, length/slide count. sources = his files to build from (any type: xlsx, csv, docx, pdf, txt…; max 5). Never overwrites anything.",
    schema: z.object({
      format: z.enum(["docx", "xlsx", "pptx", "pdf"]),
      request: z.string().min(10).describe("A complete brief, including any facts from the conversation"),
      filename: z.string().optional().describe("Name without extension, if he gave one"),
      folder: z.string().optional(),
      sources: z.array(z.string()).max(5).optional(),
      open_when_ready: z.boolean().optional().describe("Open it as soon as it's done (when he says 'and open it')"),
    }),
    run: async ({ format, request, filename, folder, sources, open_when_ready }) => ({
      result: await createDocument({ format, request, filename, folder, sources, openWhenReady: open_when_ready }),
      activate: ["hub:docs"],
    }),
  }),
  def({
    name: "list_skills",
    hub: "skills",
    description:
      "List the expert guides (skills) sir has installed — design, animation, frontend taste, TypeSafe, Cloudflare and more — with a one-line description each.",
    schema: z.object({}),
    run: async () => ({
      result: listSkills().map((s) => ({ name: s.name, description: s.description })),
      activate: [],
    }),
  }),
  def({
    name: "use_skill",
    hub: "skills",
    description:
      "Load a skill's full guide (or one of its reference files via `file`) and follow it for the current task. Load a skill whenever a coding or design task matches its description, before you start the work.",
    schema: z.object({ name: z.string(), file: z.string().optional().describe("A reference file listed in otherFiles") }),
    run: async ({ name, file }) => ({ result: loadSkill(name, file), activate: [`guide:${name.toLowerCase()}`] }),
  }),
  def({
    name: "vscode_workspaces",
    hub: "code",
    description:
      "List the folders sir has open (or last had open) in VS Code — use this to find 'the project I'm working on'.",
    schema: z.object({}),
    run: async () => vscodeWorkspaces(),
  }),
  def({
    name: "read_code",
    hub: "code",
    description:
      "Read a code/text file WITH line numbers, optionally a line range (start_line/end_line). Always read before editing. Shows up to 800 lines per call.",
    schema: z.object({
      path: z.string(),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    }),
    run: async ({ path: p, start_line, end_line }) => readCode(p, start_line, end_line),
  }),
  def({
    name: "search_in_files",
    hub: "code",
    description:
      "Find text inside files of a project folder (like grep): where a function is defined, where a string is used. Skips node_modules, .git and build output.",
    schema: z.object({
      folder: z.string(),
      query: z.string(),
      extension: z.string().optional().describe("e.g. 'ts', 'py'"),
      max_results: z.number().int().min(1).max(100).optional(),
    }),
    run: async ({ folder, query, extension, max_results }) => searchInFiles(folder, query, extension, max_results),
  }),
  def({
    name: "edit_file",
    hub: "code",
    description:
      "Change part of a file by replacing an exact snippet (old_text) with new_text, then save. old_text must match the file exactly (copy it from read_code without the line-number prefix) and be unique unless replace_all is true. The previous version is backed up automatically and undo_file_operations restores it.",
    schema: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    }),
    run: async ({ path: p, old_text, new_text, replace_all }) => {
      const r = await editFile(p, old_text, new_text, replace_all ?? false);
      return { result: r, activate: [`code:${r.path.toLowerCase()}`] };
    },
  }),
  def({
    name: "write_file",
    hub: "code",
    description:
      "Create a new file with the given content and save it. To replace an existing file entirely set overwrite=true (the old version is backed up). Prefer edit_file for changes to existing files.",
    schema: z.object({ path: z.string(), content: z.string(), overwrite: z.boolean().optional() }),
    run: async ({ path: p, content, overwrite }) => {
      const r = await writeFile(p, content, overwrite ?? false);
      return { result: r, activate: [`code:${r.path.toLowerCase()}`] };
    },
  }),
  def({
    name: "open_in_vscode",
    hub: "code",
    description: "Open a file (optionally at a line) or a folder in VS Code so sir can see it. Use after editing, at the changed line.",
    schema: z.object({ path: z.string(), line: z.number().int().min(1).optional() }),
    run: async ({ path: p, line }) => {
      const r = await openInVSCode(p, line);
      return { result: r, activate: [`code:${r.opened.toLowerCase()}`] };
    },
  }),
  def({
    name: "open_application",
    hub: "apps",
    description:
      "Open a program installed on this PC by name: e.g. 'Firefox', 'Chrome', 'Command Prompt', 'PowerShell', 'Terminal', 'Program Files', 'Spotify', 'Visual Studio Code', 'Settings', 'Task Manager'. Set admin=true only when sir asks for administrator mode.",
    schema: z.object({ name: z.string(), admin: z.boolean().optional() }),
    run: async ({ name, admin }) => {
      const r = await openApplication(name, admin ?? false);
      return { result: r, activate: [`app:${r.opened.toLowerCase()}`] };
    },
  }),
  def({
    name: "open_path",
    hub: "files",
    description:
      "Open a file with its default app or a folder in File Explorer. reveal=true opens Explorer with the item selected instead.",
    schema: z.object({ path: z.string(), reveal: z.boolean().optional() }),
    run: async ({ path: p, reveal }) => {
      const r = await openPath(p, reveal ?? false);
      return { result: r, activate: [dirId(r.kind === "folder" ? r.opened : path.win32.dirname(r.opened))] };
    },
  }),
  def({
    name: "browser_search",
    hub: "web",
    description:
      "Open a web browser on sir's screen with search results. Default browser is Firefox. Engines: google, youtube, bing, duckduckgo, wikipedia, maps, github, amazon.",
    schema: z.object({
      query: z.string(),
      engine: z.enum(["google", "youtube", "bing", "duckduckgo", "wikipedia", "maps", "github", "amazon"]).optional(),
      browser,
    }),
    run: async ({ query, engine, browser: b }) => {
      const r = await browserSearch(query, engine ?? "google", b);
      return { result: r, activate: [`web:${new URL(r.opened).hostname}`] };
    },
  }),
  def({
    name: "open_url",
    hub: "web",
    description:
      "Open a specific website in the browser (Firefox by default). Also opens a Windows Settings page directly with an ms-settings: link (ms-settings:display, ms-settings:bluetooth, ms-settings:sound, ms-settings:windowsupdate…).",
    schema: z.object({ url: z.string(), browser }),
    run: async ({ url, browser: b }) => {
      const r = await openUrl(url, b);
      return { result: r, activate: "app" in r ? ["hub:pc"] : [`web:${new URL(r.opened).hostname}`] };
    },
  }),
  def({
    name: "email_search",
    hub: "mail",
    description:
      "Search sir's Gmail with Gmail query syntax (e.g. 'is:unread newer_than:2d', 'from:anna subject:invoice'). Returns sender, subject, date, snippet and id.",
    schema: z.object({ query: z.string(), max: z.number().int().min(1).max(25).optional() }),
    run: async ({ query, max }) => searchEmail(query, max ?? 10),
  }),
  def({
    name: "email_triage",
    hub: "mail",
    description:
      "Go through sir's inbox and rank what matters: every email is scored for urgency (ignore / fyi / this week / today), whether it needs his reply, and its category, sorted most urgent first. Use for 'what's important in my inbox?', 'anything urgent?', 'what do I need to reply to?'. Default query is unread mail from the last 7 days.",
    schema: z.object({
      query: z.string().optional().describe("Gmail query; default 'is:unread newer_than:7d'"),
      max: z.number().int().min(1).max(25).optional(),
    }),
    run: async ({ query, max }) => triageEmail(query ?? undefined, max ?? 25),
  }),
  def({
    name: "email_read",
    hub: "mail",
    description: "Read the full text of one email by id (from email_search).",
    schema: z.object({ id: z.string() }),
    run: async ({ id }) => readEmail(id),
  }),
  def({
    name: "email_create_draft",
    hub: "mail",
    description:
      "Write an email as a Gmail DRAFT for sir to review and send himself. You cannot send email. For replies pass reply_to_message_id so it threads correctly.",
    schema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string().describe("Plain text body, signed off naturally"),
      cc: z.string().optional(),
      reply_to_message_id: z.string().optional(),
    }),
    run: async ({ to, subject, body, cc, reply_to_message_id }) =>
      createDraft({ to, subject, body, cc, replyToMessageId: reply_to_message_id }),
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function toolHub(name: string) {
  return byName.get(name)?.hub ?? "skills";
}

export function toolSchemas(): Anthropic.Beta.BetaToolUnion[] {
  const custom = TOOLS.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    } satisfies Anthropic.Beta.BetaTool;
  });
  return [
    ...custom,
    { type: "web_search_20260209", name: "web_search", max_uses: 3 } as Anthropic.Beta.BetaToolUnion,
    // Lets her read documentation pages a skill points to (only URLs already in the conversation).
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 } as Anthropic.Beta.BetaToolUnion,
  ];
}

export function isOutcome(v: unknown): v is ToolOutcome {
  return typeof v === "object" && v !== null && "result" in v && "activate" in v;
}

export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ ok: boolean; result: unknown; activate: string[]; image?: ToolImage }> {
  const tool = byName.get(name);
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}` }, activate: [] };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, result: { error: "INVALID_INPUT", issues: parsed.error.issues.slice(0, 5) }, activate: [] };
  }
  const base = [`skill:${name}`, `hub:${tool.hub}`];
  try {
    const out = await tool.run(parsed.data, ctx);
    if (isOutcome(out)) return { ok: true, result: out.result, activate: [...base, ...out.activate], image: out.image };
    return { ok: true, result: out, activate: base };
  } catch (err) {
    return { ok: false, result: { error: err instanceof Error ? err.message : String(err) }, activate: base };
  }
}

export const TOOL_CATALOG = TOOLS.map((t) => ({ name: t.name, hub: t.hub }));
