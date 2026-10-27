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
  FileToolError,
  listDirectory,
  moveItems,
  readTextFile,
  renameItem,
  resolveUserPath,
  undoFileOperations,
  uniqueTarget,
} from "./files";
import { editFile, insertCode, openInVSCode, readCode, searchInFiles, vscodeWorkspaces, writeFile } from "./code";
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
import { BRAIN_LABEL, setBrainMode, type Brain } from "../brains";
import { brainDiagnostics, repairBrain } from "../diagnostics";
import { computerTask } from "../computer";
import { createDocument } from "../documents";
import { ASPECT_RATIOS, generateImage, saveImages, sirNamedPlace } from "../images";
import { addEvent, calendarReady, changeEvent, listEvents, todaysEvents } from "../calendar";
import { addTasks, changeTask, completeTasks, listTasks, tasksForToday } from "../tasks";
import { answerApproval, codingState, devEnvironment, recordQuickCode, startCoding, stopCoding } from "../coder";
import { blenderImport, blenderLook, blenderRun, blenderSave, blenderScene, openBlender } from "../blender";
import { cancelReminder, createReminder, listReminders, markBriefed, todaysReminders, weather } from "../reminders";

export type ToolContext = {
  conversationId: string;
  /** Ask SUNDAY's window for something only the desktop app can do (e.g. "screenshot"). */
  requestClient: <T>(kind: string, payload?: unknown) => Promise<T>;
  /** Fires when sir interrupts or sends something new. */
  signal?: AbortSignal;
  /** Sir's own words this turn, and SUNDAY's reply before them — for tools that may act only on what he said. */
  userText?: string;
  lastReply?: string;
  /** Where the request came from — "telegram" means sir's phone. */
  channel?: Channel;
  /** Which brain is calling (the local brain's coding jobs default to the free local engine). */
  brain?: Brain;
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
    name: "create_text_file",
    hub: "files",
    description:
      "Create a new text or code file with its content — a note (.txt by default, .md), or source code (.py, .js, .ts, .html, .css, .java, .cs, .json…). Its folder is created if missing. Never overwrites: a taken name gets ' (2)'. Undo removes it. After creating code, open_in_vscode shows it to sir.",
    schema: z.object({ path: z.string(), content: z.string().default("") }),
    run: async ({ path: p, content }) => {
      let target = resolveUserPath(p);
      const ext = path.win32.extname(target).toLowerCase();
      if (!ext) target += ".txt";
      else if (!TEXT_FILE_TYPES.has(ext)) throw new FileToolError(`create_text_file only makes plain-text files (${[...TEXT_FILE_TYPES].join(", ")}).`);
      const r = await writeFile(uniqueTarget(target), content, false);
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
      "Close an app's windows politely, like clicking X (e.g. 'close Spotify'). Matches the app name or the window title, so a file's name closes the window showing it ('test123' closes the Notepad with test123.txt). Apps with unsaved work will ask him to save. Never force-quits.",
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
      "Gather sir's morning briefing: date, weather, today's calendar and reminders, and the important unread emails. Use when he says good morning or asks for his briefing/rundown of the day, then deliver it conversationally — weather in a line, then what's on today, then anything urgent in the inbox.",
    schema: z.object({ city: z.string().optional().describe("Only if he names a city or none is remembered yet") }),
    run: async ({ city }) => {
      const [w, mail, calendar] = await Promise.all([
        weather(city).catch((e) => ({ error: String(e) })),
        gmailAccount()
          ? triageEmail("is:unread newer_than:2d", 20)
              .then((t) => ({
                unread: t.count,
                important: t.emails.filter((e) => "urgency" in e && (e.urgency === "today" || e.urgency === "this week")).slice(0, 5),
              }))
              .catch((e) => ({ error: String(e) }))
          : Promise.resolve({ note: "Gmail not connected" }),
        calendarReady() ? todaysEvents().catch((e) => ({ error: String(e) })) : Promise.resolve({ note: "Calendar not connected" }),
      ]);
      markBriefed();
      return {
        result: {
          date: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
          weather: w,
          calendar_today: calendar,
          tasks_today: tasksForToday(),
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
    name: "code_task",
    hub: "code",
    description:
      "Hand real coding work to SUNDAY's coding engine (the Claude Code agent): build a feature, fix a bug, refactor, write tests, or create a new project from scratch — it reads the project, plans, edits, runs builds/tests and verifies, in the background while the coding panel shows progress. Give it a complete brief in goal (what sir wants, constraints, stack, anything from the conversation). For an existing project pass project (find it with vscode_workspaces or search_files if he named it loosely); for a new one pass new_project_name (+ new_project_in, default D:\\Projects). Opens the project in VS Code so he can watch (or Visual Studio for .NET if he prefers). continue_previous carries on the last task in the same project (follow-ups, answers to its questions). plan_only makes a plan without changing anything.",
    schema: z.object({
      goal: z.string().min(10),
      project: z.string().optional(),
      new_project_name: z.string().optional(),
      new_project_in: z.string().optional(),
      editor: z.enum(["vscode", "visual_studio", "none"]).optional(),
      model: z
        .enum(["best", "quick", "local"])
        .optional()
        .describe("best = Opus (default, most capable, costs most); quick = Sonnet (about half the price, fine for simple tasks); local = free coder on his GPU — only for small single-file jobs, scripts and explanations, or when he asks for local/free"),
      plan_only: z.boolean().optional(),
      continue_previous: z.boolean().optional(),
    }),
    run: async (i, ctx) => ({
      result: await startCoding({
        goal: i.goal,
        project: i.project,
        newProjectName: i.new_project_name,
        newProjectIn: i.new_project_in,
        editor: i.editor,
        model: i.model ?? (ctx.brain === "local" ? "local" : undefined),
        planOnly: i.plan_only,
        continuePrevious: i.continue_previous,
      }),
      activate: ["hub:code"],
    }),
  }),
  def({
    name: "code_status",
    hub: "code",
    description: "How the coding task is going: status, what it's doing now, its todo list, files changed, cost, its final summary, or a command waiting for sir's OK.",
    schema: z.object({}),
    run: async () => ({ result: codingState(), activate: ["hub:code"] }),
  }),
  def({
    name: "code_stop",
    hub: "code",
    description: "Stop the running coding task (changes made so far stay; undo can roll back files).",
    schema: z.object({}),
    run: async () => ({ result: stopCoding(), activate: ["hub:code"] }),
  }),
  def({
    name: "code_approve",
    hub: "code",
    description: "Pass on sir's answer to the command the coding task is waiting on — only after he has said yes or no to it in this message.",
    schema: z.object({ allow: z.boolean() }),
    run: async ({ allow }, ctx) => {
      // His decision, not the model's: the words must be in what he just said.
      const said = ctx.userText ?? "";
      const yes = /\b(yes|yeah|yep|allow|approve|approved|go ahead|do it|ok(ay)?|sure|fine|run it)\b/i.test(said);
      const no = /\b(no|nope|deny|don'?t|stop|cancel|block)\b/i.test(said);
      if (allow ? !yes || no : !no) throw new FileToolError("Ask sir first — only his own yes or no can answer the coding task.");
      return { result: answerApproval(allow), activate: ["hub:code"] };
    },
  }),
  def({
    name: "dev_environment",
    hub: "code",
    description: "Check sir's PC for coding: Node, npm, Git, Python, .NET, Java, VS Code, Visual Studio — and, given a project folder, what kind of project it is and its git status. Use before starting a new project or when he asks what he can build with.",
    schema: z.object({ project: z.string().optional() }),
    run: async ({ project }) => ({ result: await devEnvironment(project), activate: ["hub:code"] }),
  }),
  def({
    name: "task_add",
    hub: "lists",
    description:
      "Put items on one of sir's lists: his to-do list (default), the shopping list, or any list he names ('packing', 'ideas'…). Several items at once: 'eggs, milk and bread' is three items. Due dates in his local time (2026-10-28 or 2026-10-28T15:00), only if he gave one.",
    schema: z.object({
      list: z.string().optional().describe("Default: To-do"),
      items: z
        .array(
          z.object({
            text: z.string().min(1),
            due: z.string().optional(),
            priority: z.enum(["high", "normal", "low"]).optional(),
            notes: z.string().optional(),
          }),
        )
        .min(1)
        .max(30),
    }),
    run: async ({ list, items }) => ({ result: addTasks({ list, items }), activate: ["hub:lists"] }),
  }),
  def({
    name: "tasks_list",
    hub: "lists",
    description: "Read sir's lists — everything open, or one list. Overdue and due-today items are marked.",
    schema: z.object({
      list: z.string().optional(),
      include_done: z.boolean().optional().describe("Also show items ticked off in the last week"),
    }),
    run: async ({ list, include_done }) => ({ result: listTasks({ list, includeDone: include_done }), activate: ["hub:lists"] }),
  }),
  def({
    name: "task_done",
    hub: "lists",
    description: "Tick items off (by id from tasks_list, or by a few words of the item, e.g. 'milk'). undo puts them back.",
    schema: z.object({
      items: z.array(z.union([z.number().int(), z.string().min(1)])).min(1),
      list: z.string().optional(),
      undo: z.boolean().optional(),
    }),
    run: async ({ items, list, undo }) => ({ result: completeTasks({ refs: items, list, undo }), activate: ["hub:lists"] }),
  }),
  def({
    name: "task_change",
    hub: "lists",
    description:
      "Change one item (by id or words): rename, set or clear the due date (null), priority, notes, or move it to another list. archive puts it away without ticking it off (nothing is ever deleted); restore brings it back.",
    schema: z.object({
      item: z.union([z.number().int(), z.string().min(1)]),
      text: z.string().optional(),
      due: z.string().nullable().optional(),
      priority: z.enum(["high", "normal", "low"]).optional(),
      list: z.string().optional(),
      notes: z.string().optional(),
      archive: z.boolean().optional(),
      restore: z.boolean().optional(),
    }),
    run: async ({ item, ...rest }) => ({ result: changeTask({ ref: item, ...rest }), activate: ["hub:lists"] }),
  }),
  def({
    name: "plan_my_day",
    hub: "lists",
    description:
      "Gather everything for planning sir's day: the time now, today's calendar, tasks due or overdue and high-priority ones, and today's reminders. Then propose a realistic plan in time order around his fixed events — what to do when, what can wait — in a few spoken sentences. Offer to block focus time in his calendar, but only add it if he says yes.",
    schema: z.object({}),
    run: async () => ({
      result: {
        now: new Date().toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }),
        calendar: calendarReady() ? await todaysEvents().catch((e) => ({ error: String(e) })) : { note: "Calendar not connected" },
        tasks: tasksForToday(),
        open_lists: listTasks().open,
        reminders_today: todaysReminders(),
      },
      activate: ["hub:lists", "hub:calendar", "hub:time"],
    }),
  }),
  def({
    name: "routine_add",
    hub: "routines",
    description:
      "Set up something SUNDAY does on her own on a schedule, e.g. 'every weekday at 8: my briefing', 'Sundays at 19:00: review my week and plan the next', 'every night at 23:00: remind me to wind down'. prompt is the instruction she'll follow each time, written as if sir asked it. The result is spoken at the PC, or sent to his phone when he's away. Routines can't take over the PC.",
    schema: z.object({
      name: z.string().min(1).describe("Short name, e.g. 'Morning briefing'"),
      prompt: z.string().min(3),
      time: z.string().describe("24-hour local time, e.g. 08:00"),
      days: z.union([z.string(), z.array(z.string())]).describe("'daily', 'weekdays', 'weekends', or days like ['mon','thu']"),
    }),
    run: async (i) => ({ result: (await import("../routines")).addRoutine(i), activate: ["hub:routines"] }),
  }),
  def({
    name: "routines_list",
    hub: "routines",
    description: "List sir's routines: what each does, when, whether it's on, when it runs next and what it said last time.",
    schema: z.object({}),
    run: async () => ({ result: (await import("../routines")).listRoutines(), activate: ["hub:routines"] }),
  }),
  def({
    name: "routine_change",
    hub: "routines",
    description: "Change a routine (by id or name): reschedule, reword, pause (on: false) or resume (on: true), or put it away (archive — never deleted).",
    schema: z.object({
      routine: z.union([z.number().int(), z.string().min(1)]),
      name: z.string().optional(),
      prompt: z.string().optional(),
      time: z.string().optional(),
      days: z.union([z.string(), z.array(z.string())]).optional(),
      on: z.boolean().optional(),
      archive: z.boolean().optional(),
    }),
    run: async ({ routine, ...rest }) => ({ result: (await import("../routines")).changeRoutine({ ref: routine, ...rest }), activate: ["hub:routines"] }),
  }),
  def({
    name: "routine_run_now",
    hub: "routines",
    description: "Run one of sir's routines right now (when he wants to try it). Its result is announced like a scheduled run.",
    schema: z.object({ routine: z.union([z.number().int(), z.string().min(1)]) }),
    run: async ({ routine }, ctx) => {
      if (ctx.channel === "routine") throw new FileToolError("A routine can't start another routine.");
      const { runRoutineNow } = await import("../routines");
      void runRoutineNow(routine).catch(() => {});
      return { result: { started: true, note: "Running in the background — its result will be announced when it's done. Tell sir it's underway." }, activate: ["hub:routines"] };
    },
  }),
  def({
    name: "calendar_events",
    hub: "calendar",
    description:
      "Look at sir's Google Calendar: what's on, when he's free, when something is. Times are his local time, written like 2026-10-28T15:00 (or a plain date for whole days). Defaults to the next 7 days. For 'am I free…' read the events in that window and say plainly.",
    schema: z.object({
      from: z.string().optional(),
      to: z.string().optional().describe("A plain date includes that whole day"),
      query: z.string().optional().describe("Words to search for, e.g. 'dentist'"),
    }),
    run: async ({ from, to, query }) => ({ result: await listEvents({ from, to, query }), activate: ["hub:calendar"] }),
  }),
  def({
    name: "calendar_add",
    hub: "calendar",
    description:
      "Add an event to sir's Google Calendar (his local time, e.g. start 2026-10-30T15:00). It checks for clashes first and adds nothing if there is one — then ask him. Never invites anyone. Default length 60 minutes.",
    schema: z.object({
      title: z.string().min(1),
      start: z.string(),
      end: z.string().optional(),
      minutes: z.number().int().min(5).max(1440).optional().describe("Length, if no end"),
      all_day: z.boolean().optional(),
      location: z.string().optional(),
      notes: z.string().optional(),
      reminder_minutes: z.number().int().min(0).max(10080).optional().describe("Phone/Google reminder this many minutes before"),
      despite_clash: z.boolean().optional().describe("Only after he said yes to a clash"),
    }),
    run: async (i) => ({
      result: await addEvent({
        title: i.title,
        start: i.start,
        end: i.end,
        minutes: i.minutes,
        allDay: i.all_day,
        location: i.location,
        notes: i.notes,
        reminderMinutes: i.reminder_minutes,
        despiteClash: i.despite_clash,
      }),
      activate: ["hub:calendar"],
    }),
  }),
  def({
    name: "calendar_change",
    hub: "calendar",
    description:
      "Reschedule, rename or update one of sir's own calendar events (id from calendar_events). Moving the start keeps the length unless end is given. Events with other people can't be changed — he does those himself. There is no delete.",
    schema: z.object({
      id: z.string(),
      title: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      location: z.string().optional(),
      notes: z.string().optional(),
    }),
    run: async (i) => ({ result: await changeEvent(i), activate: ["hub:calendar"] }),
  }),
  def({
    name: "generate_image",
    hub: "images",
    description:
      "Generate images with Higgsfield from a text prompt (costs well under a cent each from sir's Higgsfield API balance; the tool checks the price first). Write a rich prompt: subject, setting, style, lighting, composition, mood. Runs in the background (usually under a minute); when ready SUNDAY opens a preview and asks him where to save it. This tool never saves anything into his folders — save_image does, once he names the place.",
    schema: z.object({
      prompt: z.string().min(3),
      aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe("16:9 wallpaper/landscape, 9:16 phone/story, 1:1 square/icon; default 4:3"),
      count: z.number().int().min(1).max(4).optional().describe("How many variations (default 1)"),
      high_res: z.boolean().optional().describe("1080p instead of 720p — only when he asks for high resolution"),
    }),
    run: async ({ prompt, aspect_ratio, count, high_res }) => ({
      result: await generateImage({ prompt, aspectRatio: aspect_ratio, count, highRes: high_res }),
      activate: ["hub:images"],
    }),
  }),
  def({
    name: "save_image",
    hub: "images",
    description:
      "Save a generated image (the latest one waiting, or job) into the folder sir names. Only call it with a place he told you in this conversation — if he hasn't said where, ask him first and wait. Never overwrites; undo sets it aside.",
    schema: z.object({
      folder: z.string().min(1).describe("Exactly where he said, e.g. 'Desktop', 'Pictures\\\\Wallpapers', 'D:\\\\Art'"),
      filename: z.string().optional().describe("Name without extension, if he gave one"),
      job: z.string().optional().describe("Image job id, when several are waiting"),
    }),
    run: async ({ folder, filename, job }, ctx) => {
      // He decides where images go — enforced here, not just asked for in the prompt.
      if (!sirNamedPlace(folder, ctx.userText ?? "", ctx.lastReply ?? "")) {
        throw new FileToolError(
          `Not saved — sir hasn't said where (he never named "${folder}"). Reply with just this question: "Where would you like me to save it, sir? I can put it in Pictures\\SUNDAY Images if you like." Then save it where he says, or there if he says yes.`,
        );
      }
      const r = await saveImages({ folder, filename, job });
      return { result: r, activate: ["hub:images", dirId(path.win32.dirname(r.saved[0]))] };
    },
  }),
  def({
    name: "blender_open",
    hub: "blender",
    description:
      "Open Blender (3D) with SUNDAY's bridge, or confirm it's already connected. Optionally open a .blend file. Call before any other blender_ tool.",
    schema: z.object({ file: z.string().optional().describe("A .blend file to open") }),
    run: async ({ file }) => ({ result: await openBlender(file), activate: ["hub:blender"] }),
  }),
  def({
    name: "blender_scene",
    hub: "blender",
    description: "List what's in the open Blender scene: objects (type, position, size, materials, modifiers), collections and materials.",
    schema: z.object({}),
    run: async () => ({ result: await blenderScene(), activate: ["hub:blender"] }),
  }),
  def({
    name: "blender_run_python",
    hub: "blender",
    description:
      "Run Blender Python (bpy) in the open scene to build or change things: meshes, modifiers (subdivision, mirror, bevel, solidify), materials (Principled BSDF, emission), lights, cameras, parenting. bpy, bmesh, mathutils, math, Vector, Euler and Matrix are ready; print() output and a variable named result come back. Restricted: no file access, no bpy.ops.wm/file/export/script, no imports beyond Blender's and math modules. Work in small steps (one part per call), give every object a clear name and keep your work in a named collection. Undo works in Blender (Ctrl+Z).",
    schema: z.object({
      code: z.string().min(1),
      what: z.string().describe("A few words on what this step does"),
    }),
    run: async ({ code }) => ({ result: await blenderRun(code), activate: ["hub:blender"] }),
  }),
  def({
    name: "blender_look",
    hub: "blender",
    description:
      "See the model: renders Blender's viewport from an angle and shows you the picture. Look after every significant step and fix what's off (proportions, gaps, intersections, materials) before moving on.",
    schema: z.object({
      view: z.enum(["three_quarter", "front", "side", "back", "top", "three_quarter_back"]).optional(),
      objects: z.array(z.string()).optional().describe("Frame just these objects (default: everything visible)"),
      shading: z.enum(["SOLID", "MATERIAL", "RENDERED"]).optional().describe("MATERIAL by default; SOLID to judge shape"),
    }),
    run: async ({ view, objects, shading }) => {
      const r = await blenderLook({ view: view === "side" ? "right" : view, objects, shading });
      return {
        result: { view: r.view, framed: r.framed, picture: "attached" },
        activate: ["hub:blender"],
        image: { data: r.data, mediaType: "image/png" },
      };
    },
  }),
  def({
    name: "blender_import",
    hub: "blender",
    description: "Import a 3D model file (glb, gltf, fbx, obj, stl) from sir's drives into the open Blender scene.",
    schema: z.object({ path: z.string() }),
    run: async ({ path: p }) => ({ result: await blenderImport(p), activate: ["hub:blender"] }),
  }),
  def({
    name: "blender_save",
    hub: "blender",
    description:
      "Save the Blender scene as a new .blend file in the folder sir names (ask him where if he hasn't said). Never overwrites — a taken name gets ' (2)'.",
    schema: z.object({ folder: z.string(), name: z.string().describe("File name without .blend") }),
    run: async ({ folder, name }) => {
      const r = await blenderSave(folder, name);
      return { result: r, activate: ["hub:blender", dirId(path.win32.dirname(String(r.saved)))] };
    },
  }),
  def({
    name: "brain_status",
    hub: "brains",
    description:
      "SUNDAY's self-diagnostics: which brains exist and which models they are, whether each is reachable and working, the local model's GPU/VRAM state, brain mode, recent failures, GPU, disks, voice, ears, Voice ID, Gmail — plus a list of problems with fixes. Use it when sir asks how you're doing technically, what's wrong, why something is slow or failing, or for a health check. test=true also sends each brain a tiny test message (a fraction of a cent).",
    schema: z.object({ test: z.boolean().optional() }),
    run: async ({ test }) => ({ result: await brainDiagnostics({ test: test ?? false }), activate: ["hub:brains"] }),
  }),
  def({
    name: "set_brain_mode",
    hub: "brains",
    description:
      "Switch which brain answers from sir's next message on: auto (SUNDAY picks the cheapest capable brain per message — the default), local (the free model on his GPU), fast (Claude Haiku) or deep (Claude Opus). Use when he says things like 'switch to Opus', 'use the local brain', 'go back to automatic'. A pinned brain still hands up requests it can't do (e.g. the local brain can't read email).",
    schema: z.object({ mode: z.enum(["auto", "local", "fast", "deep"]) }),
    run: async ({ mode }) => {
      setBrainMode(mode);
      return {
        result: {
          mode,
          note: mode === "auto" ? "Automatic from the next message." : `Pinned to the ${BRAIN_LABEL[mode as Brain]} brain from the next message.`,
        },
        activate: ["hub:brains"],
      };
    },
  }),
  def({
    name: "repair_brain",
    hub: "brains",
    description:
      "Fix brain problems found by brain_status: reload_local (rebuild SUNDAY's local model and load it into the GPU), unload_local (free ~10 GB of GPU memory, e.g. before games or Blender — it reloads when needed), start_ollama (start Ollama if it isn't running; won't end stuck copies — sir does that), reset_brain_mode (back to automatic). Run brain_status again afterwards to confirm.",
    schema: z.object({ action: z.enum(["reload_local", "unload_local", "start_ollama", "reset_brain_mode"]) }),
    run: async ({ action }) => ({ result: await repairBrain(action), activate: ["hub:brains"] }),
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
    name: "insert_code",
    hub: "code",
    description:
      "Add new code to a file without matching existing text — the easy way to add a function, import or block. at: \"end\", \"start\", or a line number from read_code (the new code goes before that line). Backed up; undo restores it.",
    schema: z.object({
      path: z.string(),
      code: z.string().min(1),
      at: z.union([z.enum(["end", "start"]), z.number().int().min(1)]).default("end"),
    }),
    run: async ({ path: p, code, at }) => {
      const r = await insertCode(p, code, at);
      return { result: r, activate: [`code:${r.path.toLowerCase()}`] };
    },
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

/** The everyday tools the local brain gets — small models get confused by ~50. */
/** Where a request came from: his PC, his phone (Telegram), or one of his scheduled routines. */
export type Channel = "pc" | "telegram" | "routine";

/** Tools that act on the PC itself — never from his phone (in case his Telegram is ever compromised) or unattended in a routine. */
const REMOTE_BLOCKED = new Set([
  "computer_task", "power", "close_application", "lock_pc", "show_desktop",
  "move_items", "rename_item", "undo_file_operations", "edit_file", "write_file",
  "blender_open", "blender_run_python", "blender_import", "blender_save",
  "look_at_screen", "read_clipboard", "write_clipboard", "open_in_vscode",
  "code_task", "code_approve",
]);

/** Direct code tools whose work shows up in the coding panel. */
const QUICK_CODE = new Set(["create_text_file", "insert_code", "edit_file", "write_file", "read_code", "search_in_files", "open_in_vscode"]);

/** Plain-text and source files create_text_file may make (new files only — it never overwrites). */
const TEXT_FILE_TYPES = new Set([
  ".txt", ".md", ".csv", ".json", ".log",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css", ".scss", ".java", ".cs", ".cpp", ".c", ".h",
  ".go", ".rs", ".php", ".rb", ".sql", ".sh", ".ps1", ".bat", ".yml", ".yaml", ".toml", ".xml", ".ini",
]);

const LOCAL_TOOLS = new Set([
  "remember", "recall", "search_files", "list_directory", "create_folder", "create_text_file",
  "open_application", "open_path", "open_url", "browser_search", "close_application", "save_image",
  "media_control", "volume", "system_status", "lock_pc", "show_desktop",
  "set_reminder", "set_timer", "list_reminders", "cancel_reminder", "get_weather", "morning_briefing", "calendar_events",
  "task_add", "tasks_list", "task_done", "task_change",
  // light coding: open and read projects, create files, small exact edits, and hand bigger jobs to the (free, local) coding engine
  "vscode_workspaces", "open_in_vscode", "read_code", "search_in_files", "insert_code", "edit_file", "dev_environment", "code_task", "code_status", "code_stop",
  "brain_status", "set_brain_mode", "repair_brain",
]);
/** Only the deep brain drives the computer or edits code. */
const DEEP_ONLY = new Set(["computer_task", "write_file", "use_skill", "blender_run_python", "blender_look", "blender_import"]);

/** Not a real tool: the local and fast brains call it to pass a request up. */
export const HAND_OFF = "hand_off";

export function toolSchemas(brain: Brain = "deep", channel: Channel = "pc"): Anthropic.Beta.BetaToolUnion[] {
  const offered = TOOLS.filter(
    (t) =>
      (brain === "deep" ? true : brain === "local" ? LOCAL_TOOLS.has(t.name) : !DEEP_ONLY.has(t.name)) &&
      !(channel !== "pc" && REMOTE_BLOCKED.has(t.name)),
  );
  const custom = offered.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      // Ollama doesn't know this field; Claude streams big inputs faster with it.
      ...(brain === "local" ? {} : { eager_input_streaming: true }),
    } satisfies Anthropic.Beta.BetaTool;
  });
  if (brain === "deep") {
    return [
      ...custom,
      { type: "web_search_20260209", name: "web_search", max_uses: 3 } as Anthropic.Beta.BetaToolUnion,
      // Lets her read documentation pages a skill points to (only URLs already in the conversation).
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 } as Anthropic.Beta.BetaToolUnion,
    ];
  }
  const handOff: Anthropic.Beta.BetaTool = {
    name: HAND_OFF,
    description:
      brain === "local"
        ? "Pass this request to SUNDAY's stronger brain. Call it right away — before saying anything — when the request needs a tool you don't have (web search, email, the screen, moving or renaming files, documents, debugging or reviewing code, using the computer), takes several careful steps, or you're unsure you'd get it right."
        : "Pass this request to SUNDAY's strongest brain. Call it right away — before saying anything — for coding or editing code, using the computer (mouse and keyboard), loading expert skills, or anything that needs deep reasoning you're not confident about.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "A few words on why" } },
      required: ["reason"],
    },
  };
  return [
    ...custom,
    handOff,
    ...(brain === "fast" ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 } as Anthropic.Beta.BetaToolUnion] : []),
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
  if (ctx.channel && ctx.channel !== "pc" && REMOTE_BLOCKED.has(name)) {
    const from = ctx.channel === "telegram" ? "from the phone" : "in a routine";
    return { ok: false, result: { error: `Not ${from} — that acts on the PC itself. Sir can do it when he's at the computer.` }, activate: [] };
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, result: { error: "INVALID_INPUT", issues: parsed.error.issues.slice(0, 5) }, activate: [] };
  }
  const base = [`skill:${name}`, `hub:${tool.hub}`];
  try {
    const out = await tool.run(parsed.data, ctx);
    const result = isOutcome(out) ? out.result : out;
    // Quick code edits show in the coding panel too, not only background coding tasks.
    if (QUICK_CODE.has(name)) recordQuickCode({ tool: name, input: parsed.data as Record<string, unknown>, result, request: ctx.userText ?? "", brain: ctx.brain ?? "deep" });
    if (isOutcome(out)) return { ok: true, result: out.result, activate: [...base, ...out.activate], image: out.image };
    return { ok: true, result: out, activate: base };
  } catch (err) {
    return { ok: false, result: { error: err instanceof Error ? err.message : String(err) }, activate: base };
  }
}

export const TOOL_CATALOG = TOOLS.map((t) => ({ name: t.name, hub: t.hub }));
