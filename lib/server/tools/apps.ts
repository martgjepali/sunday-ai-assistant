import "server-only";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { HOME } from "../config";
import { logActivity } from "../db";
import { FileToolError, resolveUserPath } from "./files";

const win = path.win32;
const env = (name: string) => process.env[name] ?? "";

function launch(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", cwd: HOME, ...opts });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * `start` gives us ShellExecute semantics (new console windows, UAC, protocols).
 * Only ever called with fixed command strings defined in this file.
 */
function shellStart(target: string) {
  return launch("cmd.exe", ["/d", "/c", `start "" /D "${HOME}" ${target}`], {
    windowsVerbatimArguments: true,
  });
}

function firstExisting(paths: string[]) {
  return paths.find((p) => p && existsSync(p));
}

export type BrowserName = "firefox" | "chrome" | "edge" | "brave" | "default";

function browserExe(name: BrowserName): string | undefined {
  const pf = env("ProgramFiles");
  const pf86 = env("ProgramFiles(x86)");
  const local = env("LOCALAPPDATA");
  switch (name) {
    case "firefox":
      return firstExisting([
        win.join(pf, "Mozilla Firefox", "firefox.exe"),
        win.join(pf86, "Mozilla Firefox", "firefox.exe"),
        win.join(local, "Mozilla Firefox", "firefox.exe"),
      ]);
    case "chrome":
      return firstExisting([
        win.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        win.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        win.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      ]);
    case "edge":
      return firstExisting([
        win.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        win.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      ]);
    case "brave":
      return firstExisting([
        win.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        win.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ]);
    default:
      return undefined;
  }
}

export const DEFAULT_BROWSER = (process.env.SUNDAY_BROWSER ?? "firefox") as BrowserName;

export async function openUrl(rawUrl: string, browser: BrowserName = DEFAULT_BROWSER) {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new FileToolError(`"${rawUrl}" isn't a valid web address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FileToolError("I only open http and https links.");
  }
  const exe = browserExe(browser);
  if (exe) {
    await launch(exe, browser === "firefox" ? ["-new-tab", url.href] : [url.href]);
  } else {
    // Fall back to the system default browser.
    await launch("rundll32.exe", ["url.dll,FileProtocolHandler", url.href]);
  }
  logActivity("web", url.hostname, url.href);
  return { opened: url.href, browser: exe ? browser : "default" };
}

const SEARCH_ENGINES: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  youtube: "https://www.youtube.com/results?search_query=",
  bing: "https://www.bing.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=",
  maps: "https://www.google.com/maps/search/",
  github: "https://github.com/search?q=",
  amazon: "https://www.amazon.com/s?k=",
};

export async function browserSearch(query: string, engine = "google", browser?: BrowserName) {
  const base = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google;
  const result = await openUrl(base + encodeURIComponent(query), browser);
  logActivity("search", query, engine);
  return { ...result, query, engine };
}

/** Programs that deserve a fixed, reliable launch path. */
const BUILT_IN: Record<string, { label: string; run: (admin: boolean) => Promise<void> }> = {
  "command prompt": {
    label: "Command Prompt",
    run: (admin) => (admin ? elevate("cmd.exe") : shellStart("cmd.exe")),
  },
  powershell: {
    label: "PowerShell",
    run: (admin) => (admin ? elevate("powershell.exe") : shellStart("powershell.exe")),
  },
  terminal: {
    label: "Windows Terminal",
    run: (admin) => (admin ? elevate("wt.exe") : shellStart("wt.exe")),
  },
  "file explorer": { label: "File Explorer", run: () => launch("explorer.exe", []) },
  notepad: { label: "Notepad", run: () => shellStart("notepad.exe") },
  calculator: { label: "Calculator", run: () => shellStart("calc.exe") },
  paint: { label: "Paint", run: () => shellStart("mspaint.exe") },
  "task manager": { label: "Task Manager", run: () => shellStart("taskmgr.exe") },
  "control panel": { label: "Control Panel", run: () => shellStart("control.exe") },
  settings: { label: "Settings", run: () => shellStart("ms-settings:") },
  "snipping tool": { label: "Snipping Tool", run: () => shellStart("ms-screenclip:") },
  "program files": {
    label: "Program Files",
    run: () => launch("explorer.exe", [env("ProgramFiles") || "C:\\Program Files"]),
  },
};

const ALIASES: Record<string, string> = {
  cmd: "command prompt",
  "cmd prompt": "command prompt",
  "command line": "command prompt",
  "power shell": "powershell",
  "windows terminal": "terminal",
  explorer: "file explorer",
  "my computer": "file explorer",
  "this pc": "file explorer",
  calc: "calculator",
  "task mgr": "task manager",
  "screenshot tool": "snipping tool",
  "programs folder": "program files",
  "vs code": "visual studio code",
  vscode: "visual studio code",
  code: "visual studio code",
  word: "word",
  excel: "excel",
  mozilla: "firefox",
  "mozilla firefox": "firefox",
  "google chrome": "chrome",
  "microsoft edge": "edge",
};

function elevate(exe: "cmd.exe" | "powershell.exe" | "wt.exe") {
  return launch("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", `Start-Process ${exe} -Verb RunAs`]);
}

type StartApp = { Name: string; AppID: string };
let catalog: { at: number; apps: StartApp[] } | null = null;

/** Everything on the Start menu, including Store apps, via Get-StartApps. */
export function startApps(): Promise<StartApp[]> {
  if (catalog && Date.now() - catalog.at < 10 * 60 * 1000) return Promise.resolve(catalog.apps);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => {
        if (err) return resolve(catalog?.apps ?? []);
        try {
          const parsed = JSON.parse(stdout) as StartApp | StartApp[];
          const apps = (Array.isArray(parsed) ? parsed : [parsed]).filter((a) => a?.Name && a?.AppID);
          catalog = { at: Date.now(), apps };
          resolve(apps);
        } catch {
          resolve(catalog?.apps ?? []);
        }
      },
    );
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function scoreName(query: string, name: string) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q + " ") || n.startsWith(q)) return 80 - Math.min(20, n.length - q.length);
  if (n.includes(q)) return 60 - Math.min(20, n.length - q.length);
  const qt = q.split(" ");
  const nt = new Set(n.split(" "));
  const hits = qt.filter((t) => nt.has(t)).length;
  return hits ? (hits / qt.length) * 50 : 0;
}

export async function openApplication(name: string, admin = false) {
  const key = norm(name);
  const canonical = ALIASES[key] ?? key;

  const builtIn = BUILT_IN[canonical];
  if (builtIn) {
    await builtIn.run(admin);
    logActivity("app", builtIn.label);
    return { opened: builtIn.label, admin };
  }

  const browser = (["firefox", "chrome", "edge", "brave"] as const).find((b) => b === canonical);
  if (browser) {
    const exe = browserExe(browser);
    if (exe) {
      await launch(exe, []);
      logActivity("app", browser[0].toUpperCase() + browser.slice(1));
      return { opened: browser };
    }
  }

  const apps = await startApps();
  const ranked = apps
    .map((a) => ({ app: a, score: scoreName(canonical, a.Name) }))
    .filter((r) => r.score >= 40)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    throw new FileToolError(
      `I couldn't find "${name}" among your installed programs. It may not be installed, or it might go by another name.`,
    );
  }
  const best = ranked[0].app;
  await launch("explorer.exe", [`shell:AppsFolder\\${best.AppID}`]);
  logActivity("app", best.Name);
  return {
    opened: best.Name,
    alternatives: ranked.slice(1, 4).map((r) => r.app.Name),
  };
}

export async function openPath(input: string, reveal = false) {
  const p = resolveUserPath(input);
  if (!existsSync(p)) throw new FileToolError(`${p} doesn't exist.`);
  if (reveal) {
    // Paths can't contain quotes on Windows, so this verbatim form is safe.
    await launch("explorer.exe", [`/select,"${p}"`], { windowsVerbatimArguments: true });
  } else {
    await launch("explorer.exe", [p]);
  }
  const isDir = statSync(p).isDirectory();
  logActivity(isDir ? "folder" : "file", win.basename(p) || p, p);
  return { opened: p, kind: isDir ? "folder" : "file", revealed: reveal };
}

export function availableBrowsers() {
  return (["firefox", "chrome", "edge", "brave"] as const).filter((b) => browserExe(b));
}
