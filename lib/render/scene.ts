import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CityBuilding, CityDistrict, CityLayout } from '@/lib/layout/city';
import { flyToMode } from '@/lib/a11y';
import { arcSegments, type Arc } from './arcs';
import { TOKENS } from './colours';
import { buildingMatrices, cityRadius, plateMatrices } from './instances';
import {
  MAX_LABELS,
  MIN_LABEL_HEIGHT,
  MIN_LABEL_WIDTH,
  chooseLabels,
  isLabelDistrict,
  screenRect,
  type LabelCandidate,
} from './labels';

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
  /**
   * Element (positioned, `pointer-events: none`) that receives the district name labels. They are
   * decorative: the folder list and report card carry the same information as text.
   */
  labelRoot?: HTMLElement;
}

export interface CityScene {
  /** Replaces the city. The instanced mesh is sized to `layout.buildings.length`. */
  setLayout(layout: CityLayout, colours: readonly string[]): void;
  /** Recolours buildings without rebuilding; `colours[i]` belongs to `layout.buildings[i]`. */
  setColours(colours: readonly string[]): void;
  /** Outlines the given district paths (single-owner districts). */
  setBadgedDistricts(paths: ReadonlySet<string>): void;
  /** Draws co-change arcs (an empty array clears them). The caller passes arcs for the selected file only. */
  setArcs(arcs: readonly Arc[]): void;
  /** Highlights a building, or none with `null`. */
  setSelected(index: number | null): void;
  /** Tints one district on the floor (the folder list's hover or choice), or none with `null`. */
  setHighlightedDistrict(path: string | null): void;
  /** Moves the camera to frame a district (animated, or a jump under reduced motion). */
  flyToDistrict(path: string): void;
  /** Moves the camera to frame a building: animated, or an instant jump under reduced motion. */
  flyTo(index: number): void;
  setSize(width: number, height: number): void;
  /** Renders every frame (needed for the frame-time counter) instead of only when something changes. */
  setContinuous(on: boolean): void;
  setAutoRotate(on: boolean): void;
  dispose(): void;
}

const FLY_MS = 650;
/** Sky blue: apart from every stop of the ember ramp, so an arc reads against any colour mode. */
const ARC_COLOUR = '#7dd3fc';
const CLICK_SLOP_PX = 5;
const LABEL_FONT = '500 11px var(--font-mono), ui-monospace, monospace';
/** Pixel width allowed per label character (11px Fira Code is about 6.6px wide). */
const LABEL_CHAR_PX = 7;
const LABEL_LINE_PX = 14;
const FLOOR_Y = 0.05;

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
  controls.enableDamping = !reducedMotion(); // read once; a mid-session OS change applies on the next load
  controls.maxPolarAngle = Math.PI / 2 - 0.03;
  controls.autoRotateSpeed = 2;

  const unitBox = new BoxGeometry(1, 1, 1);
  const buildingGeometry = unitBox.clone().translate(0, 0.5, 0); // base at y = 0
  const buildingMaterial = new MeshLambertMaterial({ color: 0xffffff });
  const plateMaterial = new MeshLambertMaterial({ color: new Color(TOKENS.surface) });
  const outlineMaterial = new LineBasicMaterial({ color: new Color(TOKENS.accent) });
  const arcMaterial = new LineBasicMaterial({ color: new Color(ARC_COLOUR) });
  const selectionEdges = new EdgesGeometry(unitBox);
  const selectionMaterial = new LineBasicMaterial({ color: new Color('#ffffff') });
  const selection = new LineSegments(selectionEdges, selectionMaterial);
  selection.visible = false;
  scene.add(selection);

  const highlight = new Group();
  const highlightPlane = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      color: new Color(TOKENS.accent),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }),
  );
  highlightPlane.position.y = FLOOR_Y + 0.01;
  const squareGeometry = new BufferGeometry();
  // Unit square outline on the floor, scaled to the district's width and depth.
  // prettier-ignore
  squareGeometry.setAttribute('position', new Float32BufferAttribute([
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5,
    0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, -0.5,
  ], 3));
  const highlightMaterial = new LineBasicMaterial({ color: new Color(TOKENS.text) });
  const highlightEdge = new LineSegments(squareGeometry, highlightMaterial);
  highlightEdge.position.y = FLOOR_Y + 0.02;
  highlight.add(highlightPlane, highlightEdge);
  highlight.visible = false;
  scene.add(highlight);

  // Name labels: a small pool of DOM elements, moved after each rendered frame. Text is set with
  // textContent only (repo-derived strings never reach innerHTML).
  const labelEls: HTMLElement[] = [];
  let labelCandidates: { path: string; corners: Vector3[] }[] = [];
  const labelRoot = options.labelRoot;
  if (labelRoot) {
    labelRoot.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < MAX_LABELS; i++) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        display: 'none',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        font: LABEL_FONT,
        lineHeight: `${LABEL_LINE_PX}px`,
        color: TOKENS.text,
        textShadow: `0 0 3px ${TOKENS.bg}, 0 0 3px ${TOKENS.bg}, 0 1px 2px ${TOKENS.bg}`,
      });
      labelRoot.appendChild(el);
      labelEls.push(el);
    }
  }

  let layout: CityLayout = { buildings: [], districts: [] };
  let buildings: InstancedMesh | null = null;
  let plates: InstancedMesh | null = null;
  let outlines: LineSegments | null = null;
  let arcLines: LineSegments | null = null;
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
    if (e.button !== 0 || !e.isPrimary) {
      downAt = null; // right-click pan, or a second finger of a pinch: never a selection
      return;
    }
    downAt = { x: e.clientX, y: e.clientY };
    options.onHover?.(null, { x: 0, y: 0 });
  }
  function onPointerUp(e: PointerEvent): void {
    if (!downAt || e.button !== 0 || !e.isPrimary) return;
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

  const scratch = new Vector3();
  function updateLabels(): void {
    if (!labelRoot) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const candidates: LabelCandidate[] = [];
    camera.updateMatrixWorld();
    for (const c of labelCandidates) {
      const ndc = c.corners.map((corner) => {
        scratch.copy(corner).applyMatrix4(camera.matrixWorldInverse);
        const behind = scratch.z >= -camera.near;
        scratch.copy(corner).project(camera);
        return { x: scratch.x, y: scratch.y, behind };
      });
      const rect = screenRect(ndc, width, height);
      if (rect) candidates.push({ path: c.path, ...rect });
    }
    const placed = chooseLabels(candidates, {
      minWidth: MIN_LABEL_WIDTH,
      minHeight: MIN_LABEL_HEIGHT,
      charWidth: LABEL_CHAR_PX,
      lineHeight: LABEL_LINE_PX,
      anchor: 'centre',
    });
    labelEls.forEach((el, i) => {
      const l = placed[i];
      if (!l) {
        el.style.display = 'none';
        return;
      }
      if (el.textContent !== l.text) el.textContent = l.text;
      el.style.display = 'block';
      el.style.opacity = String(l.opacity);
      el.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px) translate(-50%, -50%)`;
    });
  }

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
      updateLabels();
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

  /** Animated move (or an instant jump under reduced motion) to look at `toTarget` from `distance`. */
  function flyToward(toTarget: Vector3, distance: number): void {
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 1, 1);
    const toPos = toTarget
      .clone()
      .add(dir.normalize().multiplyScalar(Math.min(controls.maxDistance, distance)));
    if (flyToMode(reducedMotion()) === 'jump') {
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
  }

  function applyColours(colours: readonly string[]): void {
    if (!buildings) return;
    const count = layout.buildings.length;
    // Write into the existing buffer: replacing the attribute would strand its GL buffer on every mode switch.
    let attr = buildings.instanceColor;
    if (!attr || attr.count !== count) {
      attr = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
      buildings.instanceColor = attr;
    }
    const data = attr.array as Float32Array;
    const c = new Color();
    for (let i = 0; i < count; i++) {
      c.set(colours[i] ?? TOKENS.cold);
      c.toArray(data, i * 3);
    }
    attr.needsUpdate = true;
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
      removeMesh(arcLines);
      arcLines = null;
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
      highlight.visible = false;
      const all = next.districts.map((d) => d.path);
      labelCandidates = next.districts
        .filter((d) => isLabelDistrict(d.path, all))
        .map((d) => ({
          path: d.path,
          corners: [
            new Vector3(d.x - d.w / 2, FLOOR_Y, d.z - d.d / 2),
            new Vector3(d.x + d.w / 2, FLOOR_Y, d.z - d.d / 2),
            new Vector3(d.x + d.w / 2, FLOOR_Y, d.z + d.d / 2),
            new Vector3(d.x - d.w / 2, FLOOR_Y, d.z + d.d / 2),
          ],
        }));
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
    setArcs(arcs) {
      removeMesh(arcLines);
      arcLines = null;
      if (arcs.length > 0) {
        const verts: number[] = [];
        for (const arc of arcs) verts.push(...arcSegments(arc));
        const g = new BufferGeometry();
        g.setAttribute('position', new Float32BufferAttribute(verts, 3));
        arcLines = new LineSegments(g, arcMaterial);
        arcLines.frustumCulled = false;
        scene.add(arcLines);
      }
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
      flyToward(
        new Vector3(b.x, b.height / 2, b.z),
        Math.max(controls.minDistance, b.footprint * 12, 8),
      );
    },
    flyToDistrict(path) {
      const d = layout.districts.find((x) => x.path === path);
      if (!d) return;
      flyToward(new Vector3(d.x, 0, d.z), Math.max(controls.minDistance, Math.max(d.w, d.d) * 1.6));
    },
    setHighlightedDistrict(path) {
      const d = path === null ? undefined : layout.districts.find((x) => x.path === path);
      highlight.visible = d !== undefined;
      if (d) {
        highlight.position.set(d.x, 0, d.z);
        highlight.scale.set(d.w, 1, d.d);
      }
      dirty = true;
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
      removeMesh(arcLines);
      scene.remove(selection);
      scene.remove(highlight);
      highlightPlane.geometry.dispose();
      (highlightPlane.material as MeshBasicMaterial).dispose();
      squareGeometry.dispose();
      highlightMaterial.dispose();
      for (const el of labelEls) el.remove();
      unitBox.dispose();
      buildingGeometry.dispose();
      selectionEdges.dispose();
      buildingMaterial.dispose();
      plateMaterial.dispose();
      outlineMaterial.dispose();
      arcMaterial.dispose();
      selectionMaterial.dispose();
      // No forceContextLoss(): React may re-run the mount effect on the same canvas (Strict Mode), and a
      // lost context cannot be reused. dispose() frees the GPU resources; the canvas goes with its element.
      renderer.dispose();
    },
  };
}
