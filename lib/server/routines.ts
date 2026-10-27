import "server-only";
import { describeError, runAgent } from "./agent";
import { db, logActivity } from "./db";
import { ensureConversation } from "./memory";
import { pushNotice } from "./notices";

/**
 * Routines: things SUNDAY does on her own on a schedule ("every weekday at 8, my
 * briefing"). Each run is a normal request to her brains in its own conversation; the
 * result arrives as a notice — spoken at the PC, or sent to his phone while he's away.
 * Routines run unattended, so like the phone they can't take over the PC.
 */

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      time TEXT NOT NULL,
      days TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_result TEXT,
      archived_at INTEGER
    );
  `);
  schemaReady = true;
}

type Row = {
  id: number;
  name: string;
  prompt: string;
  time: string;
  days: string;
  enabled: number;
  created_at: number;
  last_run_at: number | null;
  last_result: string | null;
  archived_at: number | null;
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Runs missed by more than this (PC off, asleep) are skipped rather than fired late. */
const CATCH_UP_MS = 90 * 60_000;

/** "weekdays" / "daily" / "weekends" / ["mon","thu"] → "12345" (JS day numbers, Sunday = 0). */
function parseDays(days: string | string[]) {
  const list = Array.isArray(days) ? days : [days];
  const out = new Set<number>();
  for (const d of list.map((x) => x.trim().toLowerCase())) {
    if (/^(daily|every ?day|all)$/.test(d)) [0, 1, 2, 3, 4, 5, 6].forEach((n) => out.add(n));
    else if (/^week ?days$/.test(d)) [1, 2, 3, 4, 5].forEach((n) => out.add(n));
    else if (/^week ?ends$/.test(d)) [0, 6].forEach((n) => out.add(n));
    else {
      const i = DAY_NAMES.indexOf(d.slice(0, 3));
      if (i < 0) throw new Error(`I don't know the day "${d}" — use mon…sun, weekdays, weekends or daily.`);
      out.add(i);
    }
  }
  if (!out.size) throw new Error("Which days?");
  return [...out].sort().join("");
}

function describeDays(days: string) {
  if (days === "0123456") return "every day";
  if (days === "12345") return "weekdays";
  if (days === "06") return "weekends";
  return days
    .split("")
    .map((n) => DAY_NAMES[Number(n)])
    .map((d) => d[0].toUpperCase() + d.slice(1))
    .join(", ");
}

function parseTime(time: string) {
  const m = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Use 24-hour time like 08:00 or 18:30 (got "${time}").`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** When this routine is next due, from now. */
function nextRun(r: Pick<Row, "time" | "days">, from = new Date()) {
  const [h, m] = r.time.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d > from && r.days.includes(String(d.getDay()))) return d;
  }
  return null;
}

function view(r: Row) {
  const next = r.enabled ? nextRun(r) : null;
  return {
    id: r.id,
    name: r.name,
    does: r.prompt,
    when: `${describeDays(r.days)} at ${r.time}`,
    on: Boolean(r.enabled),
    ...(next ? { next: next.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) } : {}),
    ...(r.last_run_at
      ? { last_run: new Date(r.last_run_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }), last_result: (r.last_result ?? "").slice(0, 200) }
      : {}),
  };
}

export function addRoutine(input: { name: string; prompt: string; time: string; days: string | string[] }) {
  ensureSchema();
  const r = db()
    .prepare("INSERT INTO routines(name, prompt, time, days, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(input.name.trim(), input.prompt.trim(), parseTime(input.time), parseDays(input.days), Date.now());
  logActivity("routine", `added ${input.name}`, input.prompt.slice(0, 120));
  return { added: view(get(Number(r.lastInsertRowid))!) };
}

function get(id: number) {
  return db().prepare("SELECT * FROM routines WHERE id = ?").get(id) as Row | undefined;
}

function find(ref: number | string) {
  ensureSchema();
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) return get(Number(ref));
  return db()
    .prepare("SELECT * FROM routines WHERE archived_at IS NULL AND name LIKE ? COLLATE NOCASE ORDER BY id DESC LIMIT 1")
    .get(`%${String(ref).trim()}%`) as Row | undefined;
}

export function listRoutines() {
  ensureSchema();
  const rows = db().prepare("SELECT * FROM routines WHERE archived_at IS NULL ORDER BY time").all() as Row[];
  return { routines: rows.map(view) };
}

/** Pause/resume, reschedule, reword — or put away (archived, never deleted). */
export function changeRoutine(input: {
  ref: number | string;
  name?: string;
  prompt?: string;
  time?: string;
  days?: string | string[];
  on?: boolean;
  archive?: boolean;
}) {
  const r = find(input.ref);
  if (!r) throw new Error(`No routine called "${input.ref}".`);
  db()
    .prepare("UPDATE routines SET name = ?, prompt = ?, time = ?, days = ?, enabled = ?, archived_at = ? WHERE id = ?")
    .run(
      input.name?.trim() || r.name,
      input.prompt?.trim() || r.prompt,
      input.time ? parseTime(input.time) : r.time,
      input.days ? parseDays(input.days) : r.days,
      input.on === undefined ? r.enabled : input.on ? 1 : 0,
      input.archive ? Date.now() : r.archived_at,
      r.id,
    );
  logActivity("routine", input.archive ? `put away ${r.name}` : `changed ${r.name}`, "");
  return { before: view(r), after: view(get(r.id)!), ...(input.archive ? { note: "Put away, not deleted." } : {}) };
}

/* ───────── Running them ───────── */

const g = globalThis as unknown as { __sundayRoutines?: { started: boolean; running: Set<number> } };
const state = (g.__sundayRoutines ??= { started: false, running: new Set() });

async function run(r: Row, reason: "schedule" | "now") {
  if (state.running.has(r.id)) return { error: "It's already running." };
  state.running.add(r.id);
  db().prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(Date.now(), r.id);
  let text = "";
  try {
    await runAgent({
      conversationId: ensureConversation(null),
      userText: `(Routine "${r.name}", ${reason === "now" ? "run on request" : "on schedule"}) ${r.prompt}`,
      mode: "text",
      security: { ok: true, via: "routine" },
      signal: AbortSignal.timeout(10 * 60_000),
      emit: (e) => {
        if (e.type === "text") text += e.delta;
      },
      channel: "routine",
    });
  } catch (err) {
    text = `The "${r.name}" routine didn't finish: ${describeError(err)}`;
  } finally {
    state.running.delete(r.id);
  }
  const result = text.trim() || `"${r.name}" ran, but had nothing to say.`;
  db().prepare("UPDATE routines SET last_result = ? WHERE id = ?").run(result.slice(0, 2000), r.id);
  logActivity("routine", `ran ${r.name}`, result.slice(0, 160));
  pushNotice(`SUNDAY — ${r.name}`, result);
  return { ran: r.name, result };
}

/** Runs one now (for "try it now" / testing). */
export async function runRoutineNow(ref: number | string) {
  const r = find(ref);
  if (!r) throw new Error(`No routine called "${ref}".`);
  return run(r, "now");
}

/** Checks every 30 seconds for routines that are due. */
export function startRoutines() {
  if (state.started || process.env.SUNDAY_ROUTINES === "off") return;
  state.started = true;
  setInterval(() => {
    try {
      ensureSchema();
      const now = new Date();
      const rows = db().prepare("SELECT * FROM routines WHERE archived_at IS NULL AND enabled = 1").all() as Row[];
      for (const r of rows) {
        if (!r.days.includes(String(now.getDay()))) continue;
        const [h, m] = r.time.split(":").map(Number);
        const due = new Date(now);
        due.setHours(h, m, 0, 0);
        const late = now.getTime() - due.getTime();
        if (late < 0 || late > CATCH_UP_MS) continue;
        if (r.last_run_at && r.last_run_at >= due.getTime()) continue;
        void run(r, "schedule");
      }
    } catch (err) {
      console.warn("[sunday] routines:", err instanceof Error ? err.message : err);
    }
  }, 30_000);
}
