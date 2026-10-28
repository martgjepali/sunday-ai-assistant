import "server-only";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { driveRoots } from "./config";
import { indexDb, transaction } from "./db";

/** Scan bookkeeping lives inside file-index.db, so deleting that file forces a fresh scan. */
function metaGet<T>(key: string): T | undefined {
  const row = indexDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

function metaSet(key: string, value: unknown) {
  indexDb()
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

const win = path.win32;

/** Folders never worth indexing: system areas, caches, dependency trees. */
const SKIP = new Set(
  [
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "system volume information",
    "recovery",
    "appdata",
    "node_modules",
    ".git",
    ".next",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    "config.msi",
    "msocache",
    "perflogs",
    "windowsapps",
    ".sunday-data",
    "onedrivetemp",
    "$recycle.bin",
  ].map((s) => s.toLowerCase()),
);

const MAX_DEPTH = 16;
const REINDEX_AFTER_MS = 12 * 60 * 60 * 1000;
/**
 * Where new things land. A full drive scan runs every 12 hours; these are refreshed every 15 minutes,
 * so "the file I just saved to my Desktop" can be found.
 */
const HOT_FOLDERS = ["Desktop", "Documents", "Downloads", "OneDrive\\Desktop", "OneDrive\\Documents"].map((f) => win.join(os.homedir(), f));
const HOT_DEPTH = 4;
const HOT_MAX = 20_000;

type DriveStatus = {
  state: "idle" | "indexing" | "done" | "error";
  count: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};

const g = globalThis as unknown as {
  __sundayIndexer?: { running: boolean; status: Record<string, DriveStatus>; timer?: NodeJS.Timeout };
};
g.__sundayIndexer ??= { running: false, status: {} };
const state = g.__sundayIndexer;

export function indexerStatus() {
  const out: Record<string, DriveStatus> = {};
  for (const root of driveRoots()) {
    const saved = metaGet<{ finishedAt: number; count: number }>(`index:${root}`);
    out[root] = state.status[root] ?? (saved ? { state: "done", ...saved } : { state: "idle", count: 0 });
  }
  return out;
}

export function startIndexer() {
  // SUNDAY_INDEXER=off: test servers with a fresh data folder mustn't start scanning every drive.
  if (state.timer || process.env.SUNDAY_INDEXER === "off") return;
  const tick = () => void runIndexPass();
  state.timer = setInterval(tick, 15 * 60 * 1000);
  state.timer.unref?.();
  setTimeout(tick, 5000).unref?.();
}

async function runIndexPass(force = false) {
  if (state.running) return;
  state.running = true;
  try {
    for (const root of driveRoots()) {
      const saved = metaGet<{ finishedAt: number }>(`index:${root}`);
      if (!force && saved && Date.now() - saved.finishedAt < REINDEX_AFTER_MS) continue;
      await indexDrive(root);
    }
    await refreshHotFolders();
  } finally {
    state.running = false;
  }
}

export function reindexNow() {
  void runIndexPass(true);
}

async function indexDrive(root: string) {
  const gen = Date.now();
  const status: DriveStatus = { state: "indexing", count: 0, startedAt: gen };
  state.status[root] = status;
  const insert = indexDb().prepare(
    "INSERT INTO files_fts(name, path, drive, ext, size, mtime, is_dir, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let batch: [name: string, path: string, ext: string, size: number, mtime: number, isDir: number][] = [];
  const flush = () => {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    transaction(() => {
      for (const r of rows) insert.run(r[0], r[1], root, r[2], r[3], r[4], r[5], gen);
    }, indexDb());
  };

  try {
    const stack: [string, number][] = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const lower = e.name.toLowerCase();
        if (e.isSymbolicLink()) continue;
        const full = win.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP.has(lower) || lower.startsWith("$")) continue;
          batch.push([e.name, full, "", 0, 0, 1]);
          if (depth < MAX_DEPTH) stack.push([full, depth + 1]);
        } else if (e.isFile()) {
          batch.push([e.name, full, win.extname(lower).slice(1), 0, 0, 0]);
        }
        status.count++;
      }
      if (batch.length >= 2000) {
        flush();
        await new Promise((r) => setImmediate(r));
      }
    }
    flush();
    indexDb().prepare("DELETE FROM files_fts WHERE drive = ? AND gen != ?").run(root, gen);
    status.state = "done";
    status.finishedAt = Date.now();
    metaSet(`index:${root}`, { finishedAt: status.finishedAt, count: status.count });
  } catch (err) {
    status.state = "error";
    status.error = err instanceof Error ? err.message : String(err);
  }
}

/** Desktop, Documents and Downloads, re-read so his newest files can be found. */
export async function refreshHotFolders() {
  for (const dir of HOT_FOLDERS) if (existsSync(dir)) await indexFolder(dir);
}

/** Re-reads one folder (a few levels deep) and swaps its rows in the index — quick, unlike a drive scan. */
async function indexFolder(top: string) {
  const root = win.parse(top).root.toUpperCase();
  const rows: [name: string, path: string, ext: string, isDir: number][] = [];
  const stack: [string, number][] = [[top, 0]];
  while (stack.length && rows.length < HOT_MAX) {
    const [dir, depth] = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (e.isSymbolicLink()) continue;
      const full = win.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(lower) || lower.startsWith("$")) continue;
        rows.push([e.name, full, "", 1]);
        if (depth < HOT_DEPTH) stack.push([full, depth + 1]);
      } else if (e.isFile()) rows.push([e.name, full, win.extname(lower).slice(1), 0]);
    }
  }
  // A capped walk saw only part of the folder — keep the old rows rather than lose the rest.
  if (rows.length >= HOT_MAX) return;
  const db = indexDb();
  const insert = db.prepare("INSERT INTO files_fts(name, path, drive, ext, size, mtime, is_dir, gen) VALUES (?, ?, ?, ?, 0, 0, ?, 0)");
  transaction(() => {
    // substr, not LIKE: folder names can contain _ and %.
    db.prepare("DELETE FROM files_fts WHERE drive = ? AND substr(path, 1, ?) = ?").run(root, top.length + 1, `${top}\\`);
    for (const r of rows) insert.run(r[0], r[1], root, r[2], r[3]);
  }, db);
}

/** Add a single path to the index right away (after SUNDAY creates or moves something). */
export function indexPath(p: string, isDir: boolean) {
  const root = win.parse(p).root.toUpperCase();
  const name = win.basename(p);
  indexDb()
    .prepare(
      "INSERT INTO files_fts(name, path, drive, ext, size, mtime, is_dir, gen) VALUES (?, ?, ?, ?, 0, 0, ?, 0)",
    )
    .run(name, p, root, isDir ? "" : win.extname(name).slice(1).toLowerCase(), isDir ? 1 : 0);
}

export type SearchOptions = {
  drive?: string;
  extension?: string;
  kind?: "file" | "folder" | "any";
  limit?: number;
};

export function searchIndex(query: string, opts: SearchOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  const exact = runSearch(terms.map(nameTerm).join(" AND "), opts, limit);
  // Nothing? Speech-to-text mishears a word now and then ("project tool" for "project two") — allow one to miss.
  if (exact.length || terms.length < 3) return { results: exact, close: false };
  const loose = terms.map((_, skip) => `(${terms.filter((_, i) => i !== skip).map(nameTerm).join(" AND ")})`).join(" OR ");
  return { results: runSearch(loose, opts, limit), close: true };
}

/** Spoken numbers arrive as words: "project two" must find "Project 2", and "2" must find "two". */
const NUMBERS = new Map<string, string>(
  [
    ..."zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
      .split(" ")
      .map((w, n) => [w, String(n)]),
    ...["thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].map((w, i) => [w, String(30 + i * 10)]),
  ].flatMap(([w, n]) => [[w, n], [n, w]] as [string, string][]),
);

function nameTerm(t: string) {
  const other = NUMBERS.get(t);
  return other ? `("${t}"* OR "${other}")` : `"${t}"*`;
}

function runSearch(match: string, opts: SearchOptions, limit: number) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (match) {
    where.push("files_fts MATCH ?");
    params.push(`name : (${match})`);
  }
  if (opts.drive) {
    where.push("drive = ?");
    params.push(`${opts.drive.replace(/[:\\/]+$/, "").toUpperCase()}:\\`);
  }
  if (opts.extension) {
    where.push("ext = ?");
    params.push(opts.extension.replace(/^\./, "").toLowerCase());
  }
  if (opts.kind === "file") where.push("is_dir = 0");
  if (opts.kind === "folder") where.push("is_dir = 1");
  if (!where.length) return [];

  const rows = indexDb()
    .prepare(
      `SELECT name, path, is_dir FROM files_fts WHERE ${where.join(" AND ")} ${
        match ? "ORDER BY rank" : ""
      } LIMIT ?`,
    )
    .all(...params, limit * 3) as { name: string; path: string; is_dir: number }[];

  const seen = new Set<string>();
  const out: { name: string; path: string; type: "file" | "folder" }[] = [];
  for (const r of rows) {
    const key = r.path.toLowerCase();
    if (seen.has(key) || !existsSync(r.path)) continue;
    seen.add(key);
    out.push({ name: r.name, path: r.path, type: r.is_dir ? "folder" : "file" });
    if (out.length >= limit) break;
  }
  return out;
}
