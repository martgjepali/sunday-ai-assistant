"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getJSON, streamChat, type SystemStatus } from "./api";
import { BrowserEar, DeepgramEar, Speaker, WakeWord, chime, type Ear } from "./voice";

export type VoiceState = "standby" | "listening" | "thinking" | "speaking";

export type ToolChip = { id: string; name: string; status: "start" | "done" | "error"; detail?: string };
export type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  error?: string;
  interrupted?: boolean;
};

declare global {
  interface Window {
    sundayDesktop?: {
      isDesktop: true;
      onSummon(cb: () => void): () => void;
      minimize(): void;
      toggleFullscreen(): void;
      hide(): void;
      getAutoStart(): Promise<boolean>;
      setAutoStart(on: boolean): Promise<boolean>;
    };
  }
}

const IDLE_MS = 30_000;
/** Words that always mean "stop" — react instantly, no need to ask Jev. */
const HARD_STOP = /\b(stop|wait|hold on|cancel|pause|shut up|be quiet|enough)\b/i;
const INTERRUPT_THRESHOLD = 0.5;
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

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const statusRef = useRef<SystemStatus | null>(null);
  const convRef = useRef<string | null>(null);
  const voiceRepliesRef = useRef(true);
  voiceRepliesRef.current = voiceReplies;
  const sessionRef = useRef(false);
  const inFlightRef = useRef<AbortController | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const earRef = useRef<Ear | null>(null);
  const wakeRef = useRef<WakeWord | null>(null);
  const wakeInitRef = useRef(false);
  const sendRef = useRef<(text: string, mode: "voice" | "text") => void>(() => {});
  const endSessionRef = useRef<() => void>(() => {});

  const armIdle = useCallback(() => {
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => {
      if (!inFlightRef.current && !speakerRef.current?.speaking) endSessionRef.current();
      else armIdle();
    }, IDLE_MS);
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

  // Speaker is created once; it reads live settings through refs.
  if (!speakerRef.current && typeof window !== "undefined") {
    speakerRef.current = new Speaker(() => Boolean(statusRef.current?.voice.elevenlabs), {
      onStart: () => setState("speaking"),
      onIdle: () => settle(),
      onError: (msg) => setNotice(msg),
    });
  }

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
        if (!speaking()) return;
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
      onUtterance: async (text: string) => {
        setInterim("");
        armIdle();
        if (speaking() && !HARD_STOP.test(text) && statusRef.current?.typesafe) {
          const p = await isInterruption(text);
          // A backchannel ("mm-hm", "okay") or her own echo: keep talking and ignore it.
          if (p !== null && p < INTERRUPT_THRESHOLD && speaking()) return;
        }
        bargeIn();
        sendRef.current(text, "voice");
      },
      onError: (msg: string) => setNotice(msg),
    };
    if (statusRef.current?.stt === "deepgram") earRef.current = new DeepgramEar(hooks);
    else if (BrowserEar.supported() && !window.sundayDesktop) earRef.current = new BrowserEar(hooks);
    return earRef.current;
  }, [armIdle, bargeIn, isInterruption]);

  const startSession = useCallback(async () => {
    speakerRef.current?.unlock();
    if (sessionRef.current) return;
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
    void wakeRef.current?.resume().catch(() => {});
    if (!inFlightRef.current && !speakerRef.current?.speaking) setState("standby");
  }, []);
  endSessionRef.current = endSession;

  const send = useCallback(
    async (text: string, mode: "voice" | "text") => {
      const clean = text.trim();
      if (!clean) return;
      speakerRef.current?.unlock();
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
        for await (const ev of streamChat({ conversationId: convRef.current, text: clean, mode }, ctrl.signal)) {
          switch (ev.type) {
            case "meta":
              convRef.current = ev.conversationId;
              setConversationId(ev.conversationId);
              break;
            case "text":
              patch((e) => ({ ...e, text: e.text + ev.delta }));
              if (speak) speakerRef.current?.feed(ev.delta);
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
            case "error":
              patch((e) => ({ ...e, error: ev.message }));
              if (speak) speakerRef.current?.say(ev.message);
              break;
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        patch((e) => ({ ...e, error: message }));
      } finally {
        if (inFlightRef.current === ctrl) inFlightRef.current = null;
      }
      if (ctrl.signal.aborted) return;
      optsRef.current.onReplyDone();
      if (speak) speakerRef.current?.flush();
      else settle();
    },
    [settle],
  );
  sendRef.current = (t, m) => void send(t, m);

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
            if (!sessionRef.current) await wake.resume();
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
      if (!wake || wake.active || sessionRef.current) return;
      wake
        .resume()
        .then(() => setNotice(null))
        .catch(() => {});
    };
    navigator.mediaDevices?.addEventListener("devicechange", onDevices);
    return () => {
      cancelled = true;
      clearInterval(timer);
      offSummon?.();
      window.removeEventListener("keydown", onKey);
      navigator.mediaDevices?.removeEventListener("devicechange", onDevices);
    };
  }, [settle, startSession, toggleSession]);

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
  };
}
