"use client";

import { useEffect, useRef, useState } from "react";
import type * as THREE_NS from "three";
import type { VoiceState } from "@/lib/client/useSunday";

/**
 * SUNDAY's head: robo_face, rigged in Blender with a "jaw" hinge (chin plate, inner jaw and lower teeth),
 * lit like a studio shot. Her jaw follows her voice; her head nods, tilts and looks around with her state.
 */
export const AVATAR_URL = "/models/sunday-face.glb";
/** Neck pivot, as a share of the model's height — her head turns about this point. */
const NECK = 0.42;
/** How far her jaw opens on her loudest syllables (radians). */
const JAW_MAX = 0.22;
/** Voice level below this is breath and room tone — her mouth stays closed. */
const JAW_FLOOR = 0.05;
/** Voice level (0..1) at which her jaw is fully open — ordinary speech sits around 0.2–0.5. */
const JAW_FULL = 0.5;
/** The glass over her eyes (pSphere3). */
const EYE_MATERIAL = "material_12";

/** How strongly her cables (red) and eyes / trim (blue) glow in each state. */
const GLOW: Record<VoiceState, { red: number; blue: number }> = {
  standby: { red: 0.2, blue: 0.45 },
  listening: { red: 0.45, blue: 1.2 },
  thinking: { red: 0.4, blue: 0.8 },
  speaking: { red: 0.55, blue: 0.9 },
};

/** Where her head points in each state: nod (down +), turn (left +), tilt (right ear down +). */
const POSE: Record<VoiceState, { nod: number; turn: number; tilt: number }> = {
  standby: { nod: 0, turn: 0, tilt: 0 },
  listening: { nod: 0.05, turn: 0, tilt: 0.07 }, // leaning in, head a little to one side
  thinking: { nod: -0.07, turn: 0.14, tilt: -0.03 }, // glancing up and away
  speaking: { nod: 0.01, turn: 0, tilt: 0 },
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
      renderer.toneMappingExposure = 1.1;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.7;

      // Warm key from the front-left, violet rim from behind (SUNDAY's accent), soft cool fill.
      const key = new THREE.DirectionalLight(0xffe2c4, 2.6);
      key.position.set(-1.2, 1.6, 2.2);
      const rim = new THREE.DirectionalLight(0x9b8cff, 3.4);
      rim.position.set(1.4, 1.2, -1.8);
      const rim2 = new THREE.DirectionalLight(0x7fd7ff, 1.6);
      rim2.position.set(-1.6, 0.8, -1.4);
      scene.add(key, rim, rim2, new THREE.HemisphereLight(0x8890b0, 0x101018, 0.45));

      const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 20);

      // Glow follows her state and voice; masks come from the texture's own colours.
      const uniforms = { uRed: { value: 0 }, uBlue: { value: 0 } };
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

      const model = gltf.scene;
      model.traverse((o) => {
        const mesh = o as THREE_NS.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE_NS.MeshStandardMaterial;
        mat.envMapIntensity = 1;
        // The export's glow strengths (×5–10) bleach to white under ACES; capped, her blue and red stay coloured.
        mat.emissiveIntensity = Math.min(mat.emissiveIntensity, 1.6);
        // Her eyes are pale glass over glowing irises; darker glass lets the blue read, as in the original renders.
        if (mat.name === EYE_MATERIAL) mat.color.multiplyScalar(0.12);
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uRed = uniforms.uRed;
          shader.uniforms.uBlue = uniforms.uBlue;
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform float uRed;\nuniform float uBlue;")
            .replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
              {
                vec3 c = diffuseColor.rgb;
                float mx = max(c.r, max(c.g, c.b));
                float mn = min(c.r, min(c.g, c.b));
                float sat = mx > 0.0001 ? (mx - mn) / mx : 0.0;
                // Vivid red: the cable bundles and the trim on her skull (her black shell is unsaturated).
                float red = smoothstep(0.6, 0.85, sat) * step(c.b * 2.0, c.r) * step(c.g * 1.6, c.r) * smoothstep(0.06, 0.2, mx);
                // Saturated cyan-blue: her eyes and the markings on her jaw and ear discs.
                float blue = smoothstep(0.45, 0.75, sat) * step(c.r * 1.4, c.b) * smoothstep(0.05, 0.18, mx);
                totalEmissiveRadiance += c * red * uRed * 3.0 + vec3(0.35, 0.75, 1.0) * blue * uBlue * 1.8;
              }`,
            );
        };
        mat.needsUpdate = true;
      });
      const jaw = model.getObjectByName("jaw");
      const jawRest = jaw ? jaw.rotation.x : 0;

      // Centre her on the turn axis, standing on y = 0, with her head pivoting at the top of her neck.
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const neckY = size.y * NECK;
      model.position.set(-centre.x, -box.min.y - neckY, -centre.z);
      const head = new THREE.Group();
      head.position.y = neckY;
      head.add(model);
      const body = new THREE.Group();
      body.add(head);
      scene.add(body);
      // Framed on her face: eyes a little above the middle of the view.
      const lookAt = new THREE.Vector3(0, size.y * 0.6, 0);
      camera.position.set(0, size.y * 0.64, size.y * 3.1);
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
      let red = GLOW.standby.red;
      let blue = GLOW.standby.blue;
      let mouth = 0;
      const pose = { nod: 0, turn: 0, tilt: 0 };
      setReady(true);

      const tick = (now: number) => {
        const t = reduce ? 0 : now / 1000;
        const s = stateRef.current;
        const raw = levelRef.current();
        smooth += (raw - smooth) * (raw > smooth ? 0.45 : 0.12);

        const target = GLOW[s];
        const pulse = s === "thinking" ? 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2)) : 0;
        const voice = s === "speaking" ? smooth * 1.4 : s === "listening" ? smooth * 0.8 : 0;
        red += (target.red + pulse + voice - red) * 0.1;
        blue += (target.blue + pulse * 0.6 + voice * 0.5 - blue) * 0.1;
        uniforms.uRed.value = red;
        uniforms.uBlue.value = blue;

        // Jaw: opens fast on each syllable, closes a little slower — reads as speech, not flapping.
        const open = s === "speaking" && !reduce ? Math.min(1, Math.max(0, raw - JAW_FLOOR) / (JAW_FULL - JAW_FLOOR)) ** 0.8 : 0;
        mouth += (open - mouth) * (open > mouth ? 0.55 : 0.28);
        if (jaw) jaw.rotation.x = jawRest + mouth * JAW_MAX;
        // Head: eases toward the pose for her state, with life layered on top.
        const want = POSE[s];
        const ease = s === "thinking" ? 0.03 : 0.06;
        pose.nod += (want.nod - pose.nod) * ease;
        pose.turn += (want.turn - pose.turn) * ease;
        pose.tilt += (want.tilt - pose.tilt) * ease;
        // Idle: a slow, uneven look-around. Speaking: small nods on stressed words and gentle turns.
        const idle = s === "speaking" ? 0.45 : s === "listening" ? 0.25 : 1;
        const lookTurn = (Math.sin(t * 0.23) * 0.09 + Math.sin(t * 0.61 + 1.3) * 0.035) * idle;
        const lookNod = (Math.sin(t * 0.31 + 0.7) * 0.03 + Math.sin(t * 0.83) * 0.012) * idle;
        const talk = s === "speaking" ? smooth : 0;
        head.rotation.x = pose.nod + lookNod + talk * 0.07 + Math.sin(t * 2.3) * talk * 0.02;
        head.rotation.y = pose.turn + lookTurn + (s === "speaking" ? Math.sin(t * 0.9) * 0.05 : 0);
        head.rotation.z = pose.tilt + Math.sin(t * 0.47 + 2.1) * 0.015 * idle + (s === "speaking" ? Math.sin(t * 1.3) * 0.02 : 0);

        if (!down) {
          spin *= 0.9;
          turn += spin;
          turn *= 0.985; // drift back to facing front
        }
        body.rotation.y = turn;
        body.position.y = Math.sin(t * 1.2) * size.y * 0.003;
        body.scale.setScalar(1 + Math.sin(t * 1.2 + 0.6) * 0.003);

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
          for (const tex of [mat.map, mat.normalMap, mat.metalnessMap, mat.roughnessMap, mat.emissiveMap]) tex?.dispose();
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
