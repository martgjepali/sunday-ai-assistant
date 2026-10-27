import "server-only";
import { randomInt } from "node:crypto";
import { describeError, runAgent, type AgentEvent } from "./agent";
import { fulfill } from "./bridge";
import { calendarAlerts } from "./calendar";
import { kvGet, kvSet, logActivity } from "./db";
import { ensureConversation } from "./memory";
import { claimNotices } from "./notices";
import { sirAway } from "./presence";
import { claimDue } from "./reminders";

/**
 * SUNDAY on sir's phone through his own Telegram bot (long polling — nothing is
 * exposed to the internet). Only the one Telegram account paired with a code from
 * the Systems panel is answered; everyone else gets silence and a security log entry.
 * From the phone she can do everything except take control of the PC (REMOTE_BLOCKED in tools/index.ts).
 */

type Owner = { userId: number; chatId: number; name: string; pairedAt: number };
type TgUser = { id: number; username?: string; first_name?: string };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string };
};
type TgUpdate = { update_id: number; message?: TgMessage };

const MAX_CHUNK = 3900;
/** A new phone conversation starts after this much quiet. */
const NEW_CHAT_AFTER_MS = 6 * 3_600_000;

const API = (process.env.SUNDAY_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/+$/, "");
const token = () => process.env.TELEGRAM_BOT_TOKEN ?? "";
export const telegramConfigured = () => Boolean(token()) && process.env.SUNDAY_TELEGRAM !== "off";

async function tg<T>(method: string, body?: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!json.ok) {
    const err = new Error(`Telegram ${method}: ${json.description ?? res.status}`) as Error & { code?: number };
    err.code = json.error_code ?? res.status;
    throw err;
  }
  return json.result as T;
}

const owner = () => kvGet<Owner>("telegram_owner") ?? null;

export function telegramStatus() {
  const o = owner();
  return {
    configured: telegramConfigured(),
    bot: state.bot,
    paired: o ? o.name : null,
    error: state.error,
  };
}

/** A fresh one-time code; sir sends "/pair 123456" to his bot within 10 minutes. */
export function startPairing() {
  if (!telegramConfigured()) throw new Error("TELEGRAM_BOT_TOKEN is missing from .env.");
  const code = String(randomInt(100_000, 1_000_000));
  kvSet("telegram_pair", { code, exp: Date.now() + 10 * 60_000 });
  return { code, bot: state.bot };
}

export function unpair() {
  kvSet("telegram_owner", null);
  logActivity("security", "Telegram unpaired", "");
}

/* ───────── Polling ───────── */

const g = globalThis as unknown as {
  __sundayTelegram?: { running: boolean; bot: string | null; error: string | null; busy: Promise<void> };
};
const state = (g.__sundayTelegram ??= { running: false, bot: null, error: null, busy: Promise.resolve() });

export function startTelegram() {
  if (!telegramConfigured() || state.running) return;
  state.running = true;
  void (async () => {
    try {
      const me = await tg<{ username: string }>("getMe");
      state.bot = me.username;
      await tg("setMyCommands", {
        commands: [
          { command: "new", description: "Start a fresh conversation" },
          { command: "help", description: "What I can do from here" },
        ],
      }).catch(() => {});
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      console.warn("[sunday] telegram:", state.error);
    }
    let offset = kvGet<number>("telegram_offset") ?? 0;
    let backoff = 2000;
    for (;;) {
      try {
        const updates = await tg<TgUpdate[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
        state.error = null;
        backoff = 2000;
        for (const u of updates) {
          offset = u.update_id + 1;
          kvSet("telegram_offset", offset);
          if (u.message) state.busy = state.busy.then(() => handle(u.message!)).catch(() => {});
        }
      } catch (err) {
        const code = (err as { code?: number }).code;
        state.error =
          code === 401
            ? "The Telegram bot token was rejected."
            : code === 409
              ? "Another copy of SUNDAY is already listening to this bot."
              : err instanceof Error
                ? err.message
                : String(err);
        await new Promise((r) => setTimeout(r, code === 409 ? 60_000 : backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
  setInterval(() => void forwardWhileAway(), 15_000);
}

async function say(chatId: number, text: string) {
  const plain = text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
  for (let i = 0; i < plain.length; i += MAX_CHUNK) {
    await tg("sendMessage", { chat_id: chatId, text: plain.slice(i, i + MAX_CHUNK) });
  }
}

async function handle(msg: TgMessage) {
  const from = msg.from;
  if (!from || msg.chat.type !== "private") return;
  const o = owner();

  if (!o) {
    // Not paired yet: the only thing anyone can do is pair with the current code. No replies otherwise.
    const m = msg.text?.trim().match(/^\/pair\s+(\d{6})$/);
    const pending = kvGet<{ code: string; exp: number }>("telegram_pair");
    if (m && pending && pending.code === m[1] && Date.now() < pending.exp) {
      const name = from.username ? `@${from.username}` : (from.first_name ?? String(from.id));
      kvSet("telegram_owner", { userId: from.id, chatId: msg.chat.id, name, pairedAt: Date.now() } satisfies Owner);
      kvSet("telegram_pair", null);
      logActivity("security", "Telegram paired", name);
      await say(msg.chat.id, "Paired. It's me, sir — SUNDAY. Message me or send a voice note any time; I'll also send your reminders and calendar alerts here while you're away from the PC.");
    } else {
      logActivity("security", "Telegram stranger ignored", String(from.id));
    }
    return;
  }
  if (from.id !== o.userId) {
    logActivity("security", "Telegram stranger ignored", String(from.id));
    return;
  }

  const text = msg.text?.trim();
  if (text === "/start" || text === "/help") {
    await say(
      msg.chat.id,
      "Ask me anything you'd ask at the PC: calendar, reminders, email (drafts only), notes, files, weather, images, research. From the phone I can't take over the PC itself — no mouse and keyboard, shutdown, or moving and editing files. /new starts a fresh conversation.",
    );
    return;
  }
  if (text === "/new") {
    kvSet("telegram_conversation", null);
    await say(msg.chat.id, "Fresh start, sir.");
    return;
  }

  let userText = text ?? "";
  const audio = msg.voice ?? msg.audio;
  if (!userText && audio) {
    try {
      userText = await transcribe(audio.file_id, audio.mime_type);
    } catch (err) {
      await say(msg.chat.id, `I couldn't make out that voice note: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!userText) {
      await say(msg.chat.id, "I couldn't hear anything in that voice note.");
      return;
    }
  }
  if (!userText) return;

  const conversationId = phoneConversation();
  const typing = setInterval(() => void tg("sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {}), 4500);
  void tg("sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
  let reply = "";
  const emit = (e: AgentEvent) => {
    if (e.type === "text") reply += e.delta;
    // Anything that needs SUNDAY's window (screenshots, driving the PC) can't happen from the phone.
    if (e.type === "request") fulfill(e.id, { error: "Not available from Telegram — that needs SUNDAY's window on the PC." });
  };
  try {
    await runAgent({
      conversationId,
      userText: audio && !text ? `(voice note) ${userText}` : userText,
      mode: "text",
      security: { ok: true, via: "telegram" },
      signal: AbortSignal.timeout(10 * 60_000),
      emit,
      channel: "telegram",
    });
    await say(msg.chat.id, reply.trim() || "Done, sir.");
  } catch (err) {
    await say(msg.chat.id, `Something went wrong: ${describeError(err)}`).catch(() => {});
  } finally {
    clearInterval(typing);
    kvSet("telegram_conversation", { id: conversationId, at: Date.now() });
  }
}

function phoneConversation() {
  const c = kvGet<{ id: string; at: number }>("telegram_conversation");
  if (c && Date.now() - c.at < NEW_CHAT_AFTER_MS) return c.id;
  return ensureConversation(null);
}

/** Voice notes → text with Deepgram's pre-recorded API (the same key as live listening). */
async function transcribe(fileId: string, mime?: string) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is missing, so I can't listen to voice notes.");
  const file = await tg<{ file_path: string }>("getFile", { file_id: fileId });
  const audio = await fetch(`${API}/file/bot${token()}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!audio.ok) throw new Error(`download failed (${audio.status})`);
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": mime ?? "audio/ogg" },
    body: Buffer.from(await audio.arrayBuffer()),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}`);
  const json = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}

/* ───────── Alerts while he's away from the PC ───────── */

let forwarding = false;
async function forwardWhileAway() {
  const o = owner();
  if (!o || forwarding || !sirAway()) return;
  forwarding = true;
  try {
    const lines = [
      ...claimDue().map((r) => (r.kind === "timer" ? `⏲ Timer done: ${r.text}` : `⏰ Reminder: ${r.text}${r.late ? " (late — I wasn't running)" : ""}`)),
      ...claimNotices().map((n) => n.text),
      ...calendarAlerts().map((n) => `📅 ${n.text}`),
    ];
    for (const line of lines) await say(o.chatId, line);
  } catch (err) {
    console.warn("[sunday] telegram forward failed:", err instanceof Error ? err.message : err);
  } finally {
    forwarding = false;
  }
}
