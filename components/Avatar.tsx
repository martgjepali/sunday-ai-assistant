"use client";

import { useEffect, useRef, useState } from "react";
import type * as THREE_NS from "three";
import type { VoiceState } from "@/lib/client/useSunday";

/** SUNDAY's body: her Tripo-made model, lit like a studio shot and alive to her state and voice. */
export const AVATAR_URL = "/models/sunday.glb";
/** Turn (radians around the vertical) that makes the model face forward. */
const AVATAR_FACING = Math.PI / 2;
/** Where her chin sits, as a share of the model's height — glow stays below it. */
const CHIN = 0.8;

/** How strongly her cables (orange) and chest screen / visor (blue) glow in each state. */
const GLOW: Record<VoiceState, { orange: number; blue: number }> = {
  standby: { orange: 0.25, blue: 0.35 },
  listening: { orange: 0.55, blue: 1.1 },
  thinking: { orange: 0.5, blue: 0.7 },
  speaking: { orange: 0.7, blue: 0.8 },
};

type Props = {
  state: VoiceState;
  level: () => number;
  /** Called if the model or WebGL can't load, so the orb can take over. */
  onFail: () => void;
};

export function Avatar({ state, level, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(level);
  levelRef.current = level;
  const failRef = useRef(onFail);
  failRef.current = onFail;
  const dragged = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = host.current!;
    let disposed = false;
    let raf = 0;
    let cleanup = () => {};

    (async () => {
      const [THREE, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
        import("three"),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/environments/RoomEnvironment.js"),
      ]);
      if (disposed) return;

      let renderer: THREE_NS.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      } catch {
        failRef.current();
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.55;

      // Warm key from the front-left, violet rim from behind (SUNDAY's accent), soft cool fill.
      const key = new THREE.DirectionalLight(0xffe2c4, 2.4);
      key.position.set(-1.2, 1.6, 2.2);
      const rim = new THREE.DirectionalLight(0x9b8cff, 3.2);
      rim.position.set(1.4, 1.2, -1.8);
      const rim2 = new THREE.DirectionalLight(0x7fd7ff, 1.4);
      rim2.position.set(-1.6, 0.8, -1.4);
      scene.add(key, rim, rim2, new THREE.HemisphereLight(0x8890b0, 0x101018, 0.35));

      const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 20);

      // Glow follows her state and voice; masks come from the texture's own colours.
      const uniforms = { uOrange: { value: 0 }, uBlue: { value: 0 }, uChin: { value: 1e9 } };
      let gltf: Awaited<ReturnType<InstanceType<typeof GLTFLoader>["loadAsync"]>>;
      try {
        gltf = await new GLTFLoader().loadAsync(AVATAR_URL);
      } catch {
        renderer.dispose();
        renderer.domElement.remove();
        failRef.current();
        return;
      }
      if (disposed) return;

      const body = new THREE.Group();
      const model = gltf.scene;
      model.traverse((o) => {
        const mesh = o as THREE_NS.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE_NS.MeshStandardMaterial;
        mat.envMapIntensity = 1;
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uOrange = uniforms.uOrange;
          shader.uniforms.uBlue = uniforms.uBlue;
          shader.uniforms.uChin = uniforms.uChin;
          // Height in the model's own space, so the glow can stop at her chin.
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying float vModelY;")
            .replace("#include <begin_vertex>", "#include <begin_vertex>\nvModelY = position.y;");
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform float uOrange;\nuniform float uBlue;\nuniform float uChin;\nvarying float vModelY;")
            .replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
              {
                vec3 c = diffuseColor.rgb;
                float mx = max(c.r, max(c.g, c.b));
                float mn = min(c.r, min(c.g, c.b));
                float sat = mx > 0.0001 ? (mx - mn) / mx : 0.0;
                // Vivid orange: the cable bundles and lit trim (skin is far less saturated).
                float orange = smoothstep(0.72, 0.9, sat) * step(c.b * 2.2, c.r) * smoothstep(0.08, 0.22, mx) * step(c.g, c.r * 0.85);
                // Saturated blue: the chest screen.
                float blue = smoothstep(0.45, 0.75, sat) * step(c.r * 1.4, c.b) * smoothstep(0.05, 0.18, mx);
                // Her face keeps its own colours: the copper visor and skin would otherwise wash out.
                float body = 1.0 - smoothstep(uChin - 0.015, uChin + 0.015, vModelY);
                totalEmissiveRadiance += (c * (orange * uOrange * 5.0) + vec3(0.35, 0.65, 1.0) * blue * uBlue * 1.6) * body;
              }`,
            );
        };
        mat.needsUpdate = true;
      });

      // Tripo exported her facing sideways (−X); turn her to face the camera, then centre her on the turn axis.
      model.rotation.y = AVATAR_FACING;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      // Chin height as a share of her model's own height (the export stands on y = 0).
      const local = new THREE.Box3();
      model.traverse((o) => {
        const g = (o as THREE_NS.Mesh).geometry;
        if (!g) return;
        g.computeBoundingBox();
        local.union(g.boundingBox!);
      });
      uniforms.uChin.value = local.min.y + (local.max.y - local.min.y) * CHIN;
      const centre = box.getCenter(new THREE.Vector3());
      model.position.set(-centre.x, -box.min.y, -centre.z);
      body.add(model);
      scene.add(body);
      const lookAt = new THREE.Vector3(0, size.y * 0.6, 0);
      camera.position.set(0, size.y * 0.66, size.y * 2.35);
      camera.lookAt(lookAt);

      const resize = () => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      // Drag to turn her; she eases back to facing him.
      let turn = 0;
      let spin = 0;
      let down: { x: number; turn: number } | null = null;
      const onDown = (e: PointerEvent) => {
        down = { x: e.clientX, turn };
        dragged.current = false;
      };
      const onMove = (e: PointerEvent) => {
        if (!down) return;
        const dx = e.clientX - down.x;
        if (Math.abs(dx) > 4) dragged.current = true;
        const next = down.turn + dx * 0.012;
        spin = next - turn;
        turn = next;
      };
      const onUp = () => (down = null);
      el.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);

      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let smooth = 0;
      let orange = GLOW.standby.orange;
      let blue = GLOW.standby.blue;
      let nod = 0;
      setReady(true);

      const tick = (now: number) => {
        const t = reduce ? 0 : now / 1000;
        const s = stateRef.current;
        const raw = levelRef.current();
        smooth += (raw - smooth) * (raw > smooth ? 0.45 : 0.12);

        const target = GLOW[s];
        const pulse = s === "thinking" ? 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2)) : 0;
        const voice = s === "speaking" ? smooth * 1.6 : s === "listening" ? smooth * 0.8 : 0;
        orange += (target.orange + pulse + voice - orange) * 0.1;
        blue += (target.blue + pulse * 0.6 + voice * 0.5 - blue) * 0.1;
        uniforms.uOrange.value = orange;
        uniforms.uBlue.value = blue;

        if (!down) {
          spin *= 0.9;
          turn += spin;
          turn *= 0.985; // drift back to facing front
        }
        const sway = s === "listening" ? 0.03 : 0.1;
        body.rotation.y = turn + Math.sin(t * 0.35) * sway;
        nod += ((s === "speaking" ? smooth * 0.05 : s === "thinking" ? 0.025 : 0) - nod) * 0.15;
        body.rotation.x = nod + Math.sin(t * 1.1) * 0.006;
        body.position.y = Math.sin(t * 1.2) * size.y * 0.004;
        body.scale.setScalar(1 + Math.sin(t * 1.2 + 0.6) * 0.0035);

        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        ro.disconnect();
        el.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        scene.traverse((o) => {
          const mesh = o as THREE_NS.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          const mat = mesh.material as THREE_NS.MeshStandardMaterial;
          for (const tex of [mat.map, mat.normalMap, mat.metalnessMap, mat.roughnessMap]) tex?.dispose();
          mat.dispose();
        });
        scene.environment?.dispose();
        pmrem.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(() => failRef.current());

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup();
    };
  }, []);

  return (
    <div
      ref={host}
      className="avatar"
      data-ready={ready || undefined}
      onClickCapture={(e) => {
        // A drag to turn her isn't a click on her.
        if (dragged.current) {
          e.stopPropagation();
          e.preventDefault();
          dragged.current = false;
        }
      }}
    />
  );
}
