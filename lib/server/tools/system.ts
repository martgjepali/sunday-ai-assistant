import "server-only";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config";
import { logActivity } from "../db";

/**
 * Windows plumbing for SUNDAY's PC tools. Scripts run through PowerShell via
 * -EncodedCommand (no quoting pitfalls); data goes in through stdin as UTF-8.
 */
export function powershell(script: string, input?: string, timeoutMs = 15_000): Promise<string> {
  const wrapped = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${script}`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim().split("\n")[0] || `PowerShell exited with ${code}`));
    });
    if (input !== undefined) child.stdin.end(input, "utf8");
    else child.stdin.end();
  });
}

/* ───────── Clipboard ───────── */

const MAX_CLIP = 50_000;

export async function readClipboard() {
  const text = await powershell("$t = Get-Clipboard -Raw; if ($null -eq $t) { '' } else { $t }");
  if (!text) return { empty: true, note: "The clipboard has no text (it may hold an image or nothing)." };
  return { text: text.length > MAX_CLIP ? text.slice(0, MAX_CLIP) + "\n…(truncated)" : text, length: text.length };
}

export async function writeClipboard(text: string) {
  await powershell("$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t", text);
  return { copied: true, length: text.length, note: "Sir can paste it with Ctrl+V." };
}

/* ───────── Native helper (volume + media keys) ───────── */

const NATIVE_CS = String.raw`
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out int c);
  int SetMasterVolumeLevel(float l, Guid g);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float l, Guid g); int SetChannelVolumeLevelScalar(uint ch, float l, Guid g);
  int GetChannelVolumeLevel(uint ch, out float l); int GetChannelVolumeLevelScalar(uint ch, out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IMMDevice { int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComImport]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IntPtr devices); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

public static class SundayNative {
  static IAudioEndpointVolume Endpoint() {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int GetVolume() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }
  public static void SetVolume(int percent) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, Guid.Empty)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty)); }

  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Key(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
`;

const NATIVE_DLL = path.join(DATA_DIR, "bin", "SundayNative-v1.dll");

/** Runs a PowerShell snippet with the SundayNative class loaded (compiled once, then cached as a DLL). */
async function native(script: string) {
  let load: string;
  if (existsSync(NATIVE_DLL)) {
    load = `Add-Type -Path '${NATIVE_DLL}'`;
  } else {
    mkdirSync(path.dirname(NATIVE_DLL), { recursive: true });
    const src = Buffer.from(NATIVE_CS, "utf8").toString("base64");
    load = `$src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${src}')); Add-Type -TypeDefinition $src -OutputAssembly '${NATIVE_DLL}' -OutputType Library; Add-Type -Path '${NATIVE_DLL}'`;
  }
  return powershell(`${load}; ${script}`);
}

const VK = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 } as const;

export async function mediaControl(action: keyof typeof VK) {
  await native(`[SundayNative]::Key(${VK[action]})`);
  logActivity("media", action.replace("_", "/"));
  return { done: action, note: "Sent to whatever is playing (Spotify, YouTube, music players)." };
}

export async function volume(action: "get" | "set" | "up" | "down" | "mute" | "unmute", level?: number, step = 10) {
  const script = {
    get: "",
    set: `[SundayNative]::SetVolume(${Math.round(level ?? 50)}); [SundayNative]::SetMute($false);`,
    up: `[SundayNative]::SetVolume([SundayNative]::GetVolume() + ${step}); [SundayNative]::SetMute($false);`,
    down: `[SundayNative]::SetVolume([SundayNative]::GetVolume() - ${step});`,
    mute: "[SundayNative]::SetMute($true);",
    unmute: "[SundayNative]::SetMute($false);",
  }[action];
  const out = await native(`${script} '{0}|{1}' -f [SundayNative]::GetVolume(), [SundayNative]::GetMute()`);
  const [vol, muted] = out.split("|");
  return { volume: Number(vol), muted: muted === "True" };
}

/* ───────── PC ───────── */

export async function systemStatus() {
  const json = await powershell(
    `
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
    $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
    $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; freeGB = [math]::Round($_.FreeSpace / 1GB, 1); totalGB = [math]::Round($_.Size / 1GB, 1) } }
    $top = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; memoryMB = [math]::Round($_.WorkingSet64 / 1MB) } }
    [pscustomobject]@{
      cpuPercent = $cpu
      ramUsedGB = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
      ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
      uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
      battery = if ($bat) { @{ percent = $bat.EstimatedChargeRemaining; charging = ($bat.BatteryStatus -eq 2) } } else { 'desktop (no battery)' }
      disks = @($disks)
      topMemoryApps = @($top)
    } | ConvertTo-Json -Depth 4 -Compress`,
    undefined,
    25_000,
  );
  return JSON.parse(json);
}

export async function lockPc() {
  await powershell("rundll32.exe user32.dll,LockWorkStation");
  logActivity("pc", "locked the PC");
  return { locked: true };
}

export async function showDesktop() {
  await powershell("(New-Object -ComObject Shell.Application).MinimizeAll()");
  return { done: "minimised all windows" };
}

export async function power(action: "shutdown" | "restart" | "sleep" | "cancel", confirmed: boolean, delayMinutes = 1) {
  if (action === "cancel") {
    await powershell("shutdown.exe /a").catch(() => {});
    logActivity("pc", "cancelled shutdown/restart");
    return { cancelled: true };
  }
  if (!confirmed) {
    return { error: "Not done: ask sir to confirm out loud first, then call again with confirmed=true." };
  }
  const secs = Math.max(0, Math.round(delayMinutes * 60));
  if (action === "sleep") await powershell("rundll32.exe powrprof.dll,SetSuspendState 0,1,0");
  else await powershell(`shutdown.exe ${action === "shutdown" ? "/s" : "/r"} /t ${secs} /c "SUNDAY: ${action} requested by sir"`);
  logActivity("pc", action, `${secs}s`);
  return action === "sleep"
    ? { sleeping: true }
    : { scheduled: action, inSeconds: secs, note: "He can say 'cancel the shutdown' until then." };
}

/** Processes SUNDAY must never close. */
const NEVER_CLOSE = "^(explorer|electron|node|sunday|svchost|csrss|winlogon|dwm|system|idle|lsass|services)$";

/** Politely closes an app's windows (like clicking X — the app can still ask to save). Never force-kills. */
export async function closeApplication(name: string) {
  const q = name.trim().replace(/['"`$]/g, "");
  if (!q) return { error: "Which app?" };
  const out = await powershell(
    [
      `$q = '${q}'`,
      `$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$q*" -or $_.MainWindowTitle -like "*$q*") }`,
      `$closed = @()`,
      `foreach ($p in $procs) { if ($p.ProcessName -match '${NEVER_CLOSE}') { continue }; if ($p.CloseMainWindow()) { $closed += ($p.ProcessName + ': ' + $p.MainWindowTitle) } }`,
      `$closed -join [Environment]::NewLine`,
    ].join("\n"),
  );
  const closed = out ? out.split(/\r?\n/).filter(Boolean) : [];
  if (closed.length) logActivity("app", `closed ${name}`);
  return closed.length
    ? { closed, note: "Asked politely — if there was unsaved work, the app will ask him to save." }
    : { error: `I couldn't find an open window for "${name}".` };
}
