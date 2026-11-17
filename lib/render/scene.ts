import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CityBuilding, CityDistrict, CityLayout } from '@/lib/layout/city';
import { TOKENS } from './colours';
import { buildingMatrices, cityRadius, plateMatrices } from './instances';

export type SceneHit = { kind: 'building'; index: number } | { kind: 'district'; index: number };

export interface SceneOptions {
  /** Called when the pointer is over a building or district, or leaves them (`null`). Position is canvas-relative px. */
  onHover?: (hit: SceneHit | null, position: { x: number; y: number }) => void;
  /** Called on a click or tap; `null` when empty ground was clicked. */
  onSelect?: (hit: SceneHit | null) => void;
  /** Called after each rendered frame with the frame time in ms (dev counter). */
  onFrame?: (ms: number) => void;
  /** Whether to skip animation; defaults to the `prefers-reduced-motion` media query. */
  prefersReducedMotion?: () => boolean;
}

export interface CityScene {
  /** Replaces the city. The instanced mesh is sized to `layout.buildings.length`. */
  setLayout(layout: CityLayout, colours: readonly string[]): void;
  /** Recolours buildings without rebuilding; `colours[i]` belongs to `layout.buildings[i]`. */
  setColours(colours: readonly string[]): void;
  /** Outlines the given district paths (single-owner districts). */
  setBadgedDistricts(paths: ReadonlySet<string>): void;
  /** Highlights a building, or none with `null`. */
  setSelected(index: number | null): void;
  /** Moves the camera to frame a building: animated, or an instant jump under reduced motion. */
  flyTo(index: number): void;
  setSize(width: number, height: number): void;
  /** Renders every frame (needed for the frame-time counter) instead of only when something changes. */
  setContinuous(on: boolean): void;
  setAutoRotate(on: boolean): void;
  dispose(): void;
}

const FLY_MS = 650;
const CLICK_SLOP_PX = 5;

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Creates the scene on `canvas`. Throws if WebGL is unavailable. */
export function createCityScene(canvas: HTMLCanvasElement, options: SceneOptions = {}): CityScene {
  const reducedMotion =
    options.prefersReducedMotion ??
    (() =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio, 2));
  renderer.setClearColor(new Color(TOKENS.bg));

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 5000);
  scene.add(new AmbientLight(0xffffff, 1.9));
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(-0.4, 1, 0.6);
  scene.add(sun);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !reducedMotion();
  controls.maxPolarAngle = Math.PI / 2 - 0.03;
  controls.autoRotateSpeed = 2;

  const unitBox = new BoxGeometry(1, 1, 1);
  const buildingGeometry = unitBox.clone().translate(0, 0.5, 0); // base at y = 0
  const buildingMaterial = new MeshLambertMaterial({ color: 0xffffff });
  const plateMaterial = new MeshLambertMaterial({ color: new Color(TOKENS.surface) });
  const outlineMaterial = new LineBasicMaterial({ color: new Color(TOKENS.accent) });
  const selectionEdges = new EdgesGeometry(unitBox);
  const selectionMaterial = new LineBasicMaterial({ color: new Color('#ffffff') });
  const selection = new LineSegments(selectionEdges, selectionMaterial);
  selection.visible = false;
  scene.add(selection);

  let layout: CityLayout = { buildings: [], districts: [] };
  let buildings: InstancedMesh | null = null;
  let plates: InstancedMesh | null = null;
  let outlines: LineSegments | null = null;
  let selected: number | null = null;
  let radius = 1;

  let continuous = false;
  let dirty = true;
  let disposed = false;
  let rafId = 0;
  let lastTime = 0;

  let fly: {
    start: number;
    fromPos: Vector3;
    toPos: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
  } | null = null;

  function removeMesh(m: InstancedMesh | LineSegments | null): void {
    if (!m) return;
    scene.remove(m);
    if (m instanceof LineSegments) m.geometry.dispose();
    else m.dispose(); // frees the instance buffers; shared geometry and materials are disposed on teardown
  }

  function frame(): void {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
  }

  function pick(clientX: number, clientY: number): SceneHit | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    raycaster.setFromCamera(pointer, camera);
    const targets = [buildings, plates].filter((m): m is InstancedMesh => m !== null);
    if (targets.length === 0) return null;
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    return { kind: hit.object === buildings ? 'building' : 'district', index: hit.instanceId };
  }

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pendingMove: { x: number; y: number } | null = null;
  let downAt: { x: number; y: number } | null = null;

  function onPointerMove(e: PointerEvent): void {
    if (e.buttons !== 0) return; // dragging to orbit, no picking
    pendingMove = { x: e.clientX, y: e.clientY };
    dirty = true;
  }
  function onPointerLeave(): void {
    pendingMove = null;
    options.onHover?.(null, { x: 0, y: 0 });
  }
  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY };
    options.onHover?.(null, { x: 0, y: 0 });
  }
  function onPointerUp(e: PointerEvent): void {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > CLICK_SLOP_PX) return;
    options.onSelect?.(pick(e.clientX, e.clientY));
  }
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  controls.addEventListener('change', () => {
    dirty = true;
  });

  function tick(now: number): void {
    if (disposed) return;
    if (fly) {
      const t = Math.min(1, (now - fly.start) / FLY_MS);
      const k = easeInOut(t);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, k);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, k);
      if (t >= 1) fly = null;
      dirty = true;
    }
    const moved = controls.update();
    if (pendingMove) {
      const p = pendingMove;
      pendingMove = null;
      const rect = canvas.getBoundingClientRect();
      options.onHover?.(pick(p.x, p.y), { x: p.x - rect.left, y: p.y - rect.top });
    }
    if (moved || dirty || continuous || controls.autoRotate) {
      dirty = false;
      renderer.render(scene, camera);
      // Frame times are only meaningful while frames render back to back.
      if (lastTime !== 0) options.onFrame?.(now - lastTime);
    }
    lastTime = continuous || controls.autoRotate ? now : 0;
    frame();
  }

  function frameCity(): void {
    radius = cityRadius(layout);
    camera.position.set(radius * 1.3, radius * 1.1, radius * 1.3);
    controls.target.set(0, 0, 0);
    controls.minDistance = Math.max(2, radius * 0.05);
    controls.maxDistance = radius * 6;
    camera.far = radius * 20;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function applyColours(colours: readonly string[]): void {
    if (!buildings) return;
    const count = layout.buildings.length;
    const data = new Float32Array(count * 3);
    const c = new Color();
    for (let i = 0; i < count; i++) {
      c.set(colours[i] ?? TOKENS.cold);
      c.toArray(data, i * 3);
    }
    buildings.instanceColor = new InstancedBufferAttribute(data, 3);
    buildings.instanceColor.needsUpdate = true;
    dirty = true;
  }

  function placeSelection(): void {
    if (selected === null || !layout.buildings[selected]) {
      selection.visible = false;
      return;
    }
    const b: CityBuilding = layout.buildings[selected]!;
    const pad = 1.15;
    selection.position.set(b.x, b.height / 2, b.z);
    selection.scale.set(b.footprint * pad, b.height * pad, b.footprint * pad);
    selection.visible = true;
  }

  function start(): void {
    lastTime = 0;
    frame();
  }
  start();

  return {
    setLayout(next, colours) {
      removeMesh(buildings);
      removeMesh(plates);
      removeMesh(outlines);
      buildings = null;
      plates = null;
      outlines = null;
      layout = next;
      selected = null;
      selection.visible = false;
      fly = null;
      if (next.buildings.length > 0) {
        // Exactly one instance per building: no fixed cap.
        buildings = new InstancedMesh(buildingGeometry, buildingMaterial, next.buildings.length);
        buildings.instanceMatrix.array.set(buildingMatrices(next.buildings));
        buildings.instanceMatrix.needsUpdate = true;
        buildings.computeBoundingSphere();
        scene.add(buildings);
      }
      if (next.districts.length > 0) {
        plates = new InstancedMesh(unitBox, plateMaterial, next.districts.length);
        plates.instanceMatrix.array.set(plateMatrices(next.districts));
        plates.instanceMatrix.needsUpdate = true;
        plates.computeBoundingSphere();
        scene.add(plates);
      }
      applyColours(colours);
      frameCity();
      dirty = true;
    },
    setColours(colours) {
      applyColours(colours);
    },
    setBadgedDistricts(paths) {
      removeMesh(outlines);
      outlines = null;
      const picked: CityDistrict[] = layout.districts.filter((d) => paths.has(d.path));
      if (picked.length === 0) {
        dirty = true;
        return;
      }
      const verts: number[] = [];
      const y = 0.05;
      for (const d of picked) {
        const x0 = d.x - d.w / 2;
        const x1 = d.x + d.w / 2;
        const z0 = d.z - d.d / 2;
        const z1 = d.z + d.d / 2;
        verts.push(
          x0,
          y,
          z0,
          x1,
          y,
          z0,
          x1,
          y,
          z0,
          x1,
          y,
          z1,
          x1,
          y,
          z1,
          x0,
          y,
          z1,
          x0,
          y,
          z1,
          x0,
          y,
          z0,
        );
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(verts, 3));
      outlines = new LineSegments(g, outlineMaterial);
      scene.add(outlines);
      dirty = true;
    },
    setSelected(index) {
      selected = index;
      placeSelection();
      dirty = true;
    },
    flyTo(index) {
      const b = layout.buildings[index];
      if (!b) return;
      const toTarget = new Vector3(b.x, b.height / 2, b.z);
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1);
      const distance = Math.min(
        controls.maxDistance,
        Math.max(controls.minDistance, b.footprint * 12, 8),
      );
      const toPos = toTarget.clone().add(dir.normalize().multiplyScalar(distance));
      if (reducedMotion()) {
        camera.position.copy(toPos);
        controls.target.copy(toTarget);
        controls.update();
        dirty = true;
        return;
      }
      fly = {
        start: performance.now(),
        fromPos: camera.position.clone(),
        toPos,
        fromTarget: controls.target.clone(),
        toTarget,
      };
    },
    setSize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    },
    setContinuous(on) {
      continuous = on;
    },
    setAutoRotate(on) {
      controls.autoRotate = on && !reducedMotion();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      removeMesh(buildings);
      removeMesh(plates);
      removeMesh(outlines);
      scene.remove(selection);
      unitBox.dispose();
      buildingGeometry.dispose();
      selectionEdges.dispose();
      buildingMaterial.dispose();
      plateMaterial.dispose();
      outlineMaterial.dispose();
      selectionMaterial.dispose();
      // No forceContextLoss(): React may re-run the mount effect on the same canvas (Strict Mode), and a
      // lost context cannot be reused. dispose() frees the GPU resources; the canvas goes with its element.
      renderer.dispose();
    },
  };
}
