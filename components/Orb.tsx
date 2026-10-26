"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@/lib/client/useSunday";
import { Avatar } from "./Avatar";

const STATE_LABEL: Record<VoiceState, string> = {
  standby: "Standby",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const STATE_HUE: Record<VoiceState, [number, number, number]> = {
  standby: [150, 130, 220],
  listening: [110, 200, 255],
  thinking: [176, 140, 255],
  speaking: [255, 196, 110],
};

type Props = {
  state: VoiceState;
  level: () => number;
  model: string;
  wakeReady: boolean;
  onToggle: () => void;
  /** Show SUNDAY's 3D body instead of the orb. */
  body: boolean;
  onBodyChange: (body: boolean) => void;
};

export function Orb({ state, level, model, wakeReady, onToggle, body, onBodyChange }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    if (body) return;
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    let raf = 0;
    let smooth = 0;
    let color = [...STATE_HUE.standby];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const size = el.clientWidth;
      if (size < 80) {
        // Not laid out yet — drawing now would ask for negative arc radii.
        raf = requestAnimationFrame(draw);
        return;
      }
      if (el.width !== size * dpr) {
        el.width = size * dpr;
        el.height = size * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      const s = stateRef.current;
      const target = STATE_HUE[s];
      color = color.map((c, i) => c + (target[i] - c) * 0.08);
      const [r, g, b] = color.map(Math.round);
      const rgba = (a: number) => `rgba(${r},${g},${b},${a})`;

      const raw = levelRef.current();
      smooth += (raw - smooth) * (raw > smooth ? 0.45 : 0.12);
      const t = reduce ? 0 : now / 1000;
      const c = size / 2;
      const spin = s === "thinking" ? 2.4 : s === "speaking" ? 0.9 : 0.35;

      // Outer tick ring
      const outer = c - 4;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(t * 0.12 * spin);
      for (let i = 0; i < 120; i++) {
        const major = i % 10 === 0;
        const a = (i / 120) * Math.PI * 2;
        const len = major ? 7 : 3.5;
        ctx.strokeStyle = rgba(major ? 0.85 : 0.35);
        ctx.lineWidth = major ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * outer, Math.sin(a) * outer);
        ctx.lineTo(Math.cos(a) * (outer - len), Math.sin(a) * (outer - len));
        ctx.stroke();
      }
      ctx.restore();

      // Counter-rotating arc segments
      const arcs: [number, number, number, number][] = [
        [c - 16, 3, 0.6, 1],
        [c - 24, 1.5, -0.9, 0.55],
        [c - 31, 2.2, 1.4, 0.75],
      ];
      for (const [radius, width, dir, alpha] of arcs) {
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(t * dir * spin);
        ctx.strokeStyle = rgba(alpha);
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        for (let k = 0; k < 3; k++) {
          const start = (k / 3) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(0, 0, radius, start, start + Math.PI * 0.42);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Voice-reactive core
      const breath = s === "standby" ? 0.03 * Math.sin(t * 1.4) : 0;
      const coreR = (c - 44) * (0.78 + smooth * 0.32 + breath);
      const glow = ctx.createRadialGradient(c, c, coreR * 0.1, c, c, coreR * 1.55);
      glow.addColorStop(0, rgba(0.55 + smooth * 0.4));
      glow.addColorStop(0.55, rgba(0.16 + smooth * 0.2));
      glow.addColorStop(1, rgba(0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(c, c, coreR * 1.55, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = rgba(0.9);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const wobble = smooth * 5 * Math.sin(a * 6 + t * 7) + (s === "listening" ? 1.2 * Math.sin(a * 3 - t * 3) : 0);
        const rr = coreR * 0.82 + wobble;
        const x = c + Math.cos(a) * rr;
        const y = c + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = "rgba(245,246,250,0.95)";
      ctx.font = `600 ${Math.round(size * 0.075)}px Geist, ui-sans-serif, system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("S.U.N.D.A.Y.", c, c + 1);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [body]);

  return (
    <div className="orb" data-body={body || undefined}>
      <button
        className="orb-face"
        onClick={onToggle}
        aria-label={state === "speaking" ? "Stop speaking" : state === "standby" ? "Talk to SUNDAY" : "Stop listening"}
      >
        {body ? <Avatar state={state} level={level} onFail={() => onBodyChange(false)} /> : <canvas ref={canvas} />}
      </button>
      <div className="orb-state" data-state={state}>
        <span className="orb-dot" />
        {STATE_LABEL[state]}
      </div>
      <div className="orb-meta">
        <span className="chip chip-accent">◆ {model}</span>
        {wakeReady && <span className="chip">“Hey Sunday”</span>}
        <button className="chip chip-button" onClick={() => onBodyChange(!body)} aria-pressed={body}>
          {body ? "Orb" : "Body"}
        </button>
      </div>
    </div>
  );
}
