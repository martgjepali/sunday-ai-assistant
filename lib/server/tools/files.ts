import "server-only";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, HOME, driveRoots } from "../config";
import { db, logActivity } from "../db";
import { indexPath } from "../indexer";

const win = path.win32;

/**
 * SUNDAY's file powers are deliberately one-directional: she can look at
 * anything on the allowed drives and move/rename/create things outside
 * system areas, but there is no delete operation anywhere in this module.
 * The only removal is the second half of a cross-drive move, after the copy
 * has been verified byte-for-byte in size and file count.
 */

export class FileToolError extends Error {}

const KNOWN_FOLDERS = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"];

/** Registry value names Windows uses for each known folder under "User Shell Folders". */
const SHELL_FOLDER_KEYS: Record<string, string> = {
  Desktop: "Desktop",
  Documents: "Personal",
  Downloads: "{374DE290-123F-4565-9164-39C4925E467B}",
  Pictures: "My Pictures",
  Music: "My Music",
  Videos: "My Video",
};

let shellFolders: Record<string, string> | null = null;

/** Where Windows itself says these folders live (they may or may not be redirected to OneDrive). */
function readShellFolders(): Record<string, string> {
  if (shellFolders) return shellFolders;
  const found: Record<string, string> = {};
  try {
    const out = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/);
      if (m) found[m[1]] = m[2].trim().replace(/%([^%]+)%/g, (w, v: string) => process.env[v] ?? w);
    }
  } catch {}
  shellFolders = found;
  return found;
}

export function knownFolders(): Record<string, string> {
  const registry = readShellFolders();
  const out: Record<string, string> = { Home: HOME };
  for (const name of KNOWN_FOLDERS) out[name] = registry[SHELL_FOLDER_KEYS[name]] ?? win.join(HOME, name);
  return out;
}

/** OneDrive copies of known folders that exist alongside the real ones (easy to confuse). */
export function oneDriveTwins(): Record<string, string> {
  const real = knownFolders();
  const twins: Record<string, string> = {};
  for (const name of KNOWN_FOLDERS) {
    const twin = win.join(HOME, "OneDrive", name);
    if (existsSync(twin) && twin.toLowerCase() !== real[name].toLowerCase()) twins[name] = twin;
  }
  return twins;
}

export function resolveUserPath(input: string): string {
  let p = input.trim().replace(/^["']|["']$/g, "").replace(/\//g, "\\");
  p = p.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  if (p === "~" || p.startsWith("~\\")) p = win.join(HOME, p.slice(1));
  if (/^[a-zA-Z]:$/.test(p)) p += "\\";
  if (!win.isAbsolute(p)) {
    const [first, ...rest] = p.split("\\");
    const known = Object.entries(knownFolders()).find(
      ([name]) => name.toLowerCase() === first.toLowerCase(),
    );
    p = known ? win.join(known[1], ...rest) : win.join(HOME, p);
  }
  return win.resolve(p);
}

function sameOrInside(child: string, parent: string) {
  const c = child.toLowerCase().replace(/\\+$/, "");
  const par = parent.toLowerCase().replace(/\\+$/, "");
  return c === par || c.startsWith(par + "\\");
}

export function assertOnAllowedDrive(p: string) {
  const root = win.parse(p).root.toUpperCase();
  if (!driveRoots().some((r) => r.toUpperCase() === root)) {
    throw new FileToolError(
      `${root || p} is outside the drives I'm allowed to touch (${driveRoots().join(", ")}).`,
    );
  }
}

const ROOT_SYSTEM_FILES = new Set([
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "bootmgr",
  "bootnxt",
  "dumpstack.log.tmp",
]);

function protectedAreas(): string[] {
  const sys = process.env.SystemRoot ?? "C:\\Windows";
  const sysDrive = win.parse(sys).root;
  return [
    sys,
    win.join(sysDrive, "Program Files"),
    win.join(sysDrive, "Program Files (x86)"),
    win.join(sysDrive, "ProgramData"),
    win.join(sysDrive, "Recovery"),
    win.join(sysDrive, "Boot"),
    win.join(sysDrive, "PerfLogs"),
    win.join(HOME, "AppData"),
    process.cwd(),
    DATA_DIR,
  ];
}

/** Things that must never be moved or renamed themselves (their contents may be). */
function pinnedFolders(): string[] {
  return [HOME, win.dirname(HOME), ...Object.values(knownFolders()), ...driveRoots()];
}

/** Throws unless `p` (an existing or to-be-created path) may be changed. */
export function assertWritable(p: string, { isSource = false } = {}) {
  assertOnAllowedDrive(p);
  const parts = p.split("\\").slice(1);
  if (parts.some((seg) => seg.startsWith("$") || seg.toLowerCase() === "system volume information")) {
    throw new FileToolError(`${p} is a protected system location.`);
  }
  if (parts.length === 1 && ROOT_SYSTEM_FILES.has(parts[0].toLowerCase())) {
    throw new FileToolError(`${p} is a Windows system file.`);
  }
  for (const area of protectedAreas()) {
    if (sameOrInside(p, area)) {
      throw new FileToolError(
        `${p} is inside ${area}, which I keep read-only so Windows and installed programs stay healthy.`,
      );
    }
  }
  if (isSource && pinnedFolders().some((f) => f.toLowerCase().replace(/\\+$/, "") === p.toLowerCase().replace(/\\+$/, ""))) {
    throw new FileToolError(`${p} is a core folder; I can organise what's inside it but not move it.`);
  }
}

/** Resolve symlinks/junctions so protection checks see the real location. */
export async function realOrSelf(p: string) {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export async function listDirectory(input: string, limit = 150) {
  const dir = resolveUserPath(input);
  assertOnAllowedDrive(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    throw new FileToolError(err.code === "ENOENT" ? `${dir} doesn't exist.` : `Can't open ${dir}: ${err.code}`);
  });
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
  );
  const shown = entries.slice(0, limit);
  const detailed = await Promise.all(
    shown.map(async (e) => {
      const full = win.join(dir, e.name);
      const st = await fs.stat(full).catch(() => null);
      return {
        name: e.name,
        type: e.isDirectory() ? "folder" : "file",
        size: st && !e.isDirectory() ? fmtSize(st.size) : undefined,
        modified: st ? localStamp(st.mtime) : undefined,
      };
    }),
  );
  return {
    path: dir,
    total: entries.length,
    folders: entries.filter((e) => e.isDirectory()).length,
    files: entries.filter((e) => !e.isDirectory()).length,
    truncated: entries.length > limit,
    entries: detailed,
  };
}

/** "2026-10-26 22:32" in sir's own time zone — UTC stamps get misread as local. */
function localStamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function fileInfo(input: string) {
  const p = resolveUserPath(input);
  assertOnAllowedDrive(p);
  const st = await fs.stat(p).catch(() => {
    throw new FileToolError(`${p} doesn't exist.`);
  });
  const info: Record<string, unknown> = {
    path: p,
    type: st.isDirectory() ? "folder" : "file",
    created: localStamp(st.birthtime),
    modified: localStamp(st.mtime),
  };
  if (st.isDirectory()) {
    const children = await fs.readdir(p).catch(() => []);
    info.items = children.length;
  } else {
    info.size = fmtSize(st.size);
    info.extension = win.extname(p).toLowerCase() || null;
  }
  return info;
}

const MAX_READ = 120_000;

export async function readTextFile(input: string) {
  const p = resolveUserPath(input);
  assertOnAllowedDrive(p);
  const handle = await fs.open(p, "r").catch((err: NodeJS.ErrnoException) => {
    throw new FileToolError(err.code === "ENOENT" ? `${p} doesn't exist.` : `Can't read ${p}: ${err.code}`);
  });
  try {
    const { size } = await handle.stat();
    const buf = Buffer.alloc(Math.min(size, MAX_READ));
    await handle.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) {
      return { path: p, binary: true, size: fmtSize(size), note: "Binary file — I can't read its contents as text." };
    }
    return {
      path: p,
      size: fmtSize(size),
      truncated: size > MAX_READ,
      content: buf.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

export async function createFolder(input: string) {
  const p = resolveUserPath(input);
  assertWritable(p);
  assertWritable(await realOrSelf(win.dirname(p)));
  if (existsSync(p)) return { path: p, created: false, note: "Folder already exists." };
  await fs.mkdir(p, { recursive: true });
  recordOp("create", "", p);
  indexPath(p, true);
  logActivity("folder", win.basename(p), p);
  return { path: p, created: true };
}

export function uniqueTarget(target: string) {
  if (!existsSync(target)) return target;
  const dir = win.dirname(target);
  const ext = win.extname(target);
  const base = win.basename(target, ext);
  for (let i = 2; i < 1000; i++) {
    const candidate = win.join(dir, `${base} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new FileToolError(`Couldn't find a free name for ${target}.`);
}

async function treeTotals(p: string): Promise<{ files: number; bytes: number }> {
  const st = await fs.lstat(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    const t = await treeTotals(win.join(p, e.name));
    files += t.files;
    bytes += t.bytes;
  }
  return { files, bytes };
}

/** Rename when possible; across drives copy, verify, then remove the original. */
export async function relocate(src: string, target: string) {
  try {
    await fs.rename(src, target);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  const before = await treeTotals(src);
  await fs.cp(src, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  const after = await treeTotals(target);
  if (before.files !== after.files || before.bytes !== after.bytes) {
    throw new FileToolError(
      `Copy to ${target} didn't verify (${after.files}/${before.files} files). I left the original untouched.`,
    );
  }
  await fs.rm(src, { recursive: true });
}

export const BACKUP_DIR = path.join(DATA_DIR, "backups");

/** A fresh, unique path in SUNDAY's backup folder for a copy of `file`. */
export function backupPathFor(file: string, tag: string) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(BACKUP_DIR, `${stamp}-${tag}-${randomBytes(3).toString("hex")}-${win.basename(file)}`);
}

export function recordOp(op: string, src: string, dest: string) {
  db()
    .prepare("INSERT INTO file_ops(op, src, dest, created_at) VALUES (?, ?, ?, ?)")
    .run(op, src, dest, Date.now());
}

export async function moveItems(sources: string[], destinationFolder: string) {
  const dest = resolveUserPath(destinationFolder);
  assertWritable(dest);
  assertWritable(await realOrSelf(dest));
  let createdDestination = false;
  if (!existsSync(dest)) {
    await fs.mkdir(dest, { recursive: true });
    recordOp("create", "", dest);
    indexPath(dest, true);
    createdDestination = true;
  } else if (!(await fs.stat(dest)).isDirectory()) {
    throw new FileToolError(`${dest} is a file, not a folder.`);
  }

  const results: { source: string; movedTo?: string; error?: string }[] = [];
  for (const raw of sources) {
    const src = resolveUserPath(raw);
    try {
      if (!existsSync(src)) throw new FileToolError(`${src} doesn't exist.`);
      assertWritable(src, { isSource: true });
      assertWritable(await realOrSelf(src), { isSource: true });
      if (sameOrInside(dest, src)) throw new FileToolError("Can't move a folder into itself.");
      if (win.dirname(src).toLowerCase() === dest.toLowerCase()) {
        results.push({ source: src, movedTo: src });
        continue;
      }
      const target = uniqueTarget(win.join(dest, win.basename(src)));
      await relocate(src, target);
      recordOp("move", src, target);
      indexPath(target, (await fs.stat(target)).isDirectory());
      results.push({ source: src, movedTo: target });
    } catch (err) {
      results.push({ source: src, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const moved = results.filter((r) => r.movedTo).length;
  if (moved) logActivity("move", `${moved} item${moved === 1 ? "" : "s"} → ${win.basename(dest)}`, dest);
  return { destination: dest, createdDestination, moved, failed: results.length - moved, results };
}

const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/;

export async function renameItem(input: string, newName: string) {
  const src = resolveUserPath(input);
  if (!newName.trim() || INVALID_NAME.test(newName) || /[. ]$/.test(newName)) {
    throw new FileToolError(`"${newName}" isn't a valid Windows file name.`);
  }
  if (!existsSync(src)) throw new FileToolError(`${src} doesn't exist.`);
  assertWritable(src, { isSource: true });
  assertWritable(await realOrSelf(src), { isSource: true });
  const target = win.join(win.dirname(src), newName.trim());
  if (existsSync(target) && target.toLowerCase() !== src.toLowerCase()) {
    throw new FileToolError(`Something called ${newName} already exists there.`);
  }
  await fs.rename(src, target);
  recordOp("rename", src, target);
  indexPath(target, (await fs.stat(target)).isDirectory());
  logActivity("rename", `${win.basename(src)} → ${newName}`, target);
  return { from: src, to: target };
}

export async function undoFileOperations(count = 1) {
  const ops = db()
    .prepare(
      "SELECT id, op, src, dest FROM file_ops WHERE undone = 0 AND op IN ('move', 'rename', 'edit', 'overwrite', 'create-file') ORDER BY id DESC LIMIT ?",
    )
    .all(Math.min(Math.max(count, 1), 200)) as { id: number; op: string; src: string; dest: string }[];
  if (!ops.length) return { undone: 0, note: "Nothing left to undo." };

  const results: { restored?: string; error?: string }[] = [];
  for (const op of ops) {
    try {
      if (!existsSync(op.dest)) throw new FileToolError(`${op.dest} is no longer there.`);
      if (op.op === "edit" || op.op === "overwrite") {
        // src is the backup taken before SUNDAY changed the file. Keep the current
        // version too, so undoing is itself reversible.
        if (!existsSync(op.src)) throw new FileToolError(`The backup for ${op.dest} is missing.`);
        await fs.copyFile(op.dest, backupPathFor(op.dest, "before-undo"));
        await fs.copyFile(op.src, op.dest);
        db().prepare("UPDATE file_ops SET undone = 1 WHERE id = ?").run(op.id);
        results.push({ restored: op.dest });
        continue;
      }
      if (op.op === "create-file") {
        // A file SUNDAY created is set aside (never deleted) when undone.
        const aside = backupPathFor(op.dest, "undone-new-file");
        await relocate(op.dest, aside);
        db().prepare("UPDATE file_ops SET undone = 1 WHERE id = ?").run(op.id);
        results.push({ restored: `${op.dest} (set aside in SUNDAY's backups)` });
        continue;
      }
      if (existsSync(op.src)) throw new FileToolError(`Something already occupies ${op.src}.`);
      await fs.mkdir(win.dirname(op.src), { recursive: true });
      await relocate(op.dest, op.src);
      db().prepare("UPDATE file_ops SET undone = 1 WHERE id = ?").run(op.id);
      indexPath(op.src, (await fs.stat(op.src)).isDirectory());
      results.push({ restored: op.src });
    } catch (err) {
      results.push({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  const undone = results.filter((r) => r.restored).length;
  if (undone) logActivity("undo", `restored ${undone} item${undone === 1 ? "" : "s"}`);
  return { undone, results };
}
