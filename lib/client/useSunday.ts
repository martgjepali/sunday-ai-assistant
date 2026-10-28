"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NotOwnerError, api, getJSON, streamChat, verifyVoice, type SystemStatus } from "./api";
import { useLatest } from "./useLatest";
import { BrowserEar, DeepgramEar, Speaker, WakeWord, chime, type Ear } from "./voice";

export type VoiceState = "standby" | "listening" | "thinking" | "speaking";

export type ToolChip = { id: string; name: string; status: "start" | "done" | "error"; detail?: string };
export type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  /** Which of SUNDAY's brains answered: "local", "Haiku" or "Opus". */
  brain?: string;
  error?: string;
  interrupted?: boolean;
};

declare global {
  interface Window {
    sundayDesktop?: {
      isDesktop: true;
      onSummon(cb: () => void): () => void;
      onLock?(cb: () => void): () => void;
      onUnlock?(cb: () => void): () => void;
      onStopDrive?(cb: () => void): () => void;
      captureScreen?(opts?: unknown): Promise<{ data?: string; width?: number; height?: number; error?: string }>;
      drive?(on: boolean): Promise<{ displayId?: string; ok?: boolean }>;
      minimize(): void;
      toggleFullscreen(): void;
      hide(): void;
      getAutoStart(): Promise<boolean>;
      setAutoStart(on: boolean): Promise<boolean>;
      idleSeconds?(): Promise<number>;
    };
  }
}

const IDLE_MS = 30_000;
/** Words that always mean "stop" — react instantly, no need to ask Jev. */
const HARD_STOP = /\b(stop|wait|hold on|cancel|pause|shut up|be quiet|enough)\b/i;
const INTERRUPT_THRESHOLD = 0.5;
export type IdentityState = "off" | "ready" | "owner" | "denied";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const uid = () => Math.random().toString(36).slice(2, 10);

export function useSunday(opts: { onActivate: (ids: string[]) => void; onReplyDone: () => void }) {
  const [state, setState] = useState<VoiceState>("standby");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [sessionActive, setSessionActive] = useState(false);

  const optsRef = useLatest(opts);
  const statusRef = useRef<SystemStatus | null>(null);
  const convRef = useRef<string | null>(null);
  const voiceRepliesRef = useLatest(voiceReplies);
  const sessionRef = useRef(false);
  const inFlightRef = useRef<AbortController | null>(null);
  /** True while a computer task has the mouse and keyboard. */
  const drivingRef = useRef(false);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const earRef = useRef<Ear | null>(null);
  const wakeRef = useRef<WakeWord | null>(null);
  const wakeInitRef = useRef(false);
  const sendRef = useRef<(text: string, mode: "voice" | "text", voiceToken?: string | null) => void>(() => {});
  const endSessionRef = useRef<() => void>(() => {});

  /* ───────── Security: Windows lock + Face ID ───────── */
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  /** True while something else owns the mic (Voice ID enrollment): SUNDAY must not act on what she hears. */
  const pausedRef = useRef(false);
  const [identity, setIdentity] = useState<IdentityState>("off");
  const enrolledRef = useRef(false);

  const loadIdentity = useCallback(async () => {
    try {
      const v = await getJSON<{ enrolled: boolean }>("/api/voiceprint");
      enrolledRef.current = v.enrolled;
      setIdentity(v.enrolled ? "ready" : "off");
    } catch {}
  }, []);

  const refuse = useCallback((kind: "stranger" | "unclear" | "typed") => {
    const line =
      kind === "unclear"
        ? "I didn't hear enough of your voice to be sure it's you. Say that again?"
        : kind === "typed"
          ? "Talk to me first so I can recognise your voice, then you can type."
          : "Sorry, I only take instructions from my owner.";
    setNotice(kind === "stranger" ? "Voice not recognised — SUNDAY refused." : line);
    speakerRef.current?.say(line);
  }, []);

  /** Voice ID for one spoken request: lets sir through with a chat token, refuses anyone else. */
  const checkVoice = useCallback(
    async (audio?: Int16Array): Promise<{ ok: boolean; token: string | null }> => {
      if (!enrolledRef.current) return { ok: true, token: null };
      if (!audio || audio.length < 16_000 * 0.8) {
        refuse("unclear");
        return { ok: false, token: null };
      }
      const r = await verifyVoice(audio);
      if (!r) {
        setNotice("Voice ID is unavailable right now, so I can't confirm it's you.");
        return { ok: false, token: null };
      }
      if (!r.enrolled) {
        enrolledRef.current = false;
        setIdentity("off");
        return { ok: true, token: null };
      }
      if (r.owner) {
        setIdentity("owner");
        return { ok: true, token: r.token };
      }
      setIdentity(r.problem ? "ready" : "denied");
      refuse(r.problem ? "unclear" : "stranger");
      return { ok: false, token: null };
    },
    [refuse],
  );

  const armIdle = useCallback(() => {
    const arm = () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      idleRef.current = setTimeout(() => {
        if (!inFlightRef.current && !speakerRef.current?.speaking) endSessionRef.current();
        else arm();
      }, IDLE_MS);
    };
    arm();
  }, []);

  const settle = useCallback(() => {
    if (inFlightRef.current) return;
    if (sessionRef.current) {
      setState("listening");
      armIdle();
    } else {
      setState("standby");
    }
  }, [armIdle]);

  // Speaker is created once, before any effect needs it; it reads live settings through refs.
  useLayoutEffect(() => {
    speakerRef.current ??= new Speaker(() => Boolean(statusRef.current && statusRef.current.voice.engine !== "browser"), {
      onStart: () => setState("speaking"),
      onIdle: () => settle(),
      onError: (msg) => setNotice(msg),
    });
  }, [settle]);

  const markInterrupted = () =>
    setEntries((list) => {
      const last = list.at(-1);
      if (!last || last.role !== "assistant") return list;
      return [...list.slice(0, -1), { ...last, interrupted: true }];
    });

  const bargeIn = useCallback(() => {
    const speaking = speakerRef.current?.speaking;
    if (!inFlightRef.current && !speaking) return;
    inFlightRef.current?.abort();
    inFlightRef.current = null;
    speakerRef.current?.stop();
    markInterrupted();
    setState("listening");
  }, []);

  const judgingRef = useRef(false);
  /** Probability (0..1) that `heard` means "stop and listen", or null if Jev can't say. */
  const isInterruption = useCallback(async (heard: string): Promise<number | null> => {
    try {
      const res = await api("/api/interrupt", {
        method: "POST",
        body: JSON.stringify({ heard, speaking: speakerRef.current?.saying ?? "" }),
      });
      const { interrupt } = (await res.json()) as { interrupt: number | null };
      return typeof interrupt === "number" ? interrupt : null;
    } catch {
      return null;
    }
  }, []);

  const ensureEar = useCallback((): Ear | null => {
    if (earRef.current) return earRef.current;
    const speaking = () => Boolean(speakerRef.current?.speaking);
    const hooks = {
      onInterim: (text: string) => {
        setInterim(text);
        armIdle();
        if (!speaking()) {
          // "Stop" also ends a computer task, even when she isn't talking.
          if (drivingRef.current && HARD_STOP.test(text)) bargeIn();
          return;
        }
        if (HARD_STOP.test(text)) return bargeIn();
        if (!statusRef.current?.typesafe) {
          if (words(text) >= 3) bargeIn(); // simple rule without Jev
          return;
        }
        // Ask Jev whether this is a real interruption; she keeps talking meanwhile.
        if (words(text) >= 2 && !judgingRef.current) {
          judgingRef.current = true;
          void isInterruption(text).then((p) => {
            judgingRef.current = false;
            if (speaking() && (p === null ? words(text) >= 3 : p >= INTERRUPT_THRESHOLD)) bargeIn();
          });
        }
      },
      onUtterance: async (text: string, audio?: Int16Array) => {
        setInterim("");
        armIdle();
        if (speaking() && !HARD_STOP.test(text) && statusRef.current?.typesafe) {
          const p = await isInterruption(text);
          // A backchannel ("mm-hm", "okay") or her own echo: keep talking and ignore it.
          if (p !== null && p < INTERRUPT_THRESHOLD && speaking()) return;
        }
        bargeIn();
        // Voice ID: only sir's voice reaches the brain.
        const verdict = await checkVoice(audio);
        if (!verdict.ok) return;
        sendRef.current(text, "voice", verdict.token);
      },
      onError: (msg: string) => setNotice(msg),
    };
    if (statusRef.current?.stt === "deepgram") earRef.current = new DeepgramEar(hooks);
    else if (BrowserEar.supported() && !window.sundayDesktop) earRef.current = new BrowserEar(hooks);
    return earRef.current;
  }, [armIdle, bargeIn, checkVoice, isInterruption]);

  const startSession = useCallback(async () => {
    speakerRef.current?.unlock();
    if (sessionRef.current || pausedRef.current) return;
    if (lockedRef.current) {
      setNotice("SUNDAY is locked. Unlock Windows to continue.");
      return;
    }
    const ear = ensureEar();
    if (!ear) {
      setNotice("Voice input needs a Deepgram key (DEEPGRAM_API_KEY in .env). You can still type to me.");
      return;
    }
    sessionRef.current = true;
    setSessionActive(true);
    await wakeRef.current?.pause().catch(() => {});
    try {
      await ear.start();
    } catch (err) {
      sessionRef.current = false;
      setSessionActive(false);
      setNotice(err instanceof Error ? err.message : String(err));
      void wakeRef.current?.resume().catch(() => {});
      return;
    }
    chime("wake");
    if (!inFlightRef.current && !speakerRef.current?.speaking) setState("listening");
    armIdle();
  }, [armIdle, ensureEar]);

  const endSession = useCallback(() => {
    if (!sessionRef.current) return;
    sessionRef.current = false;
    setSessionActive(false);
    if (idleRef.current) clearTimeout(idleRef.current);
    earRef.current?.stop();
    setInterim("");
    chime("sleep");
    if (!lockedRef.current && !pausedRef.current) void wakeRef.current?.resume().catch(() => {});
    if (!inFlightRef.current && !speakerRef.current?.speaking) setState("standby");
  }, []);
  useLayoutEffect(() => {
    endSessionRef.current = endSession;
  }, [endSession]);

  /** Stop all listening (wake word + conversation) until resumed, e.g. during Voice ID enrollment. */
  const pauseListening = useCallback((on: boolean) => {
    pausedRef.current = on;
    if (on) {
      inFlightRef.current?.abort();
      speakerRef.current?.stop();
      endSessionRef.current();
      void wakeRef.current?.pause().catch(() => {});
    } else if (!lockedRef.current && !sessionRef.current) {
      void wakeRef.current?.resume().catch(() => {});
    }
  }, []);

  const answerRequest = async (id: string, kind: string, payload?: unknown) => {
    let data: unknown = { error: `Unknown request "${kind}"` };
    const desktop = window.sundayDesktop;
    if (kind === "screenshot") {
      data = desktop?.captureScreen
        ? await desktop.captureScreen(payload).catch((e: unknown) => ({ error: String(e) }))
        : { error: "Looking at the screen needs the SUNDAY desktop app (open SUNDAY from its icon)." };
    } else if (kind === "drive-start" || kind === "drive-end") {
      // Computer use: her window steps aside while she has the mouse and keyboard.
      const on = kind === "drive-start";
      drivingRef.current = on && Boolean(desktop?.drive);
      data = desktop?.drive
        ? await desktop.drive(on).catch((e: unknown) => ({ error: String(e) }))
        : { error: "Using the computer needs the SUNDAY desktop app (open SUNDAY from its icon)." };
    }
    await api("/api/bridge", { method: "POST", body: JSON.stringify({ id, data }) }).catch(() => {});
  };

  const send = useCallback(
    async (text: string, mode: "voice" | "text", voiceToken?: string | null) => {
      const clean = text.trim();
      if (!clean) return;
      speakerRef.current?.unlock();
      if (lockedRef.current) {
        setNotice("SUNDAY is locked. Unlock Windows to continue.");
        return;
      }
      inFlightRef.current?.abort();
      speakerRef.current?.stop();
      const ctrl = new AbortController();
      inFlightRef.current = ctrl;
      const speak = mode === "voice" || voiceRepliesRef.current;
      const replyId = uid();

      setNotice(null);
      setEntries((list) => [
        ...list,
        { id: uid(), role: "user", text: clean, tools: [] },
        { id: replyId, role: "assistant", text: "", tools: [] },
      ]);
      setState("thinking");
      optsRef.current.onActivate(["sunday"]);

      const patch = (fn: (e: ChatEntry) => ChatEntry) =>
        setEntries((list) => list.map((e) => (e.id === replyId ? fn(e) : e)));

      try {
        for await (const ev of streamChat({ conversationId: convRef.current, text: clean, mode, voiceToken }, ctrl.signal)) {
          switch (ev.type) {
            case "meta":
              convRef.current = ev.conversationId;
              setConversationId(ev.conversationId);
              break;
            case "text":
              patch((e) => ({ ...e, text: e.text + ev.delta }));
              if (speak) speakerRef.current?.feed(ev.delta);
              break;
            case "brain":
              patch((e) => ({ ...e, brain: ev.label }));
              break;
            case "tool":
              patch((e) => {
                const others = e.tools.filter((t) => t.id !== ev.id);
                return { ...e, tools: [...others, { id: ev.id, name: ev.name, status: ev.status, detail: ev.detail }] };
              });
              if (ev.status === "start") optsRef.current.onActivate([`hub:${ev.hub}`, `skill:${ev.name}`]);
              break;
            case "activate":
              optsRef.current.onActivate(ev.ids);
              break;
            case "request":
              // A tool needs something only the desktop app can do; answer without blocking the stream.
              void answerRequest(ev.id, ev.kind, ev.payload);
              break;
            case "error":
              patch((e) => ({ ...e, error: ev.message }));
              if (speak) speakerRef.current?.say(ev.message);
              break;
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof NotOwnerError) {
          // The server didn't accept this as sir: drop the exchange and refuse.
          setEntries((list) => list.slice(0, -2));
          if (inFlightRef.current === ctrl) inFlightRef.current = null;
          refuse(mode === "text" ? "typed" : "stranger");
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        patch((e) => ({ ...e, error: message }));
      } finally {
        if (inFlightRef.current === ctrl) inFlightRef.current = null;
        if (drivingRef.current && ctrl.signal.aborted) {
          // Interrupted mid-task: give sir his screen back straight away.
          drivingRef.current = false;
          void window.sundayDesktop?.drive?.(false);
        }
      }
      if (ctrl.signal.aborted) return;
      optsRef.current.onReplyDone();
      if (speak) speakerRef.current?.flush();
      else settle();
    },
    [refuse, settle, optsRef, voiceRepliesRef],
  );
  useLayoutEffect(() => {
    sendRef.current = (t, m, token) => void send(t, m, token);
  }, [send]);

  const toggleSession = useCallback(() => {
    if (speakerRef.current?.speaking) {
      speakerRef.current.stop();
      markInterrupted();
      settle();
      return;
    }
    if (sessionRef.current) endSession();
    else void startSession();
  }, [endSession, settle, startSession]);

  const loadConversation = useCallback(async (id: string | null) => {
    inFlightRef.current?.abort();
    speakerRef.current?.stop();
    convRef.current = id;
    setConversationId(id);
    if (!id) {
      setEntries([]);
      return;
    }
    const { messages } = await getJSON<{ messages: { id: number; role: "user" | "assistant"; content: string }[] }>(
      `/api/conversations?id=${encodeURIComponent(id)}`,
    );
    setEntries(messages.map((m) => ({ id: `db${m.id}`, role: m.role, text: m.content, tools: [] })));
  }, []);

  // Status polling, wake word and desktop hotkey wiring.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await getJSON<SystemStatus>("/api/status");
        if (cancelled) return;
        statusRef.current = s;
        setStatus(s);
        if (s.wake.ready && !wakeInitRef.current) {
          wakeInitRef.current = true;
          const wake = new WakeWord();
          try {
            await wake.init(s.wake, () => void startSession());
            wakeRef.current = wake;
            if (!sessionRef.current && !lockedRef.current) await wake.resume();
          } catch (err) {
            const noMic = err instanceof DOMException && (err.name === "NotFoundError" || err.name === "NotReadableError");
            setNotice(
              noMic
                ? "No microphone detected — are your headphones connected? Once they are, click the mic and “Hey Sunday” will work again."
                : `Wake word unavailable: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch {
        if (!cancelled) setNotice("Can't reach SUNDAY's core service.");
      }
    };
    void refresh();
    const timer = setInterval(refresh, 15_000);
    const offSummon = window.sundayDesktop?.onSummon(() => toggleSession());
    // Ctrl+Shift+Space while she's driving: stop the task and hand back control.
    const offStopDrive = window.sundayDesktop?.onStopDrive?.(() => {
      drivingRef.current = false;
      bargeIn();
    });
    const onKey = (e: KeyboardEvent) => {
      if (!window.sundayDesktop && e.ctrlKey && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        toggleSession();
      }
      if (e.key === "Escape" && speakerRef.current?.speaking) {
        speakerRef.current.stop();
        settle();
      }
    };
    window.addEventListener("keydown", onKey);
    // A microphone was plugged in (or changed): start wake-word listening if it isn't running.
    const onDevices = () => {
      const wake = wakeRef.current;
      if (!wake || wake.active || sessionRef.current || lockedRef.current) return;
      wake
        .resume()
        .then(() => setNotice(null))
        .catch(() => {});
    };
    navigator.mediaDevices?.addEventListener("devicechange", onDevices);

    // Windows locked or asleep: drop everything; nothing works until sir unlocks.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a fetch: state is set when it answers, not synchronously
    void loadIdentity();
    const offLock = window.sundayDesktop?.onLock?.(() => {
      lockedRef.current = true;
      setLocked(true);
      inFlightRef.current?.abort();
      speakerRef.current?.stop();
      endSessionRef.current();
      void wakeRef.current?.pause().catch(() => {});
      setIdentity(enrolledRef.current ? "ready" : "off");
    });
    const offUnlock = window.sundayDesktop?.onUnlock?.(() => {
      lockedRef.current = false;
      setLocked(false);
      if (!sessionRef.current) void wakeRef.current?.resume().catch(() => {});
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      offSummon?.();
      offStopDrive?.();
      offLock?.();
      offUnlock?.();
      window.removeEventListener("keydown", onKey);
      navigator.mediaDevices?.removeEventListener("devicechange", onDevices);
    };
  }, [bargeIn, loadIdentity, settle, startSession, toggleSession]);

  // Reminders and timers: collect whatever is due and announce it — voice, caption and a Windows notification.
  useEffect(() => {
    const announce = (r: { kind: "reminder" | "timer"; text: string; late: boolean }) => {
      const line =
        r.kind === "timer"
          ? `Sir, time's up${/\btimer$/i.test(r.text) ? "" : ` — ${r.text}`}.`
          : r.late
            ? `Sir, you missed a reminder while I was offline: ${r.text}.`
            : `Sir, a reminder: ${r.text}.`;
      chime("wake");
      speakerRef.current?.say(line);
      setNotice(line);
      setEntries((list) => [...list, { id: uid(), role: "assistant", text: line, tools: [] }]);
      try {
        new Notification(r.kind === "timer" ? "SUNDAY — timer" : "SUNDAY — reminder", {
          body: r.text,
          icon: "/brand/sunday-logo.png",
          silent: true,
        });
      } catch {}
    };
    // Background work that finished (a document is ready, a computer task ended).
    const tell = (n: { title: string; text: string }) => {
      chime("wake");
      speakerRef.current?.say(n.text);
      setNotice(n.text);
      setEntries((list) => [...list, { id: uid(), role: "assistant", text: n.text, tools: [] }]);
      try {
        new Notification(n.title, { body: n.text, icon: "/brand/sunday-logo.png", silent: true });
      } catch {}
    };
    const tick = async () => {
      try {
        const idle = (await window.sundayDesktop?.idleSeconds?.().catch(() => 0)) ?? 0;
        const res = await api(`/api/reminders?action=claim&idle=${Math.round(idle)}`, { method: "POST" });
        if (!res.ok) return;
        const { due, notices = [] } = (await res.json()) as {
          due: { kind: "reminder" | "timer"; text: string; late: boolean }[];
          notices?: { title: string; text: string }[];
        };
        due.forEach(announce);
        notices.forEach(tell);
      } catch {}
    };
    void tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, []);

  const level = useCallback(() => {
    if (speakerRef.current?.speaking) return speakerRef.current.level();
    if (sessionRef.current) return earRef.current?.level() ?? 0;
    return 0;
  }, []);

  return {
    state,
    entries,
    interim,
    status,
    notice,
    dismissNotice: () => setNotice(null),
    conversationId,
    voiceReplies,
    setVoiceReplies,
    sessionActive,
    send: (text: string) => void send(text, "text"),
    toggleSession,
    loadConversation,
    level,
    locked,
    identity,
    reloadIdentity: loadIdentity,
    pauseListening,
  };
}
