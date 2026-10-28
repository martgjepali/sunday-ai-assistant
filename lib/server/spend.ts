import "server-only";
import { db } from "./db";

/**
 * What SUNDAY spends on Claude, per day and per job, priced from each reply's real token counts.
 * Shown in the Systems panel so sir can see what the free local brain saves and what coding costs.
 */

let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS spend (
      day TEXT NOT NULL,
      source TEXT NOT NULL,
      usd REAL NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, source)
    );
  `);
  schemaReady = true;
}

/** Who spent it: her chat brains, background memory, computer use, coding tasks, the brain self-test. */
export type SpendSource = "fast" | "deep" | "memory" | "computer" | "coding" | "diagnostics";

/** US$ per million tokens. Cache writes are the 5-minute kind (1.25× input). */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
const PRICES: { model: RegExp; price: Price; over100k?: Price }[] = [
  { model: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { model: /sonnet-5-5/, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  {
    model: /haiku-5-5/,
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    // Haiku 5.5 charges more once a prompt passes 100K tokens.
    over100k: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
];
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

export type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

const warned = new Set<string>();

/** Prices one Claude reply. Null for a model this table doesn't know (logged once). */
export function priceOf(model: string, u: Usage): number | null {
  const entry = PRICES.find((p) => p.model.test(model));
  if (!entry) {
    if (!warned.has(model)) console.warn(`[sunday] no price for ${model}; its spend isn't counted`);
    warned.add(model);
    return null;
  }
  const input = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const p = entry.over100k && input + read + write > 100_000 ? entry.over100k : entry.price;
  const tokens = input * p.input + (u.output_tokens ?? 0) * p.output + read * p.cacheRead + write * p.cacheWrite;
  return tokens / 1e6 + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function add(source: SpendSource, usd: number, input = 0, output = 0) {
  ensureSchema();
  db()
    .prepare(
      `INSERT INTO spend(day, source, usd, calls, input_tokens, output_tokens) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day, source) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
    )
    .run(today(), source, usd, input, output);
}

/** Records one Claude reply. Never throws — spend tracking must not break a reply. */
export function recordUsage(source: SpendSource, model: string, usage: Usage | null | undefined) {
  if (!usage) return;
  try {
    const usd = priceOf(model, usage);
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    add(source, usd ?? 0, input, usage.output_tokens ?? 0);
  } catch (err) {
    console.warn("[sunday] couldn't record spend:", err);
  }
}

/** Records a cost already worked out elsewhere (coding tasks: the Agent SDK totals them). */
export function recordCost(source: SpendSource, usd: number) {
  if (!(usd > 0)) return;
  try {
    add(source, usd);
  } catch (err) {
    console.warn("[sunday] couldn't record spend:", err);
  }
}

export type SpendSummary = {
  today: number;
  month: number;
  /** This month, by job, biggest first. */
  bySource: { source: SpendSource; usd: number; calls: number }[];
};

export function spendSummary(): SpendSummary {
  ensureSchema();
  const day = today();
  const month = day.slice(0, 7);
  const rows = db()
    .prepare("SELECT source, SUM(usd) AS usd, SUM(calls) AS calls FROM spend WHERE day LIKE ? GROUP BY source ORDER BY usd DESC")
    .all(`${month}-%`) as { source: SpendSource; usd: number; calls: number }[];
  const todayRow = db().prepare("SELECT SUM(usd) AS usd FROM spend WHERE day = ?").get(day) as { usd: number | null };
  return { today: todayRow.usd ?? 0, month: rows.reduce((s, r) => s + r.usd, 0), bySource: rows };
}
