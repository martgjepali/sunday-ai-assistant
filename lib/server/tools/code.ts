import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logActivity } from "../db";
import { indexPath } from "../indexer";
import {
  FileToolError,
  assertOnAllowedDrive,
  assertWritable,
  backupPathFor,
  realOrSelf,
  recordOp,
  resolveUserPath,
} from "./files";

/**
 * SUNDAY's coding hands. Every edit or overwrite first copies the original into
 * SUNDAY's backups and is recorded, so "undo" restores it exactly. Writing to
 * disk *is* the save — VS Code reloads the file automatically.
 */

const win = path.win32;
const MAX_CODE_BYTES = 2_000_000;
const BINARY_EXT = new Set([".exe", ".dll", ".sys", ".msi", ".lnk", ".zip", ".7z", ".rar", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".mp3", ".mp4", ".wav", ".flp"]);

/* ───────────── VS Code ───────────── */

function vscodeInstall(): { exe: string; cli: string } | null {
  const roots = [
    win.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code"),
    win.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code"),
  ];
  for (const root of roots) {
    const exe = win.join(root, "Code.exe");
    const cmd = win.join(root, "bin", "code.cmd");
    if (!existsSync(exe) || !existsSync(cmd)) continue;
    // VS Code keeps its CLI in a version-hash folder; code.cmd always names the current one.
    const m = readFileSync(cmd, "utf8").match(/%~dp0\.\.\\([^"]+?cli\.js)"/);
    const cli = m ? win.join(root, m[1]) : "";
    if (cli && existsSync(cli)) return { exe, cli };
  }
  return null;
}

export async function openInVSCode(input: string, line?: number) {
  const p = resolveUserPath(input);
  assertOnAllowedDrive(p);
  if (!existsSync(p)) throw new FileToolError(`${p} doesn't exist.`);
  const vs = vscodeInstall();
  if (!vs) throw new FileToolError("I couldn't find VS Code on this PC.");
  const isDir = (await fs.stat(p)).isDirectory();
  const args = isDir ? [vs.cli, p] : [vs.cli, "--goto", `${p}:${Math.max(1, line ?? 1)}`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(vs.exe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  logActivity("code", win.basename(p), p);
  return { opened: p, line: isDir ? undefined : (line ?? 1) };
}

/** Folders and files currently open (or last open) in VS Code. */
export function vscodeWorkspaces() {
  const storage = win.join(process.env.APPDATA ?? "", "Code", "User", "globalStorage", "storage.json");
  if (!existsSync(storage)) return { open: [], note: "VS Code state not found." };
  const toPath = (uri?: string) => {
    if (!uri?.startsWith("file:")) return null;
    try {
      return fileURLToPath(uri);
    } catch {
      return null;
    }
  };
  try {
    const json = JSON.parse(readFileSync(storage, "utf8")) as {
      windowsState?: {
        lastActiveWindow?: { folder?: string; workspaceIdentifier?: { configURIPath?: string } };
        openedWindows?: { folder?: string }[];
      };
      backupWorkspaces?: { folders?: { folderUri: string }[] };
    };
    const last = toPath(json.windowsState?.lastActiveWindow?.folder);
    const open = new Set<string>();
    if (last) open.add(last);
    for (const w of json.windowsState?.openedWindows ?? []) {
      const p = toPath(w.folder);
      if (p) open.add(p);
    }
    for (const f of json.backupWorkspaces?.folders ?? []) {
      const p = toPath(f.folderUri);
      if (p) open.add(p);
    }
    return { lastActive: last, open: [...open] };
  } catch {
    return { open: [], note: "Couldn't read VS Code state." };
  }
}

/* ───────────── Reading ───────────── */

async function readText(p: string): Promise<string> {
  const st = await fs.stat(p).catch(() => {
    throw new FileToolError(`${p} doesn't exist.`);
  });
  if (st.isDirectory()) throw new FileToolError(`${p} is a folder.`);
  if (st.size > MAX_CODE_BYTES) throw new FileToolError(`${p} is too large to edit safely (${Math.round(st.size / 1024)} KB).`);
  if (BINARY_EXT.has(win.extname(p).toLowerCase())) throw new FileToolError(`${p} isn't a text file.`);
  const buf = await fs.readFile(p);
  if (buf.subarray(0, 8000).includes(0)) throw new FileToolError(`${p} looks binary, so I won't edit it.`);
  return buf.toString("utf8");
}

/** Read a code file with line numbers, optionally a line range. */
export async function readCode(input: string, startLine?: number, endLine?: number) {
  const p = resolveUserPath(input);
  assertOnAllowedDrive(p);
  const lines = (await readText(p)).split(/\r?\n/);
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? Math.min(lines.length, from + 799));
  const body = lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
    .join("\n");
  return { path: p, totalLines: lines.length, showing: `${from}-${to}`, content: body };
}

/* ───────────── Writing ───────────── */

async function assertEditable(p: string) {
  assertWritable(p);
  assertWritable(await realOrSelf(p));
}

const countOf = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

export async function editFile(input: string, oldText: string, newText: string, replaceAll = false) {
  const p = resolveUserPath(input);
  await assertEditable(p);
  const original = await readText(p);

  let find = oldText;
  let replace = newText;
  // Model text uses \n; keep Windows line endings intact when the file uses them.
  if (!original.includes(find) && original.includes("\r\n") && find.includes("\n")) {
    find = find.replace(/\r?\n/g, "\r\n");
    replace = replace.replace(/\r?\n/g, "\r\n");
  }
  const hits = countOf(original, find);
  if (hits === 0) throw new FileToolError("That exact text isn't in the file. Re-read it and copy the snippet exactly, including indentation.");
  if (hits > 1 && !replaceAll) {
    throw new FileToolError(`That text appears ${hits} times. Include more surrounding lines so it's unique, or set replace_all.`);
  }
  const firstLine = lineOf(original, original.indexOf(find));
  const updated = replaceAll ? original.split(find).join(replace) : original.replace(find, () => replace);

  const backup = backupPathFor(p, "edit");
  await fs.copyFile(p, backup);
  await fs.writeFile(p, updated, "utf8");
  recordOp("edit", backup, p);
  logActivity("code", win.basename(p), p);
  return { path: p, replacements: replaceAll ? hits : 1, line: firstLine, note: "Saved. Undo restores the previous version." };
}

export async function writeFile(input: string, content: string, overwrite = false) {
  const p = resolveUserPath(input);
  await assertEditable(p);
  await assertEditable(await realOrSelf(win.dirname(p)));
  const exists = existsSync(p);
  if (exists && !overwrite) {
    throw new FileToolError(`${p} already exists. Use edit_file for changes, or set overwrite to replace it completely.`);
  }
  if (exists) {
    await readText(p); // refuses binary / huge files
    const backup = backupPathFor(p, "overwrite");
    await fs.copyFile(p, backup);
    await fs.writeFile(p, content, "utf8");
    recordOp("overwrite", backup, p);
  } else {
    await fs.mkdir(win.dirname(p), { recursive: true });
    await fs.writeFile(p, content, { encoding: "utf8", flag: "wx" });
    recordOp("create-file", "", p);
    indexPath(p, false);
  }
  logActivity("code", win.basename(p), p);
  return { path: p, created: !exists, lines: content.split("\n").length, note: "Saved. Undo reverts it." };
}

/* ───────────── Searching inside a project ───────────── */

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".venv", "venv", "__pycache__", "bin", "obj", ".idea", ".vs", "coverage"]);

export async function searchInFiles(folder: string, query: string, extension?: string, maxResults = 40) {
  const root = resolveUserPath(folder);
  assertOnAllowedDrive(root);
  if (!query.trim()) throw new FileToolError("Give me some text to look for.");
  const needle = query.toLowerCase();
  const ext = extension ? `.${extension.replace(/^\./, "").toLowerCase()}` : null;
  const matches: { file: string; line: number; text: string }[] = [];
  let scanned = 0;
  const stack = [root];
  while (stack.length && matches.length < maxResults && scanned < 5000) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = win.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith(".")) stack.push(full);
        continue;
      }
      const fileExt = win.extname(e.name).toLowerCase();
      if (!e.isFile() || BINARY_EXT.has(fileExt) || (ext && fileExt !== ext)) continue;
      scanned++;
      let text: string;
      try {
        const st = await fs.stat(full);
        if (st.size > 1_000_000) continue;
        const buf = await fs.readFile(full);
        if (buf.subarray(0, 4000).includes(0)) continue;
        text = buf.toString("utf8");
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(needle)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
  }
  return { folder: root, filesScanned: scanned, matches, truncated: matches.length >= maxResults };
}
