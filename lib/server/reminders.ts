import "server-only";
import { db, kvGet, kvSet, logActivity } from "./db";

/**
 * Reminders and timers that actually fire. The UI polls for due items and
 * SUNDAY announces them out loud with a Windows notification — even when her
 * window is hidden. Missed ones (PC off, app closed) fire on next launch.
 */

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('reminder', 'timer')),
      text TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders(fired_at, cancelled_at, due_at);
  `);
  schemaReady = true;
}

export type Reminder = { id: number; kind: "reminder" | "timer"; text: string; due_at: number; fired_at: number | null };

const fmt = (t: number) =>
  new Date(t).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Accepts a local date-time like "2026-10-26T15:00" (no timezone = this PC's local time). */
function parseLocal(at: string): number | null {
  const m = at.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const t = new Date(y, mo - 1, d, h, mi, s || 0).getTime();
  return Number.isFinite(t) ? t : null;
}

export function createReminder(input: { kind: "reminder" | "timer"; text: string; at?: string; inMinutes?: number }) {
  ensureSchema();
  const now = Date.now();
  let due: number | null = null;
  if (input.inMinutes !== undefined) due = now + Math.round(input.inMinutes * 60_000);
  else if (input.at) due = parseLocal(input.at);
  if (due === null) return { error: "I need a time: either 'at' as YYYY-MM-DDTHH:mm local time, or 'in_minutes'." };
  if (due < now - 30_000) return { error: `That time (${fmt(due)}) is already in the past.` };
  const result = db()
    .prepare("INSERT INTO reminders(kind, text, due_at, created_at) VALUES (?, ?, ?, ?)")
    .run(input.kind, input.text.trim(), due, now);
  logActivity(input.kind, input.text.trim(), fmt(due));
  return { id: Number(result.lastInsertRowid), kind: input.kind, text: input.text.trim(), due: fmt(due) };
}

export function listReminders(includeFired = false) {
  ensureSchema();
  const rows = (
    includeFired
      ? db()
          .prepare(
            "SELECT id, kind, text, due_at, fired_at FROM reminders WHERE cancelled_at IS NULL AND (fired_at IS NULL OR fired_at > ?) ORDER BY due_at LIMIT 50",
          )
          .all(Date.now() - 86_400_000)
      : db()
          .prepare("SELECT id, kind, text, due_at, fired_at FROM reminders WHERE cancelled_at IS NULL AND fired_at IS NULL ORDER BY due_at LIMIT 50")
          .all()
  ) as Reminder[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, due: fmt(r.due_at), fired: Boolean(r.fired_at) }));
}

export function cancelReminder(id: number) {
  ensureSchema();
  const r = db()
    .prepare("UPDATE reminders SET cancelled_at = ? WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL")
    .run(Date.now(), id);
  return r.changes ? { cancelled: id } : { error: `No pending reminder #${id}.` };
}

/** Claim everything that's due (each item is handed out exactly once). */
export function claimDue() {
  ensureSchema();
  const now = Date.now();
  const due = db()
    .prepare("SELECT id, kind, text, due_at, fired_at FROM reminders WHERE fired_at IS NULL AND cancelled_at IS NULL AND due_at <= ? ORDER BY due_at")
    .all(now) as Reminder[];
  if (!due.length) return [];
  const mark = db().prepare("UPDATE reminders SET fired_at = ? WHERE id = ?");
  for (const r of due) mark.run(now, r.id);
  return due.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    dueAt: r.due_at,
    late: now - r.due_at > 5 * 60_000, // fired late because SUNDAY wasn't running
  }));
}

export function todaysReminders() {
  ensureSchema();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = start.getTime() + 86_400_000;
  return (
    db()
      .prepare("SELECT id, kind, text, due_at, fired_at FROM reminders WHERE cancelled_at IS NULL AND due_at >= ? AND due_at < ? ORDER BY due_at")
      .all(start.getTime(), end) as Reminder[]
  ).map((r) => ({ text: r.text, at: fmt(r.due_at), done: Boolean(r.fired_at) }));
}

/* ───────── Weather (Open-Meteo: free, no key) ───────── */

const WEATHER: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "heavy showers", 82: "violent showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
};

type Place = { name: string; country: string; latitude: number; longitude: number };

async function geocode(city: string): Promise<Place | null> {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(city)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: Place[] };
  return body.results?.[0] ?? null;
}

export async function weather(city?: string) {
  const place = city ? await geocode(city) : kvGet<Place>("home_place");
  if (!place) return { error: city ? `I couldn't find a place called "${city}".` : "home city unknown" };
  if (city) kvSet("home_place", place); // remember sir's city for next time
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunrise,sunset",
    timezone: "auto",
    forecast_days: "1",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return { error: `Weather service error ${res.status}` };
  const w = (await res.json()) as {
    current: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[]; weather_code: number[]; sunset: string[] };
  };
  return {
    place: `${place.name}, ${place.country}`,
    now: `${Math.round(w.current.temperature_2m)}°C (feels ${Math.round(w.current.apparent_temperature)}°C), ${WEATHER[w.current.weather_code] ?? "unknown"}, wind ${Math.round(w.current.wind_speed_10m)} km/h`,
    today: `${WEATHER[w.daily.weather_code[0]] ?? "mixed"}, ${Math.round(w.daily.temperature_2m_min[0])}–${Math.round(w.daily.temperature_2m_max[0])}°C, ${w.daily.precipitation_probability_max[0] ?? 0}% chance of rain`,
    sunset: w.daily.sunset[0]?.slice(11, 16),
  };
}

export function markBriefed() {
  kvSet("last_briefing_day", new Date().toDateString());
}

export function briefedToday() {
  return kvGet<string>("last_briefing_day") === new Date().toDateString();
}
