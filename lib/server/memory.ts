import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MEMORY_MODEL, supportsFallbacks } from "./config";
import { db, ftsQuery } from "./db";
import { recordUsage } from "./spend";

export const MEMORY_CATEGORIES = [
  "identity",
  "preference",
  "person",
  "project",
  "routine",
  "event",
  "fact",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type Memory = {
  id: number;
  content: string;
  category: MemoryCategory;
  importance: number;
  created_at: number;
};

export function ensureConversation(id?: string | null): string {
  const now = Date.now();
  if (id) {
    const exists = db().prepare("SELECT 1 FROM conversations WHERE id = ?").get(id);
    if (exists) return id;
  }
  const newId = id ?? randomUUID();
  db()
    .prepare("INSERT INTO conversations(id, created_at, updated_at) VALUES (?, ?, ?)")
    .run(newId, now, now);
  return newId;
}

export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  actions?: string[],
) {
  const now = Date.now();
  db()
    .prepare("INSERT INTO messages(conversation_id, role, content, actions, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(conversationId, role, content, actions ? actions.join("\n") : null, now);
  db().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
}

/** Text-only history for the model: starts with a user turn, roles alternate. */
export function conversationHistory(
  conversationId: string,
  limit = 40,
): Anthropic.Beta.BetaMessageParam[] {
  const rows = (
    db()
      .prepare(
        "SELECT role, content, actions FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(conversationId, limit) as { role: "user" | "assistant"; content: string; actions: string | null }[]
  ).reverse();

  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const row of rows) {
    // The system's own record of which tools really ran keeps SUNDAY from
    // second-guessing (or inventing) past actions.
    // NULL = saved before actions were recorded, so say nothing rather than "none".
    const text =
      row.role === "assistant" && row.actions !== null
        ? `${row.content}\n\n<actions_taken>\n${row.actions || "none — no tools ran in this turn"}\n</actions_taken>`
        : row.content;
    const last = out.at(-1);
    if (last && last.role === row.role) {
      last.content = `${last.content as string}\n\n${text}`;
    } else {
      out.push({ role: row.role, content: text });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export function messagesFor(conversationId: string) {
  return db()
    .prepare(
      "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
    )
    .all(conversationId) as {
    id: number;
    role: "user" | "assistant";
    content: string;
    created_at: number;
  }[];
}

export function listConversations(limit = 50) {
  return db()
    .prepare(
      `SELECT c.id, c.title, c.updated_at, COUNT(m.id) AS message_count
       FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
       GROUP BY c.id HAVING message_count > 0 ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(limit) as { id: string; title: string | null; updated_at: number; message_count: number }[];
}

const memoryWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/\b(the user|sir'?s?|user'?s)\b/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

/** An existing memory that says essentially the same thing, if any. */
function findSimilarMemory(content: string): Memory | undefined {
  const q = ftsQuery(content, { prefix: false });
  if (!q) return undefined;
  const candidates = db()
    .prepare(
      `SELECT m.id, m.content, m.category, m.importance, m.created_at
       FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 5`,
    )
    .all(q) as Memory[];
  const words = memoryWords(content);
  return candidates.find((c) => {
    const other = memoryWords(c.content);
    let shared = 0;
    for (const w of words) if (other.has(w)) shared++;
    return shared / Math.max(1, Math.min(words.size, other.size)) >= 0.7;
  });
}

export function saveMemory(
  content: string,
  category: MemoryCategory,
  importance: number,
  conversationId?: string,
): number {
  const similar = findSimilarMemory(content);
  if (similar) {
    db()
      .prepare("UPDATE memories SET importance = MAX(importance, ?), last_used_at = ? WHERE id = ?")
      .run(Math.min(5, Math.max(1, Math.round(importance))), Date.now(), similar.id);
    return similar.id;
  }
  const result = db()
    .prepare(
      "INSERT INTO memories(content, category, importance, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(content, category, Math.min(5, Math.max(1, Math.round(importance))), conversationId ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

/** The memories that should always be on SUNDAY's mind. */
export function coreMemories(limit = 30): Memory[] {
  return db()
    .prepare(
      `SELECT id, content, category, importance, created_at FROM memories
       ORDER BY importance DESC, COALESCE(last_used_at, created_at) DESC LIMIT ?`,
    )
    .all(limit) as Memory[];
}

export function recallMemories(query: string, limit = 8): Memory[] {
  const q = ftsQuery(query);
  if (!q) return [];
  const rows = db()
    .prepare(
      `SELECT m.id, m.content, m.category, m.importance, m.created_at
       FROM memories_fts f JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) - m.importance * 0.3 LIMIT ?`,
    )
    .all(q, limit) as Memory[];
  if (rows.length) {
    const now = Date.now();
    const touch = db().prepare("UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id = ?");
    for (const r of rows) touch.run(now, r.id);
  }
  return rows;
}

export function searchPastConversations(query: string, excludeConversation?: string, limit = 6) {
  const q = ftsQuery(query);
  if (!q) return [];
  return db()
    .prepare(
      `SELECT m.conversation_id, m.role, m.created_at,
              snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet
       FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND m.conversation_id != ?
       ORDER BY bm25(messages_fts) LIMIT ?`,
    )
    .all(q, excludeConversation ?? "", limit) as {
    conversation_id: string;
    role: string;
    created_at: number;
    snippet: string;
  }[];
}

const Extraction = z.object({
  title: z
    .string()
    .describe(
      "A 2-5 word title for this conversation. Always give one when the current title is '(untitled)'; otherwise an empty string keeps the current title.",
    ),
  memories: z.array(
    z.object({
      content: z
        .string()
        .describe("One self-contained fact, written in third person about 'the user' or 'sir'."),
      category: z.enum(MEMORY_CATEGORIES),
      importance: z.number().int().describe("1 = trivia, 5 = core to who they are or what they're doing"),
    }),
  ),
});

let client: Anthropic | null = null;

/**
 * Background pass after each exchange: pull out durable facts worth remembering
 * and name the conversation. Never blocks a reply.
 */
export async function reflectOnExchange(conversationId: string, userText: string, assistantText: string) {
  client ??= new Anthropic();
  const convo = db()
    .prepare("SELECT title FROM conversations WHERE id = ?")
    .get(conversationId) as { title: string | null } | undefined;
  const related = recallMemories(`${userText} ${assistantText}`, 15);

  const response = await client.beta.messages.parse({
    model: MEMORY_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(Extraction) },
    ...(supportsFallbacks(MEMORY_MODEL)
      ? { betas: ["server-side-fallback-2026-07-01"] as Anthropic.AnthropicBeta[], fallbacks: "default" as const }
      : {}),
    system:
      "You maintain the long-term memory of SUNDAY, a personal AI assistant. From the latest exchange, " +
      "extract only durable facts worth remembering weeks from now: who the user is, people in their life, " +
      "preferences, ongoing projects, routines, commitments and important events (with dates when given). " +
      "Keep only what the user said or clearly confirmed — not SUNDAY's guesses or inferences from files. " +
      "Skip small talk, one-off commands (like 'open Firefox') and anything already captured in the existing " +
      "memories. Return an empty list when nothing is worth keeping — that is the common case.",
    messages: [
      {
        role: "user",
        content:
          `Existing related memories:\n${related.map((m) => `- ${m.content}`).join("\n") || "(none)"}\n\n` +
          `Current conversation title: ${convo?.title ?? "(untitled)"}\n\n` +
          `Latest exchange:\nUSER: ${userText}\nSUNDAY: ${assistantText}`,
      },
    ],
  });

  recordUsage("memory", response.model, response.usage);
  if (response.stop_reason === "refusal" || !response.parsed_output) return;
  const { title, memories } = response.parsed_output;
  if (title && !convo?.title) {
    db().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversationId);
  }
  for (const m of memories) saveMemory(m.content, m.category, m.importance, conversationId);
}
