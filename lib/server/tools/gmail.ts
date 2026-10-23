import "server-only";
import { randomBytes } from "node:crypto";
import { appOrigin } from "../config";
import { kvGet, kvSet, logActivity } from "../db";
import { judge, typesafeEnabled, type Question } from "../typesafe";
import { FileToolError } from "./files";

/**
 * Gmail access is read + compose only. SUNDAY can search and read mail and
 * create drafts; there is intentionally no send function in this codebase.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

type Tokens = { access_token: string; refresh_token?: string; expires_at: number; email?: string };

export const redirectUri = () => `${appOrigin()}/api/google/callback`;

export function googleAuthUrl() {
  const state = randomBytes(16).toString("hex");
  kvSet("google_oauth_state", { state, at: Date.now() });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function completeGoogleAuth(code: string, state: string) {
  const saved = kvGet<{ state: string; at: number }>("google_oauth_state");
  if (!saved || saved.state !== state || Date.now() - saved.at > 10 * 60 * 1000) {
    throw new Error("This sign-in link expired. Start the Gmail connection again from SUNDAY.");
  }
  kvSet("google_oauth_state", { state: "", at: 0 });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google rejected the sign-in (${res.status}).`);
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const tokens: Tokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
  };
  kvSet("google_tokens", tokens);
  const profile = await gmail<{ emailAddress: string }>("profile");
  kvSet("google_tokens", { ...tokens, email: profile.emailAddress });
  logActivity("mail", "Gmail connected", profile.emailAddress);
  return profile.emailAddress;
}

export function gmailAccount(): string | null {
  const t = kvGet<Tokens>("google_tokens");
  return t?.refresh_token ? (t.email ?? "connected") : null;
}

async function accessToken(): Promise<string> {
  const t = kvGet<Tokens>("google_tokens");
  if (!t?.refresh_token) {
    throw new FileToolError("Gmail isn't connected yet. Sir can connect it from the Systems panel.");
  }
  if (Date.now() < t.expires_at) return t.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new FileToolError("Gmail access was revoked or expired. Please reconnect it.");
  const body = (await res.json()) as { access_token: string; expires_in: number };
  kvSet("google_tokens", { ...t, access_token: body.access_token, expires_at: Date.now() + (body.expires_in - 60) * 1000 });
  return body.access_token;
}

async function gmail<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new FileToolError(`Gmail error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

type Header = { name: string; value: string };
type Part = { mimeType: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
type GmailMessage = {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  payload: Part & { headers: Header[] };
};

const header = (m: GmailMessage, name: string) =>
  m.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export async function searchEmail(query: string, max = 10) {
  const list = await gmail<{ messages?: { id: string }[] }>(
    `messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(max, 25)) })}`,
  );
  const ids = list.messages?.map((m) => m.id) ?? [];
  const messages = await Promise.all(
    ids.map((id) =>
      gmail<GmailMessage>(
        `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`,
      ),
    ),
  );
  logActivity("mail", `searched “${query}”`);
  return messages.map((m) => ({
    id: m.id,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    unread: m.labelIds?.includes("UNREAD") ?? false,
    snippet: m.snippet,
  }));
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function bodyText(part: Part): string {
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = bodyText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decode(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export async function readEmail(id: string) {
  const m = await gmail<GmailMessage>(`messages/${encodeURIComponent(id)}?format=full`);
  const text = bodyText(m.payload);
  logActivity("mail", header(m, "Subject") || "(no subject)", header(m, "From"));
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    body: text.length > 20_000 ? text.slice(0, 20_000) + "\n…(truncated)" : text,
  };
}

const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`);
const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

export async function createDraft(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyToMessageId?: string;
}) {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let subject = input.subject;
  if (input.replyToMessageId) {
    const original = await gmail<GmailMessage>(
      `messages/${encodeURIComponent(input.replyToMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`,
    );
    threadId = original.threadId;
    inReplyTo = header(original, "Message-ID");
    if (!subject) subject = header(original, "Subject");
    if (subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`;
  }
  const lines = [
    `To: ${clean(input.to)}`,
    input.cc ? `Cc: ${clean(input.cc)}` : null,
    `Subject: ${encodeHeader(clean(subject))}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body.replace(/\r?\n/g, "\r\n")).toString("base64"),
  ].filter((l) => l !== null);
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const draft = await gmail<{ id: string }>("drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
  });
  logActivity("draft", subject || "(no subject)", input.to);
  return { draftId: draft.id, to: input.to, subject, note: "Saved to Gmail Drafts — not sent." };
}

/* ───────────── Triage (Jev) ───────────── */

const URGENCY_LEVELS = [
  { what: "Ignorable: newsletter, promotion, marketing, social notification or spam", examples: ["Weekly digest", "50% off this weekend"] },
  { what: "Informational: worth reading at some point, no action needed", examples: ["Your order has shipped", "Meeting notes from Tuesday"] },
  { what: "Needs the user's action or reply within a few days", examples: ["Can you review the draft by Friday?", "Invoice #221 is due next week"] },
  {
    what: "Time-sensitive: needs attention today — a deadline today, money or account at risk, a security alert, or a person waiting right now",
    examples: ["Suspicious sign-in to your account", "Are you still coming at 3pm today?"],
  },
];
const URGENCY_LABELS = ["ignore", "fyi", "this week", "today"];
const CATEGORIES = {
  personal: "From a friend, family member or individual writing personally",
  work: "Work, clients, colleagues, jobs or business",
  finance: "Banks, payments, invoices, receipts, subscriptions",
  shopping: "Orders, deliveries, store accounts",
  security: "Sign-in alerts, password resets, verification codes",
  newsletter: "Newsletters, marketing and promotions",
  notification: "Automated notifications from apps and services",
  other: null,
};

/**
 * Scores unread mail with Jev in one batched request (urgency, needs-reply,
 * category per email), then sorts so the important things come first.
 */
export async function triageEmail(query = "is:unread newer_than:7d", max = 25) {
  const emails = await searchEmail(query, Math.min(max, 25));
  if (!emails.length) return { query, count: 0, emails: [] };
  if (!typesafeEnabled()) return { query, count: emails.length, scored: false, emails };

  const questions: Record<string, Question> = {};
  emails.forEach((_, i) => {
    questions[`urgency_${i}`] = {
      type: "score",
      instructions: `How soon does email \`emails[${i}]\` need the user's attention?`,
      criteria: URGENCY_LEVELS,
    };
    questions[`reply_${i}`] = {
      type: "noul",
      instructions: `Does email \`emails[${i}]\` ask the user a question or expect a personal reply from them?`,
    };
    questions[`category_${i}`] = {
      type: "choice",
      instructions: `What kind of email is \`emails[${i}]\`?`,
      criteria: CATEGORIES,
    };
  });

  const { answers } = await judge(
    {
      today: new Date().toDateString(),
      emails: emails.map((e) => ({ from: e.from, subject: e.subject, date: e.date, preview: e.snippet })),
    },
    questions,
    { timeoutMs: 15_000 },
  );

  const scored = emails.map((e, i) => {
    const u = answers[`urgency_${i}`];
    const r = answers[`reply_${i}`];
    const c = answers[`category_${i}`];
    const urgency = u?.type === "score" ? u.score : 0;
    return {
      ...e,
      urgency: URGENCY_LABELS[Math.round(urgency)] ?? "fyi",
      urgencyScore: Math.round((urgency / (URGENCY_LEVELS.length - 1)) * 100) / 100,
      needsReply: r?.type === "noul" ? r.noul >= 0.6 : false,
      category: c?.type === "choice" ? c.choice : "other",
    };
  });
  scored.sort((a, b) => b.urgencyScore - a.urgencyScore);
  logActivity("mail", `triaged ${scored.length} emails`);
  return {
    query,
    count: scored.length,
    scored: true,
    summary: Object.fromEntries(URGENCY_LABELS.map((l) => [l, scored.filter((s) => s.urgency === l).length])),
    emails: scored,
  };
}
