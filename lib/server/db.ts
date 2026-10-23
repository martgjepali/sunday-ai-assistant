import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,
  conversation_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, content='memories', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, category ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
  INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

-- File index: one FTS row per file/folder. Only 'name' is tokenized.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name, path UNINDEXED, drive UNINDEXED, ext UNINDEXED, size UNINDEXED,
  mtime UNINDEXED, is_dir UNINDEXED, gen UNINDEXED, tokenize='unicode61', prefix='2 3'
);

-- Everything SUNDAY does, for the brain view and for "what did you do earlier".
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

-- Reversible file operations. SUNDAY never deletes; every move/rename can be undone.
CREATE TABLE IF NOT EXISTS file_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  src TEXT NOT NULL,
  dest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const g = globalThis as unknown as { __sundayDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!g.__sundayDb) {
    mkdirSync(DATA_DIR, { recursive: true });
    const database = new DatabaseSync(path.join(DATA_DIR, "sunday.db"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    database.exec(SCHEMA);
    const messageCols = database.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!messageCols.some((c) => c.name === "actions")) {
      database.exec("ALTER TABLE messages ADD COLUMN actions TEXT");
    }
    g.__sundayDb = database;
  }
  return g.__sundayDb;
}

export function kvGet<T>(key: string): T | undefined {
  const row = db().prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(key: string, value: unknown) {
  db()
    .prepare(
      "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, JSON.stringify(value));
}

export function logActivity(kind: string, label: string, detail?: string) {
  db()
    .prepare(
      "INSERT INTO activity(kind, label, detail, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(kind, label, detail ?? null, Date.now());
}

export function transaction(fn: () => void) {
  const d = db();
  d.exec("BEGIN");
  try {
    fn();
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

/** Turn free text into a safe FTS5 OR-query of prefix terms. */
export function ftsQuery(text: string, { prefix = true } = {}): string | null {
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"${prefix ? "*" : ""}`).join(" OR ");
}

const STOPWORDS = new Set(
  "the a an and or but of to in on at for with is are was were be been it this that these those i you me my your we our he she they them his her its do does did can could would should will shall have has had what which who whom how when where why not no yes so if then than from by as about into over under again just please sunday sir".split(
    " ",
  ),
);
