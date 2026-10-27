import "server-only";
import { logActivity } from "./db";
import { CALENDAR_SCOPE, gmailAccount, googleAccessToken, googleHas } from "./tools/gmail";
import { FileToolError } from "./tools/files";

/**
 * Google Calendar (sir's primary calendar). SUNDAY reads, adds and reschedules events.
 * She never deletes events and never invites anyone — invitations would email other
 * people, and like Gmail she never sends anything. Changes go out with sendUpdates=none.
 */

const API = (process.env.SUNDAY_CALENDAR_API ?? "https://www.googleapis.com/calendar/v3/calendars/primary").replace(/\/+$/, "");
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Heads-up this long before a timed event starts. */
const ALERT_MINUTES = 10;

type GEvent = {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  recurringEventId?: string;
  organizer?: { self?: boolean; email?: string };
  attendees?: { self?: boolean; email?: string; responseStatus?: string }[];
};

export function calendarReady() {
  return googleHas(CALENDAR_SCOPE);
}

function needCalendar() {
  if (!gmailAccount()) throw new FileToolError("Google isn't connected yet — sir can connect it from the Systems panel.");
  if (!calendarReady()) {
    throw new FileToolError("Calendar needs one more permission — sir should press Reconnect next to Google in the Systems panel.");
  }
}

async function api<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
  needCalendar();
  const res = await fetch(`${API}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${await googleAccessToken()}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 403) {
    const text = await res.text();
    if (/insufficient|scope/i.test(text)) throw new FileToolError("Calendar permission is missing — sir should press Reconnect next to Google.");
    if (/accessNotConfigured|has not been used|disabled/i.test(text)) {
      throw new FileToolError("The Google Calendar API is switched off for SUNDAY's Google Cloud project — sir needs to enable it there.");
    }
    throw new FileToolError(`Calendar refused (403): ${text.slice(0, 160)}`);
  }
  if (!res.ok) throw new FileToolError(`Calendar error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** "2026-10-28T15:00" (sir's local time) or "2026-10-28" → Date. */
function parseLocal(s: string, what: string) {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s);
  if (Number.isNaN(d.getTime())) throw new FileToolError(`I couldn't read the ${what} "${s}" — use e.g. 2026-10-28T15:00.`);
  return d;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localIso = (d: Date) => `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
const when = (d: Date) =>
  d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function startOf(e: GEvent) {
  return e.start.dateTime ? new Date(e.start.dateTime) : parseLocal(e.start.date!, "date");
}
function endOf(e: GEvent) {
  return e.end.dateTime ? new Date(e.end.dateTime) : parseLocal(e.end.date!, "date");
}

/** What SUNDAY sees of an event — local times, nothing she doesn't need. */
function brief(e: GEvent) {
  const allDay = !e.start.dateTime;
  const others = (e.attendees ?? []).filter((a) => !a.self).length;
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    when: allDay ? `${day(startOf(e))} (all day)` : `${when(startOf(e))}–${endOf(e).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { notes: e.description.slice(0, 200) } : {}),
    ...(others ? { with_others: others } : {}),
    ...(e.recurringEventId ? { repeats: true } : {}),
  };
}

async function fetchEvents(from: Date, to: Date, query?: string, max = 50) {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(Math.min(max, 250)),
    timeZone: TZ,
  });
  if (query) params.set("q", query);
  const r = await api<{ items?: GEvent[] }>(`/events?${params}`);
  return (r.items ?? []).filter((e) => e.status !== "cancelled");
}

/** Events between two local times (default: now → 7 days). */
export async function listEvents(input: { from?: string; to?: string; query?: string }) {
  const from = input.from ? parseLocal(input.from, "start") : new Date();
  const to = input.to ? parseLocal(input.to, "end") : new Date(from.getTime() + 7 * 86_400_000);
  if (input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to)) to.setDate(to.getDate() + 1); // a date means "through that day"
  const events = await fetchEvents(from, to, input.query);
  return { from: when(from), to: when(to), timeZone: TZ, count: events.length, events: events.map(brief) };
}

export async function todaysEvents() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  return (await fetchEvents(start, end)).map(brief);
}

/** Adds an event. If it clashes with something, nothing is created until sir says so. */
export async function addEvent(input: {
  title: string;
  start: string;
  end?: string;
  minutes?: number;
  allDay?: boolean;
  location?: string;
  notes?: string;
  reminderMinutes?: number;
  despiteClash?: boolean;
}) {
  const start = parseLocal(input.start, "start");
  let end: Date;
  if (input.allDay) {
    end = input.end ? parseLocal(input.end, "end") : new Date(start);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
  } else {
    end = input.end ? parseLocal(input.end, "end") : new Date(start.getTime() + (input.minutes ?? 60) * 60_000);
  }
  if (end <= start) throw new FileToolError("The event would end before it starts.");

  if (!input.despiteClash) {
    const clashes = (await fetchEvents(start, end)).filter((e) => input.allDay || e.start.dateTime);
    if (clashes.length) {
      return {
        created: false,
        clashes: clashes.map(brief),
        note: "Nothing was added. Tell sir what it clashes with and ask; if he still wants it, call again with despite_clash.",
      };
    }
  }

  const body = {
    summary: input.title.trim(),
    ...(input.location ? { location: input.location } : {}),
    ...(input.notes ? { description: input.notes } : {}),
    start: input.allDay ? { date: ymd(start) } : { dateTime: localIso(start), timeZone: TZ },
    end: input.allDay ? { date: ymd(end) } : { dateTime: localIso(end), timeZone: TZ },
    reminders:
      input.reminderMinutes != null
        ? { useDefault: false, overrides: [{ method: "popup", minutes: input.reminderMinutes }] }
        : { useDefault: true },
  };
  const e = await api<GEvent>(`/events?sendUpdates=none`, { method: "POST", body: JSON.stringify(body) });
  logActivity("calendar", `added ${body.summary}`, when(start));
  forgetCache();
  return { created: true, event: brief(e) };
}

/** Reschedules or renames one of sir's own events. Events with other people are his to change. */
export async function changeEvent(input: {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  notes?: string;
}) {
  const current = await api<GEvent>(`/events/${encodeURIComponent(input.id)}`);
  const others = (current.attendees ?? []).filter((a) => !a.self).length;
  if (others || current.organizer?.self === false) {
    throw new FileToolError("That event involves other people — changing it would affect them, so sir should change it himself.");
  }
  const patch: Record<string, unknown> = {};
  if (input.title) patch.summary = input.title;
  if (input.location != null) patch.location = input.location;
  if (input.notes != null) patch.description = input.notes;
  if (input.start) {
    const start = parseLocal(input.start, "start");
    const length = endOf(current).getTime() - startOf(current).getTime();
    const end = input.end ? parseLocal(input.end, "end") : new Date(start.getTime() + length);
    if (current.start.date) {
      patch.start = { date: ymd(start) };
      patch.end = { date: ymd(new Date(start.getTime() + Math.max(length, 86_400_000))) };
    } else {
      patch.start = { dateTime: localIso(start), timeZone: TZ };
      patch.end = { dateTime: localIso(end), timeZone: TZ };
    }
  } else if (input.end && current.start.dateTime) {
    patch.end = { dateTime: localIso(parseLocal(input.end, "end")), timeZone: TZ };
  }
  if (!Object.keys(patch).length) throw new FileToolError("Nothing to change.");
  const e = await api<GEvent>(`/events/${encodeURIComponent(input.id)}?sendUpdates=none`, { method: "PATCH", body: JSON.stringify(patch) });
  logActivity("calendar", `changed ${e.summary ?? ""}`, brief(e).when);
  forgetCache();
  return { changed: true, before: brief(current), after: brief(e) };
}

/* ───────── Heads-up before events, and a line for SUNDAY's context ───────── */

const g = globalThis as unknown as { __sundayCal?: { at: number; events: GEvent[]; announced: Set<string>; loading?: Promise<void> } };
const cache = (g.__sundayCal ??= { at: 0, events: [], announced: new Set() });

function forgetCache() {
  cache.at = 0;
}

/** Keeps the next 24 hours of events in memory, refreshed every 5 minutes in the background. */
function refreshSoon() {
  if (!calendarReady() || cache.loading || Date.now() - cache.at < 5 * 60_000) return;
  const now = new Date();
  cache.loading = fetchEvents(now, new Date(now.getTime() + 86_400_000))
    .then((events) => {
      cache.events = events;
      cache.at = Date.now();
    })
    .catch(() => {
      cache.at = Date.now(); // try again in 5 minutes, not on every poll
    })
    .finally(() => (cache.loading = undefined));
}

/** Notices for timed events starting within the next few minutes — each announced once. */
export function calendarAlerts() {
  refreshSoon();
  const now = Date.now();
  const out: { title: string; text: string }[] = [];
  for (const e of cache.events) {
    if (!e.start.dateTime) continue;
    const start = new Date(e.start.dateTime).getTime();
    const key = `${e.id}@${start}`;
    if (start <= now || start - now > ALERT_MINUTES * 60_000 || cache.announced.has(key)) continue;
    cache.announced.add(key);
    const mins = Math.max(1, Math.round((start - now) / 60_000));
    out.push({
      title: "SUNDAY — coming up",
      text: `Sir, "${e.summary ?? "an event"}" starts in ${mins} minute${mins === 1 ? "" : "s"}${e.location ? `, at ${e.location}` : ""}.`,
    });
  }
  return out;
}

/** "Calendar: Dentist 15:00, Gym 18:30" — the rest of today, from the cache (never waits on Google). */
export function calendarLine() {
  refreshSoon();
  if (!calendarReady()) return "";
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const left = cache.events.filter((e) => e.start.dateTime && endOf(e) > now && startOf(e) <= endOfDay).slice(0, 5);
  if (!cache.at) return "";
  if (!left.length) return "Calendar: nothing else today.";
  return `Calendar today: ${left
    .map((e) => `${e.summary ?? "(no title)"} ${startOf(e).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`)
    .join(", ")}.`;
}
