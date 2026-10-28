"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ForceGraph3DInstance } from "3d-force-graph";
import type * as THREE_NS from "three";
import type { BrainData } from "@/lib/client/api";
import type { VoiceState } from "@/lib/client/useSunday";

export const GROUP_COLORS: Record<string, string> = {
  core: "#ffd38a",
  hub: "#f5a524",
  category: "#9be564",
  memory: "#34d399",
  conversation: "#5b9cff",
  skill: "#a48bff",
  drive: "#22d3ee",
  folder: "#3fb7c9",
  app: "#f472b6",
  mail: "#facc15",
  web: "#fb7185",
  code: "#7dd3fc",
};

export const GROUP_LABELS: Record<string, string> = {
  core: "Core",
  hub: "Hubs",
  category: "Memory types",
  memory: "Memories",
  conversation: "Conversations",
  skill: "Skills",
  drive: "Drives",
  folder: "Folders",
  app: "Programs",
  mail: "Mail",
  web: "Web",
  code: "Code",
};

const LABELLED = new Set(["core", "hub", "drive", "category"]);

export type BrainNode = BrainData["nodes"][number] & { x?: number; y?: number; z?: number };
type BrainLink = { source: string | BrainNode; target: string | BrainNode; kind?: "core" | "assoc" };

export type BrainHandle = {
  pulse(ids: string[]): void;
  focus(id: string | null): void;
  tracePath(from: string, to: string): string[] | null;
};

type Props = {
  data: BrainData | null;
  state: VoiceState;
  hidden: Set<string>;
  repel: number;
  linkLength: number;
  showLabels: boolean;
  ambient: boolean;
  autoOrbit: boolean;
  selected: string | null;
  onSelect: (id: string | null, shift: boolean) => void;
};

type NodeVisual = {
  group: THREE_NS.Group;
  mesh: THREE_NS.Mesh<THREE_NS.SphereGeometry, THREE_NS.MeshBasicMaterial>;
  glow: THREE_NS.Sprite;
  label?: THREE_NS.Sprite & { material: THREE_NS.SpriteMaterial };
  base: THREE_NS.Color;
  radius: number;
  pulseAt: number;
};

const linkEnd = (v: string | BrainNode) => (typeof v === "string" ? v : v.id);
const radiusFor = (n: BrainNode) => 1.15 * Math.cbrt(n.val) * (n.group === "core" ? 1.5 : 1.25);

export const Brain3D = forwardRef<BrainHandle, Props>(function Brain3D(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const threeRef = useRef<typeof THREE_NS | null>(null);
  const visuals = useRef(new Map<string, NodeVisual>());
  const adjacency = useRef(new Map<string, Map<string, BrainLink>>());
  const highlight = useRef<{ nodes: Set<string>; links: Set<BrainLink> } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  /* ---------- graph helpers ---------- */

  const rebuildAdjacency = (links: BrainLink[]) => {
    const adj = new Map<string, Map<string, BrainLink>>();
    for (const l of links) {
      const a = linkEnd(l.source);
      const b = linkEnd(l.target);
      if (!adj.has(a)) adj.set(a, new Map());
      if (!adj.has(b)) adj.set(b, new Map());
      adj.get(a)!.set(b, l);
      adj.get(b)!.set(a, l);
    }
    adjacency.current = adj;
  };

  const shortestPath = (from: string, to: string): string[] | null => {
    if (from === to) return [from];
    const prev = new Map<string, string>([[from, ""]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adjacency.current.get(cur)?.keys() ?? []) {
        if (prev.has(next)) continue;
        prev.set(next, cur);
        if (next === to) {
          const path = [to];
          let p = cur;
          while (p) {
            path.unshift(p);
            p = prev.get(p)!;
          }
          return path;
        }
        queue.push(next);
      }
    }
    return null;
  };

  const applyHighlight = () => {
    const h = highlight.current;
    for (const [id, v] of visuals.current) {
      const on = !h || h.nodes.has(id);
      v.mesh.material.opacity = on ? 0.95 : 0.08;
      v.glow.visible = on;
      if (v.label) v.label.material.opacity = on ? 1 : 0.1;
    }
    const g = graphRef.current;
    if (g) g.linkColor(g.linkColor()).linkWidth(g.linkWidth());
  };

  useImperativeHandle(ref, () => ({
    pulse(ids: string[]) {
      const g = graphRef.current;
      if (!g) return;
      const now = performance.now();
      ids.forEach((id, i) => {
        const v = visuals.current.get(id);
        if (!v) return;
        v.pulseAt = now + i * 40;
        // A signal travels from the core out to the neuron, hop by hop.
        const path = id === "sunday" ? null : shortestPath("sunday", id);
        path?.slice(1).forEach((node, hop) => {
          const link = adjacency.current.get(path[hop])?.get(node);
          if (link) setTimeout(() => g.emitParticle(link as never), hop * 110 + i * 30);
        });
      });
    },
    focus(id: string | null) {
      const g = graphRef.current;
      if (!g) return;
      if (!id) {
        highlight.current = null;
        applyHighlight();
        return;
      }
      const nodes = new Set([id]);
      const links = new Set<BrainLink>();
      for (const [nb, l] of adjacency.current.get(id) ?? []) {
        nodes.add(nb);
        links.add(l);
      }
      highlight.current = { nodes, links };
      applyHighlight();
      const n = (g.graphData().nodes as BrainNode[]).find((x) => x.id === id);
      if (n && n.x !== undefined) {
        const dist = 70 + radiusFor(n) * 6;
        const ratio = 1 + dist / Math.max(1, Math.hypot(n.x, n.y ?? 0, n.z ?? 0));
        // Pass plain coordinates: tweening the node object itself walks its nested
        // three.js object and throws "Cannot read properties of undefined (reading 'x')".
        const target = { x: n.x, y: n.y ?? 0, z: n.z ?? 0 };
        g.cameraPosition({ x: target.x * ratio, y: target.y * ratio, z: target.z * ratio }, target, 1100);
      }
    },
    tracePath(from: string, to: string) {
      const path = shortestPath(from, to);
      if (!path) return null;
      const nodes = new Set(path);
      const links = new Set<BrainLink>();
      path.slice(1).forEach((n, i) => {
        const l = adjacency.current.get(path[i])?.get(n);
        if (l) links.add(l);
      });
      highlight.current = { nodes, links };
      applyHighlight();
      const g = graphRef.current;
      [...links].forEach((l, i) => setTimeout(() => g?.emitParticle(l as never), i * 120));
      return path;
    },
  }));

  /* ---------- mount ---------- */

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let ambientTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeObs: ResizeObserver | undefined;
    // The node map lives for the component's whole life; the cleanup clears this same one.
    const nodeVisuals = visuals.current;

    (async () => {
      const [{ default: ForceGraph3D }, THREE, { default: SpriteText }] = await Promise.all([
        import("3d-force-graph"),
        import("three"),
        import("three-spritetext"),
      ]);
      if (disposed || !host.current) return;
      threeRef.current = THREE;

      const sphere = new THREE.SphereGeometry(1, 20, 14);
      // One soft radial texture shared by every neuron's additive glow halo.
      const glowCanvas = document.createElement("canvas");
      glowCanvas.width = glowCanvas.height = 128;
      const gctx = glowCanvas.getContext("2d")!;
      const grad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, "rgba(255,255,255,0.9)");
      grad.addColorStop(0.2, "rgba(255,255,255,0.6)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.18)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, 128, 128);
      const glowTexture = new THREE.CanvasTexture(glowCanvas);
      const g = new ForceGraph3D(host.current, { controlType: "orbit", rendererConfig: { antialias: true, alpha: false } })
        .backgroundColor("#04050a")
        .showNavInfo(false)
        .nodeId("id")
        .nodeLabel((n) => {
          const node = n as BrainNode;
          return `<div class="brain-tip"><b>${escapeHtml(node.label)}</b><span>${GROUP_LABELS[node.group] ?? node.group}</span></div>`;
        })
        .nodeThreeObject((n) => {
          const node = n as BrainNode;
          const color = new THREE.Color(GROUP_COLORS[node.group] ?? "#8892a6");
          const radius = radiusFor(node);
          const group = new THREE.Group();
          const mesh = new THREE.Mesh(
            sphere,
            new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity: 0.95 }),
          );
          mesh.scale.setScalar(radius);
          group.add(mesh);
          const glow = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: glowTexture,
              color: color.clone(),
              transparent: true,
              opacity: node.group === "core" ? 1 : 0.85,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          glow.scale.setScalar(radius * (node.group === "core" ? 9 : 5.5));
          group.add(glow);
          let label: NodeVisual["label"];
          if (LABELLED.has(node.group)) {
            const text = new SpriteText(node.group === "core" ? "S U N D A Y" : node.label, node.group === "core" ? 4.2 : 2.6, "rgba(236,238,245,0.92)");
            text.fontFace = "Geist, ui-sans-serif, system-ui";
            text.fontWeight = node.group === "core" ? "600" : "500";
            text.material.depthWrite = false;
            text.material.transparent = true;
            text.position.y = -(radius + 3.6);
            text.visible = propsRef.current.showLabels;
            text.raycast = () => {}; // labels never steal clicks from neurons behind them
            group.add(text);
            label = text as NodeVisual["label"];
          }
          visuals.current.set(node.id, { group, mesh, glow, label, base: color, radius, pulseAt: -1e9 });
          return group;
        })
        .linkColor((l) => {
          const h = highlight.current;
          const link = l as BrainLink;
          if (h) return h.links.has(link) ? "rgba(255,214,150,0.85)" : "rgba(120,130,160,0.04)";
          return link.kind === "core" ? "rgba(255,200,120,0.38)" : link.kind === "assoc" ? "rgba(120,220,180,0.26)" : "rgba(150,170,220,0.2)";
        })
        .linkOpacity(1)
        .linkWidth((l) => (highlight.current?.links.has(l as BrainLink) ? 0.6 : 0))
        .linkDirectionalParticles(0)
        .linkDirectionalParticleWidth(1.7)
        .linkDirectionalParticleSpeed(0.012)
        .linkDirectionalParticleColor((l) => {
          const src = (l as BrainLink).source;
          const group = typeof src === "string" ? "core" : src.group;
          return GROUP_COLORS[group] ?? "#ffffff";
        })
        .onNodeClick((n, e) => propsRef.current.onSelect((n as BrainNode).id, e.shiftKey))
        .onBackgroundClick(() => propsRef.current.onSelect(null, false))
        // Node dragging is off: with multi-part neurons (core + halo + label) the library's
        // drag handler can read a start position it never recorded and throw on click.
        .enableNodeDrag(false)
        .warmupTicks(40)
        .cooldownTime(12_000);

      g.cameraPosition({ x: 0, y: 40, z: 360 });

      const controls = g.controls() as { autoRotate: boolean; autoRotateSpeed: number; enableDamping: boolean };
      controls.enableDamping = true;
      graphRef.current = g;

      resizeObs = new ResizeObserver(() => {
        if (!host.current) return;
        const { clientWidth: w, clientHeight: h } = host.current;
        g.width(w).height(h);
      });
      resizeObs.observe(host.current);

      if (propsRef.current.data) setData(propsRef.current.data);

      // Neurons swell and flash white when something touches them.
      const white = new THREE.Color("#ffffff");
      const tmp = new THREE.Color();
      const tick = () => {
        const now = performance.now();
        const p = propsRef.current;
        controls.autoRotate = p.autoOrbit && !highlight.current;
        controls.autoRotateSpeed = p.state === "thinking" ? 1.1 : 0.35;
        for (const [id, v] of visuals.current) {
          const t = (now - v.pulseAt) / 1000;
          let scale = v.radius;
          if (t >= 0 && t < 1.6) {
            const k = Math.exp(-t * 3.2);
            scale *= 1 + 1.4 * k;
            tmp.copy(v.base).lerp(white, k * 0.85);
            v.mesh.material.color.copy(tmp);
          } else if (id === "sunday") {
            const breath = p.state === "speaking" ? 0.18 : p.state === "thinking" ? 0.12 : p.state === "listening" ? 0.08 : 0.04;
            const speed = p.state === "thinking" ? 280 : 900;
            scale *= 1 + breath * (0.5 + 0.5 * Math.sin(now / speed));
            v.mesh.material.color.copy(v.base);
          } else if (!v.mesh.material.color.equals(v.base)) {
            v.mesh.material.color.copy(v.base);
          }
          v.mesh.scale.setScalar(scale);
          v.glow.scale.setScalar(scale * (id === "sunday" ? 9 : 5.5));
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      // Spontaneous synapse firing — faster while SUNDAY thinks.
      const fire = () => {
        const p = propsRef.current;
        const links = g.graphData().links as BrainLink[];
        if (p.ambient && links.length) {
          const bursts = p.state === "thinking" ? 4 : p.state === "speaking" ? 2 : 1;
          for (let i = 0; i < bursts; i++) {
            const l = links[(Math.random() * links.length) | 0];
            if (!p.hidden.has(nodeGroup(l.source)) && !p.hidden.has(nodeGroup(l.target))) g.emitParticle(l as never);
          }
        }
        ambientTimer = setTimeout(fire, p.state === "thinking" ? 90 : p.state === "standby" ? 520 : 240);
      };
      fire();
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(ambientTimer);
      resizeObs?.disconnect();
      graphRef.current?._destructor();
      graphRef.current = null;
      nodeVisuals.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- data updates keep existing positions ---------- */

  const setData = (data: BrainData) => {
    const g = graphRef.current;
    if (!g) return;
    const prev = new Map((g.graphData().nodes as BrainNode[]).map((n) => [n.id, n]));
    const nodes: BrainNode[] = data.nodes.map((n) => {
      const old = prev.get(n.id);
      if (old) {
        if (old.val !== n.val || old.label !== n.label) {
          visuals.current.delete(n.id);
          return { ...n, x: old.x, y: old.y, z: old.z };
        }
        return old;
      }
      return { ...n };
    });
    // New neurons are born next to whatever they connect to.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const l of data.links) {
      const s = byId.get(l.source);
      const t = byId.get(l.target);
      if (s && t && t.x === undefined && s.x !== undefined) {
        t.x = s.x + (Math.random() - 0.5) * 10;
        t.y = (s.y ?? 0) + (Math.random() - 0.5) * 10;
        t.z = (s.z ?? 0) + (Math.random() - 0.5) * 10;
      }
    }
    for (const id of prev.keys()) if (!byId.has(id)) visuals.current.delete(id);
    const links: BrainLink[] = data.links.map((l) => ({ ...l }));
    rebuildAdjacency(links);
    g.graphData({ nodes, links } as never);
  };

  useEffect(() => {
    if (props.data) setData(props.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const hidden = props.hidden;
    g.nodeVisibility((n) => !hidden.has((n as BrainNode).group)).linkVisibility(
      (l) => !hidden.has(nodeGroup((l as BrainLink).source)) && !hidden.has(nodeGroup((l as BrainLink).target)),
    );
  }, [props.hidden]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const charge = g.d3Force("charge") as unknown as { strength(v: number): void } | undefined;
    charge?.strength(-props.repel);
    const link = g.d3Force("link") as unknown as { distance(v: number): void } | undefined;
    link?.distance(props.linkLength);
    g.d3ReheatSimulation();
  }, [props.repel, props.linkLength]);

  useEffect(() => {
    for (const v of visuals.current.values()) if (v.label) v.label.visible = props.showLabels;
  }, [props.showLabels]);

  return <div ref={host} className="brain-canvas" aria-label="SUNDAY's neural map" />;
});

function nodeGroup(v: string | BrainNode) {
  return typeof v === "string" ? "" : v.group;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
