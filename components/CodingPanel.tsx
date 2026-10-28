"use client";

import { useEffect, useState } from "react";
import { api, getJSON } from "@/lib/client/api";
import { CloseIcon } from "./Icons";

type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };
type Ev = { at: number; kind: string; text: string };
type Coding =
  | { active: false }
  | {
      active: true;
      kind: "task" | "quick";
      snippet: { file: string; label: string; code: string } | null;
      goal: string;
      project: string;
      model: string;
      status: "starting" | "working" | "waiting" | "done" | "failed" | "stopped";
      startedAt: number;
      finishedAt: number | null;
      now: string;
      todos: Todo[];
      events: Ev[];
      files: string[];
      commands: number;
      cost: number;
      summary: string | null;
      error: string | null;
      pending: { tool: string; detail: string; reason: string } | null;
    };

const STATUS: Record<string, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Needs your OK",
  done: "Done",
  failed: "Didn't finish",
  stopped: "Stopped",
};
const MARK: Record<string, string> = { read: "↗", search: "⌕", edit: "✎", create: "+", run: "›", web: "◎", agent: "⇢", blocked: "⊘", ask: "?", start: "◆", note: "·" };

/** The first few lines of a code preview. */
const clip = (code: string, max: number) => {
  const lines = code.split("\n");
  return lines.length > max ? `${lines.slice(0, max).join("\n")}\n…` : code;
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Live view of SUNDAY's coding engine: goal, checklist, what it's doing, approvals, stop. */
export function CodingPanel() {
  const [c, setC] = useState<Coding>({ active: false });
  const [small, setSmall] = useState(false);
  /** The clock for "running for 2:15", ticked each second while a task runs (0 until the first tick: the page is pre-rendered). */
  const [now, setNow] = useState(0);
  const running = c.active && (c.status === "working" || c.status === "starting" || c.status === "waiting");

  useEffect(() => {
    let alive = true;
    const load = () => void getJSON<Coding>("/api/code").then((r) => alive && setC(r)).catch(() => {});
    load();
    const timer = setInterval(load, running ? 1500 : 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  // A new approval request always opens the panel (adjusted during render, as React recommends).
  const waiting = c.active && c.status === "waiting";
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    if (waiting) setSmall(false);
  }

  if (!c.active) return null;
  const act = (action: string) =>
    void api("/api/code", { method: "POST", body: JSON.stringify({ action }) })
      .then((r) => r.json())
      .then((r: Coding) => "active" in r && setC(r))
      .catch(() => {});
  const done = c.todos.filter((t) => t.status === "completed").length;
  const elapsed = clock((c.finishedAt ?? Math.max(now, c.startedAt)) - c.startedAt);

  if (small) {
    return (
      <button className="coding-pill panel" data-status={c.status} onClick={() => setSmall(false)}>
        <span className="coding-dot" />
        Coding · {STATUS[c.status]}
        {c.todos.length > 0 && ` · ${done}/${c.todos.length}`} · {elapsed}
      </button>
    );
  }

  return (
    <section className="coding panel" data-status={c.status} aria-live="polite">
      <header className="coding-head">
        <span className="coding-dot" />
        <span className="eyebrow">Coding · {STATUS[c.status]}</span>
        <span className="coding-meta">
          {c.kind === "quick"
            ? `${c.model} · quick edit`
            : `${elapsed} · ${/coder/i.test(c.model) ? "local · free" : `${/sonnet/i.test(c.model) ? "quick" : "best"} · $${c.cost.toFixed(2)}`}`}
        </span>
        <button className="icon-btn ghost" onClick={() => setSmall(true)} aria-label="Minimise coding panel" title="Minimise">
          <span aria-hidden>–</span>
        </button>
        {!running && (
          <button className="icon-btn ghost" onClick={() => act("dismiss")} aria-label="Close coding panel">
            <CloseIcon width={14} height={14} />
          </button>
        )}
      </header>

      <p className="coding-goal">{c.goal}</p>
      <p className="coding-project" title={c.project}>
        {c.project}
      </p>

      {c.pending && (
        <div className="coding-ask">
          <p>
            Wants to run <code>{c.pending.detail}</code>
          </p>
          <div className="coding-ask-actions">
            <button className="btn-primary" onClick={() => act("allow")}>
              Allow
            </button>
            <button className="btn-ghost" onClick={() => act("deny")}>
              Deny
            </button>
          </div>
        </div>
      )}

      {c.todos.length > 0 && (
        <ol className="coding-todos">
          {c.todos.map((t, i) => (
            <li key={i} data-status={t.status}>
              <span className="todo-mark" aria-hidden>
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}
              </span>
              {t.status === "in_progress" ? t.activeForm : t.content}
            </li>
          ))}
        </ol>
      )}

      {running && <p className="coding-now">{c.now}</p>}

      {c.snippet && (
        <figure className="coding-snippet">
          <figcaption>
            {c.snippet.file} · {c.snippet.label}
          </figcaption>
          <pre>{clip(c.snippet.code, 14)}</pre>
        </figure>
      )}

      {c.summary && !running && <p className="coding-summary">{c.summary.replace(/\*\*|`/g, "").replace(/^#{1,6}\s+/gm, "")}</p>}
      {c.error && <p className="caption-error">{c.error}</p>}

      <ul className="coding-feed">
        {c.events.slice(-6).map((e, i) => (
          <li key={`${e.at}-${i}`} data-kind={e.kind}>
            <span aria-hidden>{MARK[e.kind] ?? "·"}</span>
            {e.text}
          </li>
        ))}
      </ul>

      <footer className="coding-foot">
        <span title={c.files.join("\n")}>
          {c.files.length} file{c.files.length === 1 ? "" : "s"} changed · {c.commands} command{c.commands === 1 ? "" : "s"}
        </span>
        {running && c.kind === "task" && (
          <button className="btn-ghost danger" onClick={() => act("stop")}>
            Stop
          </button>
        )}
      </footer>
    </section>
  );
}
