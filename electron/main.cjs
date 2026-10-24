// SUNDAY desktop shell: a frameless, always-available window around the local
// Next.js server. Closing hides to the tray so "Hey Sunday" keeps working.

// Launched from inside VS Code (or any tool that sets ELECTRON_RUN_AS_NODE),
// Electron behaves like plain Node and `require("electron")` is just a path.
// Relaunch ourselves as a real Electron app in that case.
if (typeof require("electron") === "string") {
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, process.argv.slice(1), { env, stdio: "inherit", detached: false });
  child.on("exit", (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, shell, session, dialog, powerMonitor } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.SUNDAY_PORT || 3210);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEV = process.argv.includes("--dev");
const HOTKEY = "Control+Shift+Space";

let win = null;
let tray = null;
let server = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(ORIGIN, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function startServer() {
  if (await ping()) return; // already running (e.g. `npm run dev` in a terminal)
  if (!DEV && !existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    dialog.showErrorBox("SUNDAY isn't built yet", "Run `npm run build` once, then start SUNDAY again.\n(Or use `npm run desktop:dev`.)");
    app.exit(1);
    return;
  }
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  server = spawn(process.env.SUNDAY_NODE || "node", [nextBin, DEV ? "dev" : "start", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUNDAY_PORT: String(PORT) },
    stdio: "inherit",
    windowsHide: true,
  });
  server.on("exit", (code) => {
    server = null;
    if (!quitting) console.error(`[sunday] server exited with code ${code}`);
  });
}

/** A small amber ring with a violet core, drawn in code so no image asset is needed. */
/** SUNDAY's icon (electron/icon.png), falling back to the drawn ring if it's missing. */
function appIcon(size) {
  const file = path.join(__dirname, "icon.png");
  if (existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img.resize({ width: size, height: size, quality: "best" });
  }
  return makeIcon(size);
}

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / (size / 2);
      let r = 0, g = 0, b = 0, a = 0;
      if (d > 0.72 && d < 0.95) [r, g, b, a] = [255, 197, 107, 255];
      else if (d < 0.42) [r, g, b, a] = [164, 139, 255, 255];
      const i = (y * size + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    show: false,
    title: "SUNDAY",
    backgroundColor: "#04050a",
    icon: appIcon(256),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep the wake word alive while hidden
    },
  });
  win.maximize();
  win.loadURL(ORIGIN);
  win.once("ready-to-show", () => win.show());

  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Links (e.g. Google sign-in) open in the real browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
}

function createTray() {
  tray = new Tray(appIcon(16));
  tray.setToolTip("SUNDAY");
  const autoStart = () => app.getLoginItemSettings(loginArgs()).openAtLogin;
  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show SUNDAY", click: showWindow },
        { label: `Talk  (${HOTKEY.replace(/\+/g, " + ")})`, click: summon },
        { type: "separator" },
        {
          label: "Start with Windows",
          type: "checkbox",
          checked: autoStart(),
          click: (item) => {
            setAutoStart(item.checked);
            rebuild();
          },
        },
        { type: "separator" },
        { label: "Quit SUNDAY", click: () => app.quit() },
      ]),
    );
  rebuild();
  tray.on("click", showWindow);
}

function loginArgs() {
  return process.defaultApp ? { path: process.execPath, args: [path.resolve(ROOT)] } : {};
}

function setAutoStart(on) {
  const opts = loginArgs();
  app.setLoginItemSettings({ openAtLogin: on, ...opts });
  return app.getLoginItemSettings(opts).openAtLogin;
}

function summon() {
  showWindow();
  win?.webContents.send("sunday:summon");
}

// One identity for the window, taskbar button and pinned shortcut.
app.setName("SUNDAY");
if (process.platform === "win32") app.setAppUserModelId("com.sunday.assistant");

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  const allowed = new Set(["media", "clipboard-sanitized-write", "notifications"]);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) =>
    cb(allowed.has(permission) && String(details.requestingUrl || "").startsWith(ORIGIN)),
  );
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && String(origin).startsWith(ORIGIN));

  ipcMain.on("win:minimize", () => win?.minimize());
  ipcMain.on("win:hide", () => win?.hide());
  ipcMain.on("win:fullscreen", () => win?.setFullScreen(!win.isFullScreen()));
  ipcMain.handle("autostart:get", () => app.getLoginItemSettings(loginArgs()).openAtLogin);
  ipcMain.handle("autostart:set", (_e, on) => setAutoStart(Boolean(on)));

  await startServer();
  if (!(await waitForServer())) {
    dialog.showErrorBox("SUNDAY couldn't start", `The local server never answered on ${ORIGIN}.`);
    app.exit(1);
    return;
  }
  createWindow();
  createTray();

  // SUNDAY locks with Windows: nobody can talk to her without getting into sir's account.
  const lock = () => win?.webContents.send("sunday:lock");
  powerMonitor.on("lock-screen", lock);
  powerMonitor.on("suspend", lock);
  powerMonitor.on("unlock-screen", () => win?.webContents.send("sunday:unlock"));
  if (!globalShortcut.register(HOTKEY, summon)) console.warn(`[sunday] couldn't register ${HOTKEY}`);
});

app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (server) server.kill();
});
app.on("window-all-closed", () => {
  // Stay alive in the tray.
});
