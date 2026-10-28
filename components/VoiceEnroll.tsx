"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { PcmTap } from "@/lib/client/voice";
import { CloseIcon } from "./Icons";

const PHRASES = [
  "Hey Sunday, it's me. Good to hear your voice again.",
  "Open my documents folder and show me what I worked on yesterday.",
  "Remind me to call the bank on Monday morning before ten.",
  "Find my newest FL Studio project and open the folder it's in.",
  "What's important in my inbox today? Keep it short, please.",
  "The quick brown fox jumps over the lazy dog by the river.",
];

type Phase = "intro" | "listening" | "recording" | "saving" | "done" | "failed";
type Props = { onClose: () => void; onSaved: () => void };

const rmsOf = (pcm: Int16Array) => {
  let s = 0;
  for (const v of pcm) s += (v / 32768) ** 2;
  return Math.sqrt(s / Math.max(1, pcm.length));
};

const send = (action: string, pcm?: Int16Array) =>
  api(`/api/voiceprint?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pcm ? pcm.slice().buffer : undefined,
  });

/** Teaches SUNDAY sir's voice: six sentences, recorded automatically as he reads. */
export function VoiceEnroll({ onClose, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [index, setIndex] = useState(0);
  const [hint, setHint] = useState("Find a quiet spot and use the microphone you'll talk to me with.");
  const meter = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const cleanup = useRef<() => void>(() => {});

  useEffect(() => () => {
    cancelled.current = true;
    cleanup.current();
  }, []);

  const run = async () => {
    const start = await send("enroll-start");
    if (!start.ok) {
      const { error } = (await start.json().catch(() => ({}))) as { error?: string };
      setHint(error ?? "Couldn't start Voice ID setup.");
      setPhase("failed");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      setHint("I can't reach a microphone. Are your headphones connected?");
      setPhase("failed");
      return;
    }
    const tap = new PcmTap(stream);
    cleanup.current = () => {
      tap.close();
      stream.getTracks().forEach((t) => t.stop());
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Measure the room's background noise so speech detection adapts to it.
    setPhase("listening");
    setHint("Listening to the room for a moment…");
    await wait(700);
    const floor = rmsOf(tap.last(0.6));
    const threshold = Math.max(0.012, floor * 3.5);

    for (let i = 0; i < PHRASES.length && !cancelled.current; ) {
      setIndex(i);
      setPhase("listening");
      setHint("Read the sentence aloud when you're ready.");
      // Wait for speech to begin…
      let speechStart = -1;
      const deadline = Date.now() + 20_000;
      while (!cancelled.current && Date.now() < deadline) {
        const level = rmsOf(tap.last(0.1));
        if (meter.current) meter.current.style.transform = `scaleX(${Math.min(1, level * 12)})`;
        if (level > threshold) {
          speechStart = tap.captured - PcmTap.RATE * 0.35;
          break;
        }
        await wait(60);
      }
      if (cancelled.current) return;
      if (speechStart < 0) {
        setHint("I didn't hear anything. Check your microphone and try again.");
        setPhase("failed");
        return;
      }
      // …record until about a second of silence (or 10 s).
      setPhase("recording");
      let quietFor = 0;
      const stopAt = Date.now() + 10_000;
      while (!cancelled.current && Date.now() < stopAt && quietFor < 1000) {
        const level = rmsOf(tap.last(0.1));
        if (meter.current) meter.current.style.transform = `scaleX(${Math.min(1, level * 12)})`;
        quietFor = level > threshold * 0.7 ? 0 : quietFor + 60;
        await wait(60);
      }
      const clip = tap.slice(speechStart, tap.captured - PcmTap.RATE * 0.6);
      const res = await send("enroll-add", clip);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; problem?: string; error?: string };
      if (!res.ok) {
        setHint(body.error ?? "Something went wrong saving that recording.");
        setPhase("failed");
        return;
      }
      if (!body.ok) {
        setHint(body.problem === "too-quiet" ? "That was too quiet. Move a little closer and read it again." : "That was too short. Read the whole sentence.");
        await wait(1400);
        continue;
      }
      i++;
      setHint("Got it.");
      await wait(600);
    }
    if (cancelled.current) return;
    cleanup.current();
    setPhase("saving");
    setHint("Building your voiceprint…");
    const saved = await send("enroll-save");
    const result = (await saved.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!saved.ok || !result.ok) {
      setHint(result.error ?? "Couldn't save your voiceprint.");
      setPhase("failed");
      return;
    }
    setPhase("done");
    setHint("Done. From now on I'll only take instructions from your voice.");
    onSaved();
  };

  const recording = phase === "listening" || phase === "recording";

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Set up Voice ID">
      <div className="modal panel enroll">
        <header className="modal-head">
          <h2>Voice ID</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label="Close">
            <CloseIcon width={16} height={16} />
          </button>
        </header>

        <div className="voice-card" data-phase={phase}>
          {phase === "intro" ? (
            <p className="voice-line">I&apos;ll show you six short sentences. Read each one aloud in your normal voice.</p>
          ) : phase === "done" ? (
            <p className="voice-line">Voiceprint saved.</p>
          ) : (
            <p className="voice-line">“{PHRASES[index]}”</p>
          )}
          <div className="voice-meter" aria-hidden>
            <div ref={meter} className="voice-meter-fill" data-recording={phase === "recording" || undefined} />
          </div>
        </div>

        <ol className="enroll-steps">
          {PHRASES.map((p, i) => (
            <li key={p} data-state={phase === "done" || i < index ? "done" : recording && i === index ? "active" : "todo"} />
          ))}
        </ol>
        <p className="enroll-instruction">
          {phase === "recording" ? "Recording…" : phase === "listening" ? "Listening" : phase === "saving" ? "Saving…" : ""}
        </p>
        <p className="enroll-hint">{hint}</p>
        <p className="enroll-privacy">Everything stays on this PC. SUNDAY stores a numeric voiceprint, never your recordings.</p>
        <div className="modal-actions">
          {phase === "intro" && (
            <button className="btn primary" onClick={() => void run()}>
              Start
            </button>
          )}
          {phase === "done" ? (
            <button className="btn primary" onClick={onClose}>
              Finish
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
