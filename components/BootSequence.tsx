"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { SystemStatus } from "@/lib/client/api";

/**
 * SUNDAY's power-on sequence, in the spirit of a Stark HUD: the emblem is
 * assembled from parts that fly in and lock together, circuits trace out,
 * the core ignites, then the real logo resolves and the HUD dives into the
 * brain. Plays once per launch; click or any key skips it.
 */

const RAYS = Array.from({ length: 12 }, (_, i) => ({ angle: i * 30, long: i % 3 === 0 }));
const PLATES = Array.from({ length: 8 }, (_, i) => i * 45 + 22.5);
const TRACES = Array.from({ length: 16 }, (_, i) => i * 22.5 + 11.25);
const ARCS = [
  { r: 182, from: 10, to: 80, spin: -140, color: "var(--accent-2)", width: 7 },
  { r: 182, from: 100, to: 170, spin: 120, color: "var(--accent-2)", width: 7 },
  { r: 182, from: 190, to: 260, spin: -100, color: "var(--accent-2)", width: 7 },
  { r: 182, from: 280, to: 350, spin: 160, color: "var(--accent-2)", width: 7 },
  { r: 150, from: 0, to: 360, spin: 90, color: "var(--accent)", width: 3 },
];
const WORD = "SUNDAY".split("");

const EASE_LOCK = "cubic-bezier(0.2, 0.9, 0.25, 1.18)"; // fast in, tiny overshoot: a mechanical "clunk"
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const polar = (r: number, deg: number) => [Math.cos(rad(deg)) * r, Math.sin(rad(deg)) * r] as const;

function arcPath(r: number, from: number, to: number) {
  if (to - from >= 360) return `M ${-r} 0 A ${r} ${r} 0 1 1 ${r} 0 A ${r} ${r} 0 1 1 ${-r} 0`;
  const [x1, y1] = polar(r, from);
  const [x2, y2] = polar(r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

function platePath(deg: number) {
  const [a, b] = [deg - 19, deg + 19];
  const [x1, y1] = polar(118, a);
  const [x2, y2] = polar(118, b);
  const [x3, y3] = polar(66, b - 4);
  const [x4, y4] = polar(66, a + 4);
  return `M ${x1} ${y1} A 118 118 0 0 1 ${x2} ${y2} L ${x3} ${y3} A 66 66 0 0 0 ${x4} ${y4} Z`;
}

function tracePoints(deg: number, i: number) {
  const bend = i % 2 ? 14 : -14;
  const [x1, y1] = polar(232, deg);
  const [x2, y2] = polar(300, deg);
  const [x3, y3] = polar(330 + (i % 3) * 22, deg + bend);
  return { d: `M ${x1} ${y1} L ${x2} ${y2} L ${x3} ${y3}`, end: [x3, y3] as const };
}

type Props = { status: SystemStatus | null; nodes: number; onReveal?: () => void; onDone: () => void };

export function BootSequence({ status, nodes, onReveal, onDone }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [progress, setProgress] = useState(0);
  const [lines, setLines] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  const finished = useRef(false);

  const readouts: [string, string][] = [
    ["NEURAL CORE", status ? (status.brain ? status.model.toUpperCase() : "NO KEY") : "LINKING"],
    ["NEURAL MAP", nodes ? `${nodes} NEURONS` : "MAPPING"],
    ["VOICE", status ? (status.voice.elevenlabs ? "ELEVENLABS" : "SYSTEM") : "…"],
    ["EARS", status ? (status.stt === "deepgram" ? "DEEPGRAM LIVE" : "OFFLINE") : "…"],
    ["INSTINCT", status ? (status.typesafe ? "JEV ONLINE" : "STANDBY") : "…"],
    ["DRIVES", status ? status.drives.map((d) => d.slice(0, 2)).join(" ") : "…"],
  ];

  // Layout effect: animations are set up before first paint, so parts never flash in place.
  useLayoutEffect(() => {
    const el = root.current;
    const s = svg.current;
    if (!el || !s) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const anims: Animation[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const play = (node: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
      const a = node.animate(frames, { fill: "both", ...opts });
      anims.push(a);
      return a;
    };
    const all = (sel: string) => Array.from(s.querySelectorAll(sel));

    const finish = (fast: boolean) => {
      if (finished.current) return;
      finished.current = true;
      revealRef.current?.();
      play(el, [{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }, { opacity: 0, transform: "scale(1.08)", filter: "blur(8px)" }], {
        duration: fast ? 260 : 620,
        easing: EASE_IN_OUT,
      }).finished.then(() => doneRef.current(), () => doneRef.current());
    };

    if (reduce) {
      setLines(readouts.length);
      setProgress(100);
      revealRef.current?.();
      play(s, [{ opacity: 0 }, { opacity: 1 }], { duration: 400 });
      const logo = s.querySelector("[data-logo]");
      const assembly = s.querySelector("[data-assembly]");
      if (logo) play(logo, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 });
      if (assembly) play(assembly, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
      timers.push(setTimeout(() => finish(false), 1400));
    } else {
      // 1 — power-on: scan line, grid, corner brackets
      const scan = el.querySelector(".jb-scan");
      if (scan) play(scan, [{ transform: "translateY(-10vh)", opacity: 0 }, { opacity: 0.9, offset: 0.15 }, { transform: "translateY(110vh)", opacity: 0 }], { duration: 900, easing: "linear" });
      el.querySelectorAll(".jb-corner").forEach((c, i) =>
        play(c, [{ opacity: 0, transform: "scale(1.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 420, delay: 150 + i * 60, easing: EASE_OUT }),
      );

      // 2 — assembly: rays fly in and lock, arcs spin into place, plates clamp the core
      all("[data-ray]").forEach((ray, i) => {
        play(ray, [{ transform: "translateY(-620px) scale(0.6)", opacity: 0 }, { opacity: 1, offset: 0.3 }, { transform: "translateY(0) scale(1)", opacity: 1 }], {
          duration: 620,
          delay: 500 + (i % 12) * 55,
          easing: EASE_LOCK,
        });
      });
      all("[data-spark]").forEach((spark, i) =>
        play(spark, [{ opacity: 0, transform: "scale(0.4)" }, { opacity: 1, transform: "scale(1.4)", offset: 0.3 }, { opacity: 0, transform: "scale(2)" }], {
          duration: 380,
          delay: 1040 + (i % 12) * 55,
          easing: EASE_OUT,
        }),
      );
      all("[data-arc]").forEach((arc, i) => {
        const spin = Number((arc as SVGElement).dataset.spin);
        play(arc, [{ transform: `rotate(${spin}deg)`, opacity: 0 }, { opacity: 1, offset: 0.25 }, { transform: "rotate(0deg)", opacity: 1 }], {
          duration: 900,
          delay: 700 + i * 90,
          easing: EASE_IN_OUT,
        });
      });
      all("[data-ticks]").forEach((t) => play(t, [{ transform: "rotate(-60deg)", opacity: 0 }, { transform: "rotate(0deg)", opacity: 0.8 }], { duration: 1100, delay: 800, easing: EASE_OUT }));
      all("[data-plate]").forEach((plate, i) => {
        const deg = Number((plate as SVGElement).dataset.deg);
        const [dx, dy] = polar(320, deg);
        play(plate, [{ transform: `translate(${dx}px, ${dy}px) rotate(40deg)`, opacity: 0 }, { opacity: 1, offset: 0.4 }, { transform: "translate(0, 0) rotate(0deg)", opacity: 1 }], {
          duration: 560,
          delay: 1250 + i * 60,
          easing: EASE_LOCK,
        });
      });
      all("[data-core]").forEach((core) =>
        play(core, [{ transform: "scale(0.2)", opacity: 0 }, { transform: "scale(1.5)", opacity: 1, offset: 0.55 }, { transform: "scale(1)", opacity: 1 }], {
          duration: 620,
          delay: 1850,
          easing: EASE_OUT,
        }),
      );

      // 3 — circuits trace out to their nodes
      all("[data-trace]").forEach((trace, i) => {
        const len = (trace as SVGPathElement).getTotalLength();
        (trace as SVGPathElement).style.strokeDasharray = `${len}`;
        play(trace, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 520, delay: 1900 + i * 35, easing: EASE_OUT });
      });
      all("[data-node]").forEach((node, i) =>
        play(node, [{ transform: "scale(0.4)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 260, delay: 2350 + i * 35, easing: EASE_OUT }),
      );

      // 4 — flash, resolve into the real logo, wordmark flips in
      const flash = s.querySelector("[data-flash]");
      if (flash) play(flash, [{ opacity: 0, transform: "scale(0.6)" }, { opacity: 0.95, transform: "scale(1)", offset: 0.35 }, { opacity: 0, transform: "scale(1.3)" }], { duration: 700, delay: 2700, easing: EASE_OUT });
      const assembly = s.querySelector("[data-assembly]");
      if (assembly) play(assembly, [{ opacity: 1, filter: "blur(0px)" }, { opacity: 0, filter: "blur(4px)" }], { duration: 500, delay: 2850, easing: "ease" });
      const logo = s.querySelector("[data-logo]");
      if (logo) play(logo, [{ opacity: 0, transform: "scale(0.94)", filter: "blur(6px)" }, { opacity: 1, transform: "scale(1)", filter: "blur(0px)" }], { duration: 600, delay: 2850, easing: EASE_OUT });
      el.querySelectorAll(".jb-letter").forEach((l, i) =>
        play(l, [{ opacity: 0, transform: "perspective(400px) rotateX(90deg) translateY(10px)" }, { opacity: 1, transform: "perspective(400px) rotateX(0deg) translateY(0)" }], {
          duration: 420,
          delay: 3000 + i * 70,
          easing: EASE_OUT,
        }),
      );
      const tagline = el.querySelector(".jb-tagline");
      if (tagline) play(tagline, [{ opacity: 0, letterSpacing: "0.9em" }, { opacity: 1, letterSpacing: "0.5em" }], { duration: 700, delay: 3400, easing: EASE_OUT });

      // From the logo reveal on, everything is compositor-driven: a good moment for heavy work.
      timers.push(setTimeout(() => revealRef.current?.(), 2600));

      // Readouts type in alongside; progress counts up to 100.
      readouts.forEach((_, i) => timers.push(setTimeout(() => setLines(i + 1), 900 + i * 320)));
      const start = performance.now();
      let raf = 0;
      const tick = () => {
        const p = Math.min(100, Math.round(((performance.now() - start) / 3300) * 100));
        setProgress(p);
        if (p < 100) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      timers.push(setTimeout(() => cancelAnimationFrame(raf), 4000));
      timers.push(setTimeout(() => finish(false), 4100));
    }

    const skip = () => finish(true);
    window.addEventListener("keydown", skip);
    el.addEventListener("click", skip);
    return () => {
      window.removeEventListener("keydown", skip);
      el.removeEventListener("click", skip);
      timers.forEach(clearTimeout);
      anims.forEach((a) => a.cancel());
    };
    // Runs once per launch; readouts read live props when rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="jboot" ref={root} role="status" aria-label="SUNDAY is starting">
      <div className="jb-grid" aria-hidden />
      <div className="jb-scan" aria-hidden />
      {["tl", "tr", "bl", "br"].map((c) => (
        <div key={c} className={`jb-corner jb-${c}`} aria-hidden />
      ))}

      <div className="jb-readouts" aria-hidden>
        <p className="jb-sys">SUNDAY OS // BOOT</p>
        {readouts.slice(0, lines).map(([k, v]) => (
          <p key={k} className="jb-line">
            <span>{k}</span>
            <span>{v}</span>
          </p>
        ))}
      </div>

      <div className="jb-gauge" aria-hidden>
        <p className="jb-pct">{String(progress).padStart(3, "0")}%</p>
        <div className="jb-bar">
          <div style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
        <p className="jb-sub">SYSTEMS INTEGRATION</p>
      </div>

      <svg ref={svg} className="jb-emblem" viewBox="-500 -500 1000 1000" aria-hidden>
        <defs>
          <linearGradient id="jb-ray" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ffb347" />
            <stop offset="1" stopColor="#ffe3a1" />
          </linearGradient>
          <radialGradient id="jb-core">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.35" stopColor="#ffe9b8" />
            <stop offset="0.7" stopColor="#ffc56b" stopOpacity="0.6" />
            <stop offset="1" stopColor="#ffc56b" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="jb-flash">
            <stop offset="0" stopColor="#fff6e0" />
            <stop offset="0.5" stopColor="#ffd38a" stopOpacity="0.5" />
            <stop offset="1" stopColor="#a48bff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g data-assembly>
          {TRACES.map((deg, i) => {
            const t = tracePoints(deg, i);
            return (
              <g key={deg}>
                <path data-trace d={t.d} fill="none" stroke="#a48bff" strokeWidth="3" strokeLinecap="round" opacity="0.85" />
                <circle data-node cx={t.end[0]} cy={t.end[1]} r="7" fill="none" stroke="#c4b5ff" strokeWidth="3" className="jb-self" />
              </g>
            );
          })}
          {RAYS.map(({ angle, long }) => (
            <g key={angle} transform={`rotate(${angle})`}>
              <polygon data-ray points={`${long ? -30 : -22},-232 ${long ? 30 : 22},-232 0,${long ? -440 : -350}`} fill="url(#jb-ray)" />
              <circle data-spark cx="0" cy="-236" r="14" fill="#fff3d6" className="jb-self" />
            </g>
          ))}
          <circle cx="0" cy="0" r="218" fill="none" stroke="#ffc56b" strokeWidth="5" data-arc data-spin="-40" className="jb-origin" />
          <g data-ticks className="jb-origin">
            {Array.from({ length: 72 }, (_, i) => {
              const [x1, y1] = polar(206, i * 5);
              const [x2, y2] = polar(i % 6 === 0 ? 194 : 199, i * 5);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffc56b" strokeWidth={i % 6 === 0 ? 3 : 1.5} />;
            })}
          </g>
          {ARCS.map((a, i) => (
            <path key={i} data-arc data-spin={a.spin} d={arcPath(a.r, a.from, a.to)} fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" className="jb-origin" />
          ))}
          {PLATES.map((deg) => (
            <path key={deg} data-plate data-deg={deg} d={platePath(deg)} fill="#f5a524" stroke="#ffe0a0" strokeWidth="2" className="jb-origin" />
          ))}
          <circle data-core cx="0" cy="0" r="62" fill="url(#jb-core)" className="jb-origin" />
        </g>

        <circle data-flash cx="0" cy="0" r="420" fill="url(#jb-flash)" className="jb-origin" opacity="0" />
        <image data-logo href="/brand/sunday-logo.png" x="-440" y="-440" width="880" height="880" className="jb-origin" opacity="0" />
      </svg>

      <div className="jb-wordmark" aria-hidden>
        <p className="jb-word">
          {WORD.map((l, i) => (
            <span key={i} className="jb-letter">
              {l}
            </span>
          ))}
        </p>
        <p className="jb-tagline">PERSONAL INTELLIGENCE SYSTEM</p>
      </div>

      <p className="jb-skip">click to skip</p>
    </div>
  );
}
