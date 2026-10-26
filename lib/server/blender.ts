import "server-only";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { driveRoots } from "./config";
import { kvGet, kvSet, logActivity } from "./db";
import { indexPath } from "./indexer";
import { FileToolError, assertOnAllowedDrive, assertWritable, realOrSelf, recordOp, resolveUserPath, uniqueTarget } from "./tools/files";

/**
 * SUNDAY in Blender. She starts Blender with blender/sunday_bridge.py, which listens on
 * 127.0.0.1 and runs her requests on Blender's main thread: build with bpy code (restricted:
 * no files, shell or imports beyond Blender's own), look at the model from any angle,
 * import models, and save .blend files (never over an existing one).
 */

const PORT = Number(process.env.SUNDAY_BLENDER_PORT ?? 9876);
const BRIDGE = path.join(process.cwd(), "blender", "sunday_bridge.py");

/** blender.exe: SUNDAY_BLENDER, else Program Files or a "Blender…" folder at the root of an allowed drive. */
export function findBlender(): string | null {
  const configured = process.env.SUNDAY_BLENDER;
  if (configured) return existsSync(configured) ? configured : null;
  const homes = [
    ...["C:\\Program Files\\Blender Foundation", "C:\\Program Files (x86)\\Blender Foundation"].flatMap((base) => {
      try {
        return readdirSync(base).map((d) => path.win32.join(base, d));
      } catch {
        return [];
      }
    }),
    ...driveRoots().flatMap((root) => {
      try {
        return readdirSync(root).filter((d) => /^blender/i.test(d)).map((d) => path.win32.join(root, d));
      } catch {
        return [];
      }
    }),
  ];
  // Newest version first ("Blender 5.1" before "Blender 4.2").
  const found = homes.map((h) => path.win32.join(h, "blender.exe")).filter((exe) => existsSync(exe));
  return found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
}

/** The token Blender was started with — kept in the database so a restarted SUNDAY can still reach it. */
function token() {
  let t = kvGet<string>("blender_token");
  if (!t) kvSet("blender_token", (t = randomBytes(18).toString("hex")));
  return t;
}

type Reply = { ok: boolean; result?: Record<string, unknown>; error?: string; trace?: string };

function send(type: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: PORT });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new FileToolError("Blender didn't answer in time — it may be busy or frozen."));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ token: token(), type, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch {
        reject(new FileToolError("Blender sent something I couldn't read."));
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function call(type: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
  let reply: Reply;
  try {
    reply = await send(type, params, timeoutMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      throw new FileToolError("Blender isn't open with my bridge — call blender_open first.");
    }
    throw err;
  }
  if (reply.error === "wrong token") {
    throw new FileToolError(
      "Something else is using Blender's bridge port (probably a Blender I didn't start). Ask sir to close Blender, then call blender_open.",
    );
  }
  if (!reply.ok) throw new FileToolError(`Blender: ${reply.error}${reply.trace ? `\n${reply.trace}` : ""}`);
  return reply.result ?? {};
}

export async function blenderStatus() {
  try {
    return { connected: true, ...(await call("ping", {}, 4000)) };
  } catch {
    return { connected: false, installed: findBlender() ?? "not found" };
  }
}

/** Starts Blender with the bridge (or reuses the one already connected), optionally opening a .blend file. */
export async function openBlender(file?: string) {
  const status = await blenderStatus();
  if (status.connected) {
    if (file) throw new FileToolError("Blender is already open — ask sir to open that file from Blender, or close it and I'll reopen with it.");
    return { ...status, note: "Blender was already open and connected." };
  }
  const exe = findBlender();
  if (!exe) throw new FileToolError("I can't find Blender. Set SUNDAY_BLENDER to the full path of blender.exe.");
  const args: string[] = [];
  if (file) {
    const p = resolveUserPath(file);
    assertOnAllowedDrive(p);
    if (!existsSync(p)) throw new FileToolError(`${p} doesn't exist.`);
    args.push(p);
  }
  args.push("--python", BRIDGE);
  spawn(exe, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SUNDAY_BLENDER_PORT: String(PORT), SUNDAY_BLENDER_TOKEN: token() },
  }).unref();
  logActivity("blender", "opened Blender", file ?? "");
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await blenderStatus();
    if (s.connected) return { ...s, opened: exe };
  }
  throw new FileToolError("Blender started but its bridge never answered (90s). Is it stuck on a dialog?");
}

export async function blenderScene() {
  return call("scene");
}

export async function blenderRun(code: string) {
  return call("run", { code }, 600_000);
}

/** Renders the viewport from an angle and returns the picture so SUNDAY can check her work. */
export async function blenderLook(opts: { view?: string; objects?: string[]; shading?: string }) {
  const r = await call("look", opts, 180_000);
  const data = await fs.readFile(String(r.image));
  return { view: r.view, framed: r.framed, data: data.toString("base64") };
}

export async function blenderImport(file: string) {
  const p = resolveUserPath(file);
  assertOnAllowedDrive(p);
  if (!existsSync(p)) throw new FileToolError(`${p} doesn't exist.`);
  return call("import", { path: p }, 300_000);
}

/** Saves the scene as a new .blend file — never over an existing one. Undo sets the file aside. */
export async function blenderSave(folder: string, name: string) {
  const dir = resolveUserPath(folder);
  assertWritable(dir);
  assertWritable(await realOrSelf(path.win32.dirname(dir)));
  const clean = name.replace(/\.blend$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").trim() || "SUNDAY model";
  const target = uniqueTarget(path.win32.join(dir, `${clean}.blend`));
  const r = await call("save", { path: target }, 300_000);
  recordOp("create-file", "", target);
  indexPath(target, false);
  logActivity("blender", path.win32.basename(target), target);
  return { ...r, saved: target, note: "Saved. Blender is now working on this file." };
}
