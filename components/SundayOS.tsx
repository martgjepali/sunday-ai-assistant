"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getJSON, type BrainData, type SystemStatus } from "@/lib/client/api";
import { useSunday, type ChatEntry, type IdentityState } from "@/lib/client/useSunday";
import { VoiceEnroll } from "./VoiceEnroll";
import { BootSequence } from "./BootSequence";
import { Brain3D, GROUP_COLORS, GROUP_LABELS, type BrainHandle } from "./Brain3D";
import {
  CloseIcon,
  ExpandIcon,
  HistoryIcon,
  MicIcon,
  MinusIcon,
  MuteIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SpeakerIcon,
} from "./Icons";
import { Orb } from "./Orb";

const GROUP_ORDER = ["core", "hub", "skill", "category", "memory", "conversation", "drive", "folder", "app", "mail", "web", "code"];

export function SundayOS() {
  const brain = useRef<BrainHandle>(null);
  const [data, setData] = useState<BrainData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [path, setPath] = useState<string[] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [repel, setRepel] = useState(90);
  const [linkLength, setLinkLength] = useState(38);
  const [showLabels, setShowLabels] = useState(true);
  const [ambient, setAmbient] = useState(true);
  const [autoOrbit, setAutoOrbit] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  // The WebGL brain is heavy to set up; it starts at the boot's logo reveal so it
  // can't stall the assembly animation, and is ready when the HUD dives into it.
  const [brainOn, setBrainOn] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  const loadBrain = useCallback(async () => {
    try {
      setData(await getJSON<BrainData>("/api/brain"));
    } catch (err) {
      console.error("[sunday] brain map failed to load", err);
    }
  }, []);

  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const sunday = useSunday({
    onActivate: (ids) => brain.current?.pulse(ids),
    onReplyDone: () => {
      refreshTimers.current.forEach(clearTimeout);
      // Once now for new files/apps, again after memory reflection lands.
      refreshTimers.current = [setTimeout(loadBrain, 600), setTimeout(loadBrain, 7000)];
    },
  });

  useEffect(() => {
    void loadBrain();
    setIsDesktop(Boolean(window.sundayDesktop));
  }, [loadBrain]);

  const nodeById = useMemo(() => new Map(data?.nodes.map((n) => [n.id, n]) ?? []), [data]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of data?.links ?? []) {
      d.set(l.source, (d.get(l.source) ?? 0) + 1);
      d.set(l.target, (d.get(l.target) ?? 0) + 1);
    }
    return d;
  }, [data]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of data?.nodes ?? []) c.set(n.group, (c.get(n.group) ?? 0) + 1);
    return c;
  }, [data]);

  const select = useCallback(
    (id: string | null, shift = false) => {
      if (shift && selected && id && id !== selected) {
        setPath(brain.current?.tracePath(selected, id) ?? null);
        return;
      }
      setPath(null);
      setSelected(id);
      brain.current?.focus(id);
    },
    [selected],
  );

  const lastReply = [...sunday.entries].reverse().find((e) => e.role === "assistant");

  return (
    <div className="os">
      {(brainOn || booted) && (
      <Brain3D
        ref={brain}
        data={data}
        state={sunday.state}
        hidden={hidden}
        repel={repel}
        linkLength={linkLength}
        showLabels={showLabels}
        ambient={ambient}
        autoOrbit={autoOrbit}
        selected={selected}
        onSelect={select}
      />
      )}
      <div className="vignette" aria-hidden />
      {isDesktop && <div className="dragbar" aria-hidden />}

      <LeftPanel
        data={data}
        degree={degree}
        nodeById={nodeById}
        selected={selected}
        path={path}
        onSelect={select}
        repel={repel}
        setRepel={setRepel}
        linkLength={linkLength}
        setLinkLength={setLinkLength}
        showLabels={showLabels}
        setShowLabels={setShowLabels}
        ambient={ambient}
        setAmbient={setAmbient}
        autoOrbit={autoOrbit}
        setAutoOrbit={setAutoOrbit}
      />

      <aside className="right-col">
        <section className="panel filter-panel">
          <h2 className="eyebrow">Filter</h2>
          <ul>
            {GROUP_ORDER.filter((g) => counts.get(g)).map((g) => (
              <li key={g}>
                <button
                  className="filter-row"
                  data-off={hidden.has(g) || undefined}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(g)) next.delete(g);
                      else next.add(g);
                      return next;
                    })
                  }
                >
                  <span className="dot" style={{ background: GROUP_COLORS[g] }} />
                  <span className="filter-name">{GROUP_LABELS[g]}</span>
                  <span className="count">{counts.get(g)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <Orb
          state={sunday.state}
          level={sunday.level}
          model={sunday.status?.model ?? "…"}
          wakeReady={Boolean(sunday.status?.wake.ready)}
          onToggle={sunday.toggleSession}
        />

        <SystemsPanel
          status={sunday.status}
          isDesktop={isDesktop}
          identity={sunday.identity}
          onVoiceSetup={() => {
            // SUNDAY stops listening so the enrollment sentences aren't taken as commands.
            sunday.pauseListening(true);
            setEnrollOpen(true);
          }}
        />
      </aside>

      <Dock
        reply={lastReply}
        interim={sunday.interim}
        notice={sunday.notice}
        onDismissNotice={sunday.dismissNotice}
        onSend={sunday.send}
        state={sunday.state}
        sessionActive={sunday.sessionActive}
        onMic={sunday.toggleSession}
        voiceReplies={sunday.voiceReplies}
        setVoiceReplies={sunday.setVoiceReplies}
        onHistory={() => setHistoryOpen((o) => !o)}
        hasStt={sunday.status?.stt === "deepgram"}
      />

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        entries={sunday.entries}
        conversationId={sunday.conversationId}
        onLoad={(id) => void sunday.loadConversation(id)}
      />

      {isDesktop && <WindowControls />}
      {enrollOpen && (
        <VoiceEnroll
          onClose={() => {
            setEnrollOpen(false);
            sunday.pauseListening(false);
          }}
          onSaved={() => void sunday.reloadIdentity()}
        />
      )}
      {sunday.locked && (
        <div className="lock-screen" role="alert">
          <div className="lock-card">
            <p className="lock-mark">SUNDAY</p>
            <p className="lock-title">Locked</p>
            <p className="lock-sub">Unlock Windows to wake me up.</p>
          </div>
        </div>
      )}
      {!booted && <BootSequence
          status={sunday.status}
          nodes={data?.nodes.length ?? 0}
          onReveal={() => setBrainOn(true)}
          onDone={() => setBooted(true)}
        />}
    </div>
  );
}

/* ───────────────────────── Left panel ───────────────────────── */

type LeftProps = {
  data: BrainData | null;
  degree: Map<string, number>;
  nodeById: Map<string, BrainData["nodes"][number]>;
  selected: string | null;
  path: string[] | null;
  onSelect: (id: string | null, shift?: boolean) => void;
  repel: number;
  setRepel: (v: number) => void;
  linkLength: number;
  setLinkLength: (v: number) => void;
  showLabels: boolean;
  setShowLabels: (v: boolean) => void;
  ambient: boolean;
  setAmbient: (v: boolean) => void;
  autoOrbit: boolean;
  setAutoOrbit: (v: boolean) => void;
};

function LeftPanel(p: LeftProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !p.data) return [];
    return p.data.nodes
      .filter((n) => n.label.toLowerCase().includes(q) || n.detail?.toLowerCase().includes(q))
      .sort((a, b) => (p.degree.get(b.id) ?? 0) - (p.degree.get(a.id) ?? 0))
      .slice(0, 6);
  }, [query, p.data, p.degree]);

  const hubs = useMemo(
    () =>
      [...p.degree.entries()]
        .filter(([id]) => id !== "sunday")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([id, n]) => ({ node: p.nodeById.get(id), n }))
        .filter((h) => h.node),
    [p.degree, p.nodeById],
  );

  const sel = p.selected ? p.nodeById.get(p.selected) : null;
  const neighbors = useMemo(() => {
    if (!p.selected || !p.data) return [];
    const ids = new Set<string>();
    for (const l of p.data.links) {
      if (l.source === p.selected) ids.add(l.target);
      if (l.target === p.selected) ids.add(l.source);
    }
    return [...ids].map((id) => p.nodeById.get(id)!).filter(Boolean);
  }, [p.selected, p.data, p.nodeById]);

  return (
    <aside className="panel left-panel">
      <header className="brand">
        <h1>SUNDAY OS</h1>
        <p>
          {p.data?.nodes.length ?? 0} neurons · {p.data?.links.length ?? 0} synapses
        </p>
      </header>

      <div className="search">
        <SearchIcon width={15} height={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) {
              p.onSelect(matches[0].id);
              setQuery("");
            }
          }}
          placeholder="Search the brain…"
          aria-label="Search the brain"
        />
        {matches.length > 0 && (
          <ul className="search-results">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => {
                    p.onSelect(m.id);
                    setQuery("");
                  }}
                >
                  <span className="dot" style={{ background: GROUP_COLORS[m.group] }} />
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section>
        <h2 className="eyebrow">Inspector</h2>
        <div className="card inspector">
          {sel ? (
            <>
              <div className="insp-head">
                <span className="dot" style={{ background: GROUP_COLORS[sel.group] }} />
                <span className="insp-group">{GROUP_LABELS[sel.group]}</span>
                <button className="icon-btn ghost" onClick={() => p.onSelect(null)} aria-label="Clear selection">
                  <CloseIcon width={14} height={14} />
                </button>
              </div>
              <p className="insp-title">{sel.label}</p>
              {sel.detail && sel.detail !== sel.label && <p className="insp-detail">{sel.detail}</p>}
              {p.path ? (
                <p className="insp-path">
                  {p.path.map((id, i) => (
                    <span key={id}>
                      {i > 0 && <i> → </i>}
                      {p.nodeById.get(id)?.label ?? id}
                    </span>
                  ))}
                </p>
              ) : (
                <>
                  <p className="insp-meta">{neighbors.length} connections</p>
                  <ul className="insp-neighbors">
                    {neighbors.slice(0, 9).map((n) => (
                      <li key={n.id}>
                        <button onClick={() => p.onSelect(n.id)}>
                          <span className="dot" style={{ background: GROUP_COLORS[n.group] }} />
                          {n.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="hint">
              Click a neuron to focus it. Only it and its connections stay lit, and you can read it here. Shift-click a
              second one to trace the path between them.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="eyebrow">Top hubs</h2>
        <ul className="hubs">
          {hubs.map(({ node, n }) => (
            <li key={node!.id}>
              <button onClick={() => p.onSelect(node!.id)}>
                <span className="dot" style={{ background: GROUP_COLORS[node!.group] }} />
                <span className="hub-name">{node!.label}</span>
                <span className="count">{n}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="eyebrow">Forces</h2>
        <div className="card sliders">
          <label>
            <span>Repel</span>
            <input type="range" min={20} max={320} value={p.repel} onChange={(e) => p.setRepel(+e.target.value)} />
          </label>
          <label>
            <span>Link length</span>
            <input type="range" min={10} max={140} value={p.linkLength} onChange={(e) => p.setLinkLength(+e.target.value)} />
          </label>
        </div>
      </section>

      <section>
        <h2 className="eyebrow">Display</h2>
        <div className="card toggles">
          <Toggle label="Labels" on={p.showLabels} set={p.setShowLabels} />
          <Toggle label="Synapse activity" on={p.ambient} set={p.setAmbient} />
          <Toggle label="Auto-orbit" on={p.autoOrbit} set={p.setAutoOrbit} />
        </div>
      </section>

      <footer className="legend-help">drag = orbit · scroll = zoom · shift-click = path</footer>
    </aside>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <button role="switch" aria-checked={on} className="switch" data-on={on || undefined} onClick={() => set(!on)}>
        <span />
      </button>
    </label>
  );
}

/* ───────────────────────── Systems ───────────────────────── */

const IDENTITY_TEXT: Record<IdentityState, string> = {
  off: "not set up",
  ready: "armed",
  owner: "you, verified",
  denied: "stranger refused",
};

function SystemsPanel({
  status,
  isDesktop,
  identity,
  onVoiceSetup,
}: {
  status: SystemStatus | null;
  isDesktop: boolean;
  identity: IdentityState;
  onVoiceSetup: () => void;
}) {
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  useEffect(() => {
    if (isDesktop) void window.sundayDesktop?.getAutoStart().then(setAutoStart);
  }, [isDesktop]);

  if (!status) return <section className="panel systems" aria-busy />;
  const rows: { name: string; ok: boolean | "partial"; value: string; action?: ReactNode }[] = [
    { name: "Core", ok: status.brain, value: status.brain ? `${status.model} · ${status.effort}` : "ANTHROPIC_API_KEY missing" },
    {
      name: "Voice",
      ok: status.voice.elevenlabs ? true : "partial",
      value: status.voice.elevenlabs ? (status.voice.voiceId ? "SUNDAY voice ready" : "clones on first reply") : "browser voice (add ElevenLabs key)",
    },
    { name: "Ears", ok: status.stt === "deepgram", value: status.stt === "deepgram" ? "Deepgram live" : "DEEPGRAM_API_KEY missing" },
    {
      name: "Wake word",
      ok: status.wake.ready,
      value: status.wake.ready ? "“Hey Sunday” armed" : `needs ${status.wake.missing.join(", ")}`,
    },
    {
      name: "Voice ID",
      ok: identity === "off" ? "partial" : identity !== "denied",
      value: IDENTITY_TEXT[identity],
      action: (
        <button className="link-btn" onClick={onVoiceSetup}>
          {identity === "off" ? "Set up" : "Redo"}
        </button>
      ),
    },
    {
      name: "Instinct",
      ok: status.typesafe ? true : "partial",
      value: status.typesafe ? "Jev judgments live" : "TYPESAFE_API_KEY missing",
    },
    {
      name: "Gmail",
      ok: Boolean(status.gmail.account),
      value: status.gmail.account ?? (status.gmail.configured ? "not connected" : "GOOGLE_CLIENT_ID missing"),
      action:
        status.gmail.configured && !status.gmail.account ? (
          <a className="link-btn" href="/api/google/auth" target="_blank" rel="noreferrer">
            Connect
          </a>
        ) : undefined,
    },
  ];
  return (
    <section className="panel systems">
      <h2 className="eyebrow">Systems</h2>
      <ul>
        {rows.map((r) => (
          <li key={r.name}>
            <span className="sys-led" data-ok={String(r.ok)} />
            <span className="sys-name">{r.name}</span>
            <span className="sys-value" title={r.value}>
              {r.value}
            </span>
            {r.action}
          </li>
        ))}
        <li>
          <span className="sys-led" data-ok={String(Object.values(status.index).every((d) => d.state === "done"))} />
          <span className="sys-name">Drives</span>
          <span className="sys-value">
            {Object.entries(status.index)
              .map(([d, s]) => `${d.slice(0, 2)} ${s.state === "indexing" ? "…" : ""}${compact(s.count)}`)
              .join(" · ")}
          </span>
        </li>
      </ul>
      {isDesktop && autoStart !== null && (
        <Toggle
          label="Start with Windows"
          on={autoStart}
          set={(v) => void window.sundayDesktop?.setAutoStart(v).then(setAutoStart)}
        />
      )}
    </section>
  );
}

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/* ───────────────────────── Dock ───────────────────────── */

const TOOL_NAMES: Record<string, string> = {
  remember: "remembering",
  recall: "recalling",
  search_files: "searching files",
  list_directory: "looking in folder",
  file_info: "checking file",
  read_file: "reading file",
  create_folder: "creating folder",
  move_items: "moving",
  rename_item: "renaming",
  undo_file_operations: "undoing",
  refresh_file_index: "re-indexing",
  open_application: "opening program",
  open_path: "opening",
  browser_search: "searching the web",
  open_url: "opening site",
  web_search: "researching",
  email_search: "checking mail",
  email_read: "reading email",
  email_create_draft: "drafting email",
  vscode_workspaces: "checking VS Code",
  read_code: "reading code",
  search_in_files: "searching code",
  edit_file: "editing code",
  write_file: "writing file",
  open_in_vscode: "opening in VS Code",
  list_skills: "checking skills",
  use_skill: "loading a skill",
  web_fetch: "reading docs",
  email_triage: "triaging inbox",
  look_at_screen: "looking at your screen",
  create_document: "creating document",
  computer_task: "using the computer",
  media_control: "controlling media",
  volume: "adjusting volume",
  system_status: "checking the PC",
  lock_pc: "locking the PC",
  show_desktop: "showing desktop",
  power: "power control",
  close_application: "closing app",
  read_clipboard: "reading clipboard",
  write_clipboard: "copying to clipboard",
  set_reminder: "setting reminder",
  set_timer: "starting timer",
  list_reminders: "checking reminders",
  cancel_reminder: "cancelling reminder",
  get_weather: "checking weather",
  morning_briefing: "preparing briefing",
};

function Dock(p: {
  reply: ChatEntry | undefined;
  interim: string;
  notice: string | null;
  onDismissNotice: () => void;
  onSend: (text: string) => void;
  state: string;
  sessionActive: boolean;
  onMic: () => void;
  voiceReplies: boolean;
  setVoiceReplies: (v: boolean) => void;
  onHistory: () => void;
  hasStt: boolean;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    captionRef.current?.scrollTo({ top: captionRef.current.scrollHeight });
  }, [p.reply?.text]);

  const submit = () => {
    if (!text.trim()) return;
    p.onSend(text);
    setText("");
  };

  return (
    <div className="dock">
      {p.notice && (
        <div className="notice" role="status">
          <span>{p.notice}</span>
          <button className="icon-btn ghost" onClick={p.onDismissNotice} aria-label="Dismiss">
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      )}

      {(p.reply || p.interim) && (
        <div className="caption panel">
          {p.reply && p.reply.tools.length > 0 && (
            <div className="tool-chips">
              {p.reply.tools.map((t) => (
                <span key={t.id} className="tool-chip" data-status={t.status} title={t.detail}>
                  {TOOL_NAMES[t.name] ?? t.name.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          )}
          {p.reply && (
            <div className="caption-text" ref={captionRef}>
              {p.reply.text || (p.state === "thinking" ? <span className="thinking-dots">Thinking</span> : null)}
              {p.reply.interrupted && <span className="interrupted"> — interrupted</span>}
              {p.reply.error && <p className="caption-error">{p.reply.error}</p>}
            </div>
          )}
          {p.interim && <p className="interim">“{p.interim}”</p>}
        </div>
      )}

      <form
        className="command panel"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={p.hasStt ? "Talk to SUNDAY — or say “Hey Sunday”" : "Ask SUNDAY anything…"}
          aria-label="Message SUNDAY"
          autoComplete="off"
        />
        <kbd className="hotkey">Ctrl ⇧ Space</kbd>
        <button
          type="button"
          className="icon-btn"
          data-active={p.sessionActive || undefined}
          onClick={p.onMic}
          aria-label={p.sessionActive ? "Stop listening" : "Start voice conversation"}
        >
          <MicIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => p.setVoiceReplies(!p.voiceReplies)}
          aria-label={p.voiceReplies ? "Mute spoken replies" : "Speak replies"}
          aria-pressed={p.voiceReplies}
        >
          {p.voiceReplies ? <SpeakerIcon /> : <MuteIcon />}
        </button>
        <button type="button" className="icon-btn" onClick={p.onHistory} aria-label="Conversation history">
          <HistoryIcon />
        </button>
        <button type="submit" className="icon-btn send" aria-label="Send" disabled={!text.trim()}>
          <SendIcon />
        </button>
      </form>
    </div>
  );
}

/* ───────────────────────── History ───────────────────────── */

function HistoryDrawer(p: {
  open: boolean;
  onClose: () => void;
  entries: ChatEntry[];
  conversationId: string | null;
  onLoad: (id: string | null) => void;
}) {
  const [tab, setTab] = useState<"now" | "past">("now");
  const [past, setPast] = useState<{ id: string; title: string | null; updated_at: number; message_count: number }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (p.open && tab === "past") {
      void getJSON<{ conversations: typeof past }>("/api/conversations").then((r) => setPast(r.conversations));
    }
  }, [p.open, tab]);

  useEffect(() => {
    if (p.open && tab === "now") endRef.current?.scrollIntoView({ block: "end" });
  }, [p.open, tab, p.entries]);

  return (
    <aside className="drawer panel" data-open={p.open || undefined} aria-hidden={!p.open}>
      <header className="drawer-head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "now"} onClick={() => setTab("now")}>
            This conversation
          </button>
          <button role="tab" aria-selected={tab === "past"} onClick={() => setTab("past")}>
            Past
          </button>
        </div>
        <button className="icon-btn ghost" onClick={() => p.onLoad(null)} aria-label="New conversation" title="New conversation">
          <PlusIcon width={16} height={16} />
        </button>
        <button className="icon-btn ghost" onClick={p.onClose} aria-label="Close history">
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      {tab === "now" ? (
        <div className="log">
          {p.entries.length === 0 && <p className="hint">Nothing said yet. Say “Hey Sunday” or type below.</p>}
          {p.entries.map((e) => (
            <div key={e.id} className="msg" data-role={e.role}>
              <span className="msg-who">{e.role === "user" ? "You" : "SUNDAY"}</span>
              <p>{e.text || (e.error ? "" : "…")}</p>
              {e.error && <p className="caption-error">{e.error}</p>}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : (
        <ul className="past">
          {past.length === 0 && <p className="hint">No past conversations yet.</p>}
          {past.map((c) => (
            <li key={c.id}>
              <button
                data-current={c.id === p.conversationId || undefined}
                onClick={() => {
                  p.onLoad(c.id);
                  setTab("now");
                }}
              >
                <span className="past-title">{c.title ?? "Untitled"}</span>
                <span className="past-meta">
                  {new Date(c.updated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} ·{" "}
                  {c.message_count} msgs
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/* ───────────────────────── Window chrome & boot ───────────────────────── */

function WindowControls() {
  return (
    <div className="window-controls">
      <button className="icon-btn ghost" onClick={() => window.sundayDesktop?.minimize()} aria-label="Minimise">
        <MinusIcon width={15} height={15} />
      </button>
      <button className="icon-btn ghost" onClick={() => window.sundayDesktop?.toggleFullscreen()} aria-label="Toggle full screen">
        <ExpandIcon width={15} height={15} />
      </button>
      <button className="icon-btn ghost" onClick={() => window.sundayDesktop?.hide()} aria-label="Hide to tray">
        <CloseIcon width={15} height={15} />
      </button>
    </div>
  );
}
