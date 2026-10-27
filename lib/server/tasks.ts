import "server-only";
import { db, logActivity } from "./db";

/**
 * Sir's lists: a to-do list, a shopping list, or any list he names. Nothing is ever
 * deleted — items are ticked off (done) or put away (archived), and both can be undone.
 */

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list TEXT NOT NULL,
      text TEXT NOT NULL,
      notes TEXT,
      due TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
      created_at INTEGER NOT NULL,
      done_at INTEGER,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tasks_open ON tasks(done_at, archived_at, list);
  `);
  schemaReady = true;
}

export type Priority = "high" | "normal" | "low";
type Row = {
  id: number;
  list: string;
  text: string;
  notes: string | null;
  due: string | null;
  priority: Priority;
  created_at: number;
  done_at: number | null;
  archived_at: number | null;
};

export const DEFAULT_LIST = "To-do";

/** "shopping" → "Shopping"; keeps his capitalisation otherwise, and finds an existing list case-insensitively. */
function listName(name?: string) {
  const wanted = (name ?? "").trim().replace(/\s+list$/i, "") || DEFAULT_LIST;
  const existing = db().prepare("SELECT DISTINCT list FROM tasks").all() as { list: string }[];
  const match = existing.find((r) => r.list.toLowerCase() === wanted.toLowerCase());
  if (match) return match.list;
  if (/^(to-?do|todo|tasks?)$/i.test(wanted)) return DEFAULT_LIST;
  return wanted[0].toUpperCase() + wanted.slice(1);
}

/** Accepts "2026-10-28" or "2026-10-28T15:00" (his local time). */
function cleanDue(due?: string | null) {
  if (!due) return null;
  const s = due.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s) || Number.isNaN(new Date(s.length === 10 ? `${s}T00:00` : s).getTime())) {
    throw new Error(`I couldn't read the due date "${due}" — use 2026-10-28 or 2026-10-28T15:00.`);
  }
  return s;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function dueLabel(due: string | null) {
  if (!due) return undefined;
  const t = today();
  const day = due.slice(0, 10);
  const time = due.length > 10 ? ` ${due.slice(11)}` : "";
  if (day < t) return `overdue (was ${new Date(`${day}T00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}${time})`;
  if (day === t) return `today${time}`;
  return `${new Date(`${day}T00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}${time}`;
}

function view(r: Row) {
  return {
    id: r.id,
    list: r.list,
    text: r.text,
    ...(r.notes ? { notes: r.notes } : {}),
    ...(r.due ? { due: r.due, when: dueLabel(r.due) } : {}),
    ...(r.priority !== "normal" ? { priority: r.priority } : {}),
    ...(r.done_at ? { done: true } : {}),
  };
}
export type TaskView = ReturnType<typeof view>;

export function addTasks(input: { list?: string; items: { text: string; due?: string; priority?: Priority; notes?: string }[] }) {
  ensureSchema();
  const list = listName(input.list);
  const now = Date.now();
  const insert = db().prepare("INSERT INTO tasks(list, text, notes, due, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const added = input.items
    .filter((i) => i.text.trim())
    .map((i) => {
      const r = insert.run(list, i.text.trim(), i.notes?.trim() || null, cleanDue(i.due), i.priority ?? "normal", now);
      return Number(r.lastInsertRowid);
    });
  logActivity("task", `added ${added.length} to ${list}`, input.items.map((i) => i.text).join(", ").slice(0, 120));
  return { list, added: getMany(added) };
}

function getMany(ids: number[]) {
  if (!ids.length) return [];
  return (db().prepare(`SELECT * FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]).map(view);
}

const ORDER = `ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due IS NULL, due, id`;

/** Open items (and recently finished ones when asked), grouped by list. */
export function listTasks(input: { list?: string; includeDone?: boolean } = {}) {
  ensureSchema();
  const where = ["archived_at IS NULL"];
  const args: string[] = [];
  if (input.list) {
    where.push("list = ?");
    args.push(listName(input.list));
  }
  if (!input.includeDone) where.push("done_at IS NULL");
  else where.push("(done_at IS NULL OR done_at > " + (Date.now() - 7 * 86_400_000) + ")");
  const rows = db().prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ${ORDER}`).all(...args) as Row[];
  const lists: Record<string, TaskView[]> = {};
  for (const r of rows) (lists[r.list] ??= []).push(view(r));
  const all = Object.values(lists).flat();
  return {
    lists,
    open: all.filter((t) => !t.done).length,
    overdue: all.filter((t) => !t.done && t.when?.startsWith("overdue")).length,
    due_today: all.filter((t) => !t.done && t.when?.startsWith("today")).length,
  };
}

/** Finds items by id or by words of their text (open ones first). */
function find(refs: (number | string)[], list?: string) {
  ensureSchema();
  const found: Row[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      const r = db().prepare("SELECT * FROM tasks WHERE id = ?").get(Number(ref)) as Row | undefined;
      if (r) found.push(r);
      else missing.push(String(ref));
      continue;
    }
    const args: (string | number)[] = [`%${String(ref).trim()}%`];
    let sql = "SELECT * FROM tasks WHERE archived_at IS NULL AND text LIKE ? COLLATE NOCASE";
    if (list) {
      sql += " AND list = ?";
      args.push(listName(list));
    }
    const r = db().prepare(`${sql} ORDER BY done_at IS NOT NULL, id DESC LIMIT 1`).get(...args) as Row | undefined;
    if (r) found.push(r);
    else missing.push(String(ref));
  }
  return { found, missing };
}

/** Ticks items off (or back on with undo). */
export function completeTasks(input: { refs: (number | string)[]; list?: string; undo?: boolean }) {
  const { found, missing } = find(input.refs, input.list);
  const set = db().prepare("UPDATE tasks SET done_at = ? WHERE id = ?");
  for (const r of found) set.run(input.undo ? null : Date.now(), r.id);
  if (found.length) logActivity("task", input.undo ? "reopened" : "done", found.map((r) => r.text).join(", ").slice(0, 120));
  return { [input.undo ? "reopened" : "done"]: getMany(found.map((r) => r.id)), ...(missing.length ? { not_found: missing } : {}) };
}

/** Edits one item; archive puts it away (not deleted — restore brings it back). */
export function changeTask(input: {
  ref: number | string;
  text?: string;
  due?: string | null;
  priority?: Priority;
  list?: string;
  notes?: string;
  archive?: boolean;
  restore?: boolean;
}) {
  const { found } = find([input.ref]);
  const r = found[0];
  if (!r) throw new Error(`I couldn't find "${input.ref}" on any list.`);
  const next = {
    text: input.text?.trim() || r.text,
    due: input.due === undefined ? r.due : cleanDue(input.due),
    priority: input.priority ?? r.priority,
    list: input.list ? listName(input.list) : r.list,
    notes: input.notes ?? r.notes,
    archived_at: input.archive ? Date.now() : input.restore ? null : r.archived_at,
  };
  db()
    .prepare("UPDATE tasks SET text = ?, due = ?, priority = ?, list = ?, notes = ?, archived_at = ? WHERE id = ?")
    .run(next.text, next.due, next.priority, next.list, next.notes, next.archived_at, r.id);
  logActivity("task", input.archive ? "put away" : "changed", next.text);
  return { before: view(r), after: getMany([r.id])[0], ...(input.archive ? { note: "Put away, not deleted — it can be restored." } : {}) };
}

/** What's due today or overdue, plus high-priority items — for briefings and day plans. */
export function tasksForToday() {
  ensureSchema();
  const t = today();
  const rows = db()
    .prepare(`SELECT * FROM tasks WHERE archived_at IS NULL AND done_at IS NULL AND ((due IS NOT NULL AND substr(due, 1, 10) <= ?) OR priority = 'high') ${ORDER}`)
    .all(t) as Row[];
  return rows.map(view);
}

/** "Lists: To-do 4 open (1 overdue, 2 today) · Shopping 6" — for SUNDAY's context. */
export function tasksLine() {
  ensureSchema();
  const rows = db()
    .prepare("SELECT list, COUNT(*) n, SUM(CASE WHEN due IS NOT NULL AND substr(due, 1, 10) < ? THEN 1 ELSE 0 END) late, SUM(CASE WHEN substr(due, 1, 10) = ? THEN 1 ELSE 0 END) today FROM tasks WHERE archived_at IS NULL AND done_at IS NULL GROUP BY list ORDER BY n DESC LIMIT 6")
    .all(today(), today()) as { list: string; n: number; late: number; today: number }[];
  if (!rows.length) return "";
  return `Lists: ${rows
    .map((r) => {
      const extra = [r.late ? `${r.late} overdue` : "", r.today ? `${r.today} due today` : ""].filter(Boolean).join(", ");
      return `${r.list} ${r.n} open${extra ? ` (${extra})` : ""}`;
    })
    .join(" · ")}.`;
}
