import * as THREE from "three";
import { type Box3DModule, type b3Vec3 } from "box3d.js";
import { BODY_PARTS, scoreOf } from "@stairs/shared/damage";
import { loadLevel } from "@stairs/shared/level";
import { startRun, type Run } from "@stairs/shared/run";
import {
  BOX_HALF_EXTENTS,
  createSimulation,
  MAX_ARROW_LENGTH,
  MIN_ARROW_LENGTH,
  VELOCITY_PER_METER,
  type BodyRef,
  type ForcePlacement,
  type Placement,
  type PlacementKind,
  type Simulation,
} from "@stairs/shared/simulation";
import { getEntityWorldOrigin, getEntityWorldYaw } from "@stairs/shared/trenchbroom-map";
import level1Source from "virtual:level/level1";
import {
  createPhysicsDebugRenderer,
  createShapeDebugGeometry,
  syncObjectToBody,
  type PhysicsDebugRenderer,
} from "./box3d-three";
import { CameraRig } from "./camera-rig";
import { IsometricCamera } from "./iso-camera";
import { DamagePanel, hitFlashColor, hitFlashStrength } from "./damage-panel";
import { Aim, describeAim, snapAim } from "./force-aim";
import { ForceArrow, type ArrowPart } from "./force-arrow";
import { createMapObject3D } from "./map-object";
import { createTrajectoryPreview } from "./preview";
import { leaderboardAvailable } from "./api";
import { LeaderboardPanel } from "./leaderboard-panel";
import { RunTimer } from "./run-timer";

const FIELD_OF_VIEW = 75;
const CLIP_NEAR = 0.1;
const CLIP_FAR = 1000;
const PICK_DISTANCE = 100;
const CLICK_SLOP_PX = 5;
/** Strength multiplier per scroll notch or [ ] key press. */
const STRENGTH_STEP = 1.1;
/** A run's follow camera starts this far from the ragdoll, in the edit camera's direction. */
const RUN_CAMERA_DISTANCE = 5;
/** While following, aim this far ahead along the ragdoll's velocity. */
const LOOK_AHEAD_SECONDS = 0.15;
const MAX_LOOK_AHEAD = 1;
/** How long a body part glows after taking a hit. */
const HIT_FLASH_SECONDS = 0.4;
const LEVEL_ID = "level1";

const TOOL_LABELS: Record<PlacementKind, string> = { force: "Force", box: "Box" };
const TOOL_KEYS: Record<string, PlacementKind> = { Digit1: "force", Digit2: "box" };

function disposeObject(object: THREE.Object3D) {
  object.removeFromParent();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) =>
        m.dispose(),
      );
    }
  });
}

export const Game = async ({
  b3,
  container,
}: {
  b3: Box3DModule;
  container: HTMLElement;
}) => {
  const level = loadLevel(level1Source);
  const { map, inventory } = level;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  const camera = new THREE.PerspectiveCamera(
    FIELD_OF_VIEW,
    window.innerWidth / window.innerHeight,
    CLIP_NEAR,
    CLIP_FAR,
  );

  const renderer = new THREE.WebGLRenderer();
  // Render at the display's pixel density (capped, for performance) so the
  // scene is sharp on high-DPI screens.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const spawnEntity = map.entities.find((e) => e.properties.classname === "info_player_start");
  const focus = (spawnEntity && getEntityWorldOrigin(spawnEntity)) ?? new THREE.Vector3();
  focus.y += 1;
  // Snapping and aim descriptions are relative to the way the ragdoll faces.
  const forwardYaw = spawnEntity ? getEntityWorldYaw(spawnEntity) : 0;

  // Two camera schemes: an isometric camera for editing (created once the
  // ragdoll exists, below) and an orbiting follow camera for runs.
  const rig = new CameraRig(camera, renderer.domElement);
  rig.controls.enabled = false;
  let iso: IsometricCamera;
  let activeCamera: THREE.Camera = camera;

  const debugElement = document.createElement("div");
  debugElement.id = "debug";
  container.appendChild(debugElement);

  const hudElement = document.createElement("div");
  hudElement.id = "hud";
  container.appendChild(hudElement);

  const mapObject = createMapObject3D(map);
  scene.add(mapObject);

  // Fit the sun's shadow camera around the whole level (with headroom for the
  // ragdoll) so everything in it can cast shadows.
  const levelBounds = new THREE.Box3()
    .setFromObject(mapObject)
    .expandByPoint(focus)
    .getBoundingSphere(new THREE.Sphere());
  levelBounds.radius += 3;
  const sun = new THREE.DirectionalLight("#fff2dc", 2.5);
  sun.position
    .set(-6, 11, 4)
    .normalize()
    .multiplyScalar(levelBounds.radius * 2)
    .add(levelBounds.center);
  sun.target.position.copy(levelBounds.center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.radius = 2;
  const sc = sun.shadow.camera;
  sc.near = levelBounds.radius;
  sc.far = levelBounds.radius * 3;
  sc.left = sc.bottom = -levelBounds.radius;
  sc.right = sc.top = levelBounds.radius;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xbddcff, 0x302820, 0.8));

  // --- Placements, history and selection --------------------------------------

  let placements: Placement[] = [];
  const history: Placement[][] = [];
  // Consecutive commits with the same tag (e.g. scrolling one arrow's strength)
  // share a single undo step.
  let historyTag: string | null = null;
  let selected: number | null = null;
  let running = false;
  let tool: PlacementKind | null = null;
  let debugVisible = false;
  let previewEnabled = true;
  let previewDirty = true;

  let simulation: Simulation;
  let physicsDebug: PhysicsDebugRenderer | null = null;
  const propMeshes = new Map<number, THREE.Mesh>();

  const boxGeometry = new THREE.BoxGeometry(
    BOX_HALF_EXTENTS[0] * 2,
    BOX_HALF_EXTENTS[1] * 2,
    BOX_HALF_EXTENTS[2] * 2,
  );
  const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xb07a45, roughness: 0.9 });
  const selectedBoxMaterial = new THREE.MeshStandardMaterial({
    color: 0xb07a45,
    roughness: 0.9,
    emissive: 0x806030,
  });

  // The ragdoll is drawn as one mesh per bone, built from that bone's collision
  // shapes. Bone shapes never change, so the meshes are built once and reused.
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0ac8a, roughness: 0.7 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x3b6fb6, roughness: 0.8 });
  const trousers = new THREE.MeshStandardMaterial({ color: 0x3a3a44, roughness: 0.9 });
  // Bone order matches ragdoll.ts: pelvis, spine x3, neck, head, thigh/calf l+r,
  // upper/lower arm l+r.
  const BONE_MATERIALS = [
    trousers, shirt, shirt, shirt, skin, skin,
    trousers, trousers, trousers, trousers,
    shirt, skin, shirt, skin,
  ];
  const ragdollMeshes: THREE.Group[] = [];
  // Each bone gets its own material so it can flash independently on impact.
  const boneMaterials: THREE.MeshStandardMaterial[] = [];

  // --- Damage -------------------------------------------------------------------

  // The scored run in progress, or the last one after a reset.
  let run: Run | null = null;
  const noDamage = BODY_PARTS.map(() => 0);
  const flashes = BODY_PARTS.map(() => ({ remaining: 0, strength: 0, color: new THREE.Color() }));
  const leftColumn = document.createElement("div");
  leftColumn.id = "left-column";
  const rightColumn = document.createElement("div");
  rightColumn.id = "right-column";
  container.append(leftColumn, rightColumn);
  const damagePanel = new DamagePanel();
  leftColumn.appendChild(damagePanel.element);
  const leaderboard = leaderboardAvailable ? new LeaderboardPanel(LEVEL_ID) : null;
  if (leaderboard) rightColumn.appendChild(leaderboard.element);
  // The placements the current run started from, for submitting its score.
  let runPlacements: Placement[] = [];

  const runTitle = (r: Run) => (r.finished ? "Final score" : "Damage");
  const runTimer = new RunTimer();
  container.appendChild(runTimer.element);

  const stepRun = (r: Run) => {
    for (const { bone, damage: amount } of r.step()) {
      const flash = flashes[bone];
      const strength = hitFlashStrength(amount);
      // Don't let a glancing blow cut short the glow from a bigger one.
      if (flash.remaining <= 0 || strength >= flash.strength * (flash.remaining / HIT_FLASH_SECONDS)) {
        flash.remaining = HIT_FLASH_SECONDS;
        flash.strength = strength;
        hitFlashColor(amount, flash.color);
      }
      damagePanel.flash(bone);
    }
    damagePanel.update(r.damage, runTitle(r));
    if (r.finished) leaderboard?.offerSubmission(runPlacements, scoreOf(r.damage));
  };

  const updateFlashes = (dt: number) => {
    flashes.forEach((flash, bone) => {
      const material = boneMaterials[bone];
      if (!material) return;
      flash.remaining = Math.max(0, flash.remaining - dt);
      const k = flash.remaining / HIT_FLASH_SECONDS;
      material.emissive.copy(flash.color).multiplyScalar(flash.strength * k * k);
    });
  };

  const remaining = (kind: PlacementKind) =>
    inventory[kind] - placements.filter((p) => p.kind === kind).length;

  const nextPropId = () =>
    Math.max(0, ...placements.map((p) => (p.kind === "box" ? p.id : 0))) + 1;

  const syncVisuals = () => {
    for (const [id, mesh] of propMeshes) syncObjectToBody(b3, simulation.props.get(id)!, mesh);
    simulation.ragdoll.forEach((body, bone) => syncObjectToBody(b3, body, ragdollMeshes[bone]));
    if (physicsDebug?.object3d.visible) physicsDebug.update();
  };

  const worldPointOf = (ref: BodyRef, localPoint: b3Vec3): THREE.Vector3 => {
    const out: b3Vec3 = [0, 0, 0];
    b3.b3Body_GetWorldPoint(out, simulation.resolve(ref), localPoint);
    return new THREE.Vector3(...out);
  };

  /** The ragdoll's centre of mass, and its mass-weighted velocity. */
  const ragdollMotion = () => {
    const center = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const v: b3Vec3 = [0, 0, 0];
    let totalMass = 0;
    for (const body of simulation.ragdoll) {
      const mass = b3.b3Body_GetMass(body);
      center.addScaledVector(new THREE.Vector3(...b3.b3Body_GetWorldCenterOfMass(v, body)), mass);
      velocity.addScaledVector(new THREE.Vector3(...b3.b3Body_GetLinearVelocity(v, body)), mass);
      totalMass += mass;
    }
    return { center: center.divideScalar(totalMass), velocity: velocity.divideScalar(totalMass) };
  };

  /** Throw away the world and rebuild it at its initial state from `placements`. */
  const rebuild = () => {
    simulation?.destroy();
    simulation = createSimulation(b3, map, placements);

    if (physicsDebug) disposeObject(physicsDebug.object3d);
    physicsDebug = createPhysicsDebugRenderer(b3, simulation.world);
    physicsDebug.object3d.visible = debugVisible;
    scene.add(physicsDebug.object3d);

    if (!ragdollMeshes.length) {
      simulation.ragdoll.forEach((body, bone) => {
        const group = new THREE.Group();
        const shapes = b3.b3Body_GetShapes(body);
        for (const shape of shapes) {
          const geometry = createShapeDebugGeometry(b3, shape);
          if (!geometry) continue;
          boneMaterials[bone] ??= (BONE_MATERIALS[bone] ?? skin).clone();
          const mesh = new THREE.Mesh(geometry, boneMaterials[bone]);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }
        shapes.delete();
        ragdollMeshes.push(group);
        scene.add(group);
      });
    }

    for (const mesh of propMeshes.values()) mesh.removeFromParent();
    propMeshes.clear();
    for (const id of simulation.props.keys()) {
      const mesh = new THREE.Mesh(boxGeometry, boxMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      propMeshes.set(id, mesh);
      scene.add(mesh);
    }

    syncVisuals();
    refreshForces();
  };

  /** Replace the placements, recording the previous ones for undo. */
  const commit = (next: Placement[], tag: string | null = null) => {
    if (JSON.stringify(next) === JSON.stringify(placements)) {
      refreshForces();
      return;
    }
    if (tag === null || tag !== historyTag) history.push(structuredClone(placements));
    historyTag = tag;
    placements = next;
    rebuild();
  };

  const addPlacement = (placement: Placement) => {
    if (running || remaining(placement.kind) <= 0) return;
    if (placement.kind === "force") selected = placements.length;
    commit([...placements, placement]);
    if (remaining(placement.kind) <= 0 && tool === placement.kind) selectTool(null);
  };

  const replacePlacement = (index: number, placement: Placement, tag: string | null = null) => {
    const next = [...placements];
    next[index] = placement;
    commit(next, tag);
  };

  /** Remove a placement, along with any forces pushing on it if it's a prop. */
  const removePlacement = (index: number) => {
    const removed = placements[index];
    selected = null;
    commit(
      placements.filter(
        (p, i) =>
          i !== index &&
          !(removed.kind === "box" && p.kind === "force" && p.target.kind === "prop" && p.target.id === removed.id),
      ),
    );
  };

  const undo = () => {
    if (running || drag || !history.length) return;
    placements = history.pop()!;
    historyTag = null;
    selected = null;
    rebuild();
  };

  const clear = () => {
    stopRunning();
    selected = null;
    if (placements.length) commit([]);
    else rebuild();
  };

  const select = (index: number | null) => {
    selected = index;
    refreshForces();
  };

  const selectTool = (kind: PlacementKind | null) => {
    if (running) return;
    tool = kind && remaining(kind) > 0 && tool !== kind ? kind : null;
    boxPreview.visible = false;
    updateHud();
  };

  const useEditCamera = (editing: boolean) => {
    iso.enabled = editing;
    rig.controls.enabled = !editing;
    activeCamera = editing ? iso.camera : camera;
  };

  const stopRunning = () => {
    if (!running) return;
    running = false;
    for (const flash of flashes) flash.remaining = 0;
    damagePanel.update(run?.damage ?? noDamage, "Last run");
    leaderboard?.withdraw();
    // Ease back to the edit camera right where the run left off, keeping the
    // horizontal rotation and framing. It takes over once the transition ends.
    rig.follow(null);
    const view = rig.orthographicView;
    // A ragdoll flung off the level ends the run in empty space, so stay within
    // the level: settle on the nearest part of it instead.
    view.focus.clamp(level.bounds.min, level.bounds.max);
    iso.setView(view.focus, view.direction, view.viewHeight);
    rig.transitionTo({ focus: view.focus, direction: iso.direction, viewHeight: iso.viewHeight }, () =>
      useEditCamera(true),
    );
  };

  const play = () => {
    if (running) return;
    cancelDrag();
    // Start the follow camera looking from the same direction as the edit view.
    // Ease from the edit view into it, rather than cutting straight to the ragdoll.
    const center = ragdollMotion().center;
    rig.transitionInto(
      { target: center, position: center.clone().addScaledVector(iso.direction, RUN_CAMERA_DISTANCE) },
      { focus: iso.viewCenter(), viewHeight: iso.viewHeight, direction: iso.direction },
    );
    useEditCamera(false);
    running = true;
    tool = null;
    selected = null;
    runPlacements = placements;
    run = startRun(simulation, level.runLimits);
    damagePanel.update(run.damage, runTitle(run));
    boxPreview.visible = false;
    refreshForces();
  };

  const reset = () => {
    stopRunning();
    rebuild();
  };

  // --- Force arrows -------------------------------------------------------------

  const forceArrows = new THREE.Group();
  scene.add(forceArrows);
  const arrows: ForceArrow[] = [];
  /** Placement index drawn by each arrow; a new, uncommitted force uses placements.length. */
  const arrowIndices: number[] = [];

  // The plane the pointer moves across while aiming, drawn as a faint polar grid.
  const makeGuide = (color: number) => {
    const guide = new THREE.PolarGridHelper(MAX_ARROW_LENGTH, 16, 3, 64, color, color);
    for (const material of [guide.material].flat()) {
      Object.assign(material, { transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
    }
    guide.renderOrder = 1999;
    guide.visible = false;
    scene.add(guide);
    return guide;
  };
  const flatGuide = makeGuide(0x4dd0e1);
  const heightGuide = makeGuide(0xff80ab);

  /** The placements as they'd be if the drag in progress were committed now. */
  const draft = (): Placement[] => {
    const pending = drag && dragPlacement(drag);
    if (!drag || !pending) return placements;
    if (drag.index === null) return [...placements, pending];
    const next = [...placements];
    next[drag.index] = pending;
    return next;
  };

  function refreshForces() {
    const forces = draft()
      .map((placement, index) => ({ placement, index }))
      .filter((f): f is { placement: ForcePlacement; index: number } => f.placement.kind === "force");

    while (arrows.length > forces.length) arrows.pop()!.dispose();
    while (arrows.length < forces.length) {
      const arrow = new ForceArrow(mapObject);
      arrows.push(arrow);
      forceArrows.add(arrow.object3d);
    }
    arrowIndices.length = 0;
    forces.forEach(({ placement, index }, i) => {
      arrows[i].set(worldPointOf(placement.target, placement.localPoint), new THREE.Vector3(...placement.vector));
      arrows[i].setState({ selected: index === selected || (drag !== null && (drag.index ?? placements.length) === index) });
      arrowIndices.push(index);
    });
    forceArrows.visible = !running;

    for (const [id, mesh] of propMeshes) {
      const box = selected !== null ? placements[selected] : null;
      mesh.material = box?.kind === "box" && box.id === id ? selectedBoxMaterial : boxMaterial;
    }

    updateGuides();
    previewDirty = true;
    updateHud();
  }

  function updateGuides() {
    const aim = drag?.kind === "aim" ? drag.aim : null;
    flatGuide.visible = aim?.currentMode === "horizontal";
    heightGuide.visible = aim?.currentMode === "vertical";
    if (!aim) return;
    const tip = aim.tip();
    flatGuide.position.set(aim.origin.x, tip.y, aim.origin.z);
    heightGuide.position.set(tip.x, aim.origin.y, tip.z);
    heightGuide.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim.dragPlane.normal);
  }

  // --- HUD --------------------------------------------------------------------

  function button(label: string, onClick: () => void, options: { active?: boolean; disabled?: boolean } = {}) {
    const el = document.createElement("button");
    el.textContent = label;
    el.disabled = options.disabled ?? false;
    el.classList.toggle("active", options.active ?? false);
    el.addEventListener("click", onClick);
    return el;
  }

  function updateHud() {
    const tools = (Object.keys(TOOL_LABELS) as PlacementKind[]).map((kind, i) =>
      button(`${i + 1}. ${TOOL_LABELS[kind]} ×${remaining(kind)}`, () => selectTool(kind), {
        active: tool === kind,
        disabled: running || remaining(kind) <= 0,
      }),
    );
    hudElement.replaceChildren(
      ...tools,
      button("Undo (Z)", undo, { disabled: running || !history.length }),
      button("Delete (Del)", () => selected !== null && removePlacement(selected), {
        disabled: running || selected === null,
      }),
      button("Clear", clear, { disabled: !placements.length }),
      button("Preview (V)", togglePreview, { active: previewEnabled, disabled: running }),
      button(running ? "Reset (Space)" : "Go! (Space)", () => (running ? reset() : play())),
    );
  }

  const togglePreview = () => {
    previewEnabled = !previewEnabled;
    previewDirty = true;
    updateHud();
  };

  const hint = () => {
    if (running && run?.finished) return "Run over · Space to reset and try again";
    if (running) return "Drag to orbit · scroll to zoom · Space to reset and try again";
    if (drag?.kind === "aim") return "Drag to aim across the floor · hold Shift to change height · hold Alt to aim without snapping";
    if (drag?.kind === "move") return "Drag across a body to move where the force pushes";
    const current = selected !== null ? placements[selected] : null;
    if (current?.kind === "force") {
      return "Drag the head to re-aim · drag the base to move it · scroll over the arrow or [ ] for strength · Delete to remove";
    }
    if (current?.kind === "box") return "Delete to remove this box · Esc to deselect";
    if (tool === "force") return "Drag out from a body part to add a force";
    if (tool === "box") return "Click a surface to place a box";
    return "1: add a force · 2: add a box · click an arrow or box to edit it · drag to rotate · right-drag to pan · scroll to zoom · F to recentre";
  };

  // --- Picking ----------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const queryFilter = b3.b3DefaultQueryFilter();
  const modifiers = { shift: false, alt: false };
  const pointer = { x: 0, y: 0 };

  const setPointer = (event: MouseEvent) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    modifiers.shift = event.shiftKey;
    modifiers.alt = event.altKey;
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, activeCamera);
  };

  const pick = () => {
    const { origin, direction } = raycaster.ray;
    const result = b3.b3World_CastRayClosest(
      simulation.world,
      origin.toArray(),
      direction.clone().multiplyScalar(PICK_DISTANCE).toArray(),
      queryFilter,
    );
    if (!result.hit) return null;
    return {
      body: b3.b3Shape_GetBody(result.shapeId),
      point: new THREE.Vector3(...result.point),
      normal: new THREE.Vector3(...result.normal),
    };
  };

  /** The nearest force arrow under the pointer, and which part of it. */
  const hitArrow = () => {
    if (!forceArrows.visible) return null;
    let best: { index: number; part: ArrowPart; distance: number } | null = null;
    arrows.forEach((arrow, i) => {
      const hit = arrow.hitTest(raycaster);
      if (hit && (!best || hit.distance < best.distance)) best = { index: arrowIndices[i], ...hit };
    });
    return best as { index: number; part: ArrowPart; distance: number } | null;
  };

  const boxPositionFor = (hit: NonNullable<ReturnType<typeof pick>>) => {
    const [hx, hy, hz] = BOX_HALF_EXTENTS;
    const n = hit.normal;
    return hit.point.clone().add(new THREE.Vector3(n.x * hx, n.y * hy, n.z * hz));
  };

  const boxBlocked = (position: THREE.Vector3) => simulation.boxOverlaps(position.toArray());

  const boxPreview = new THREE.Mesh(
    boxGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  boxPreview.visible = false;
  scene.add(boxPreview);

  // --- Dragging forces ----------------------------------------------------------

  // "aim" sets a force's direction and strength from a fixed base point; "move"
  // slides the base point across bodies while keeping the vector. `index` is
  // the placement being edited, or null for a new force.
  type Drag =
    | { kind: "aim"; index: number | null; target: BodyRef; localPoint: b3Vec3; aim: Aim }
    | { kind: "move"; index: number; target: BodyRef; localPoint: b3Vec3; vector: b3Vec3 };
  let drag: Drag | null = null;

  const aimVector = (aim: Aim) => (modifiers.alt ? aim.raw.clone() : snapAim(aim.raw, forwardYaw));

  function dragPlacement(d: Drag): ForcePlacement | null {
    if (d.kind === "move") return { kind: "force", target: d.target, localPoint: d.localPoint, vector: d.vector };
    const vector = aimVector(d.aim);
    if (vector.length() < MIN_ARROW_LENGTH) return null;
    return { kind: "force", target: d.target, localPoint: d.localPoint, vector: vector.toArray() };
  }

  const aimLabel = document.createElement("div");
  aimLabel.id = "aim-label";
  container.appendChild(aimLabel);
  let aimLabelTimeout = 0;

  const showAimLabel = (vector: THREE.Vector3, linger = false) => {
    const speed = vector.length() * VELOCITY_PER_METER;
    aimLabel.textContent = `${speed.toFixed(1)} m/s · ${describeAim(vector, forwardYaw)}`;
    // Offset from the cursor in rem, so it scales with the rest of the UI.
    const offset = 1.125 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    aimLabel.style.left = `${pointer.x + offset}px`;
    aimLabel.style.top = `${pointer.y + offset}px`;
    aimLabel.style.display = "block";
    window.clearTimeout(aimLabelTimeout);
    if (linger) aimLabelTimeout = window.setTimeout(() => (aimLabel.style.display = "none"), 900);
  };

  const startDrag = (next: Drag) => {
    drag = next;
    renderer.domElement.style.cursor = "grabbing";
    updateDrag();
  };

  function updateDrag() {
    if (!drag) return;
    if (drag.kind === "aim") {
      drag.aim.update(raycaster.ray, modifiers.shift ? "vertical" : "horizontal", activeCamera);
      const vector = aimVector(drag.aim);
      if (vector.length() >= MIN_ARROW_LENGTH) showAimLabel(vector);
      else aimLabel.style.display = "none";
    } else {
      const hit = pick();
      const target = hit && simulation.refForBody(hit.body);
      if (hit && target) {
        drag.target = target;
        b3.b3Body_GetLocalPoint(drag.localPoint, hit.body, hit.point.toArray());
      }
    }
    refreshForces();
  }

  const finishDrag = () => {
    const d = drag!;
    const placement = dragPlacement(d);
    drag = null;
    renderer.domElement.style.cursor = "";
    aimLabel.style.display = "none";
    if (!placement) refreshForces();
    else if (d.index === null) addPlacement(placement);
    else replacePlacement(d.index, placement);
  };

  function cancelDrag() {
    if (!drag) return;
    drag = null;
    renderer.domElement.style.cursor = "";
    aimLabel.style.display = "none";
    refreshForces();
  }

  const adjustStrength = (factor: number) => {
    if (selected === null) return;
    const placement = placements[selected];
    if (placement.kind !== "force") return;
    const vector = new THREE.Vector3(...placement.vector);
    vector.setLength(THREE.MathUtils.clamp(vector.length() * factor, MIN_ARROW_LENGTH * 2, MAX_ARROW_LENGTH));
    replacePlacement(selected, { ...placement, vector: vector.toArray() }, `strength:${selected}`);
    showAimLabel(vector, true);
  };

  // --- Input ------------------------------------------------------------------

  let pointerDownAt: { x: number; y: number } | null = null;
  // Set when pointerdown already did something, so pointerup isn't also a click.
  let pointerDownHandled = false;

  // Capture phase on the container, so this runs before the cameras' own
  // pointer handlers on the canvas. A press used for editing stops here, so it
  // doesn't also rotate the edit camera.
  container.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target !== renderer.domElement || event.button !== 0) return;
      pointerDownAt = { x: event.clientX, y: event.clientY };
      pointerDownHandled = false;
      if (running) return;
      setPointer(event);

      const arrowHit = hitArrow();
      if (arrowHit) {
        pointerDownHandled = true;
        event.stopPropagation();
        select(arrowHit.index);
        const force = placements[arrowHit.index] as ForcePlacement;
        const origin = worldPointOf(force.target, force.localPoint);
        const common = { index: arrowHit.index, target: force.target, localPoint: [...force.localPoint] as b3Vec3 };
        if (arrowHit.part === "head") {
          startDrag({ kind: "aim", ...common, aim: new Aim(origin, new THREE.Vector3(...force.vector)) });
        } else if (arrowHit.part === "tail") {
          startDrag({ kind: "move", ...common, vector: force.vector });
        }
        return;
      }

      if (tool !== "force") return;
      const hit = pick();
      const target = hit && simulation.refForBody(hit.body);
      if (!hit || !target) return;
      pointerDownHandled = true;
      event.stopPropagation();
      const localPoint: b3Vec3 = [0, 0, 0];
      b3.b3Body_GetLocalPoint(localPoint, hit.body, hit.point.toArray());
      startDrag({ kind: "aim", index: null, target, localPoint, aim: new Aim(hit.point) });
    },
    { capture: true },
  );

  renderer.domElement.addEventListener("pointermove", (event) => {
    setPointer(event);
    if (running) return;
    if (drag) {
      updateDrag();
      return;
    }

    const arrowHit = hitArrow();
    let cursor = "";
    if (arrowHit) cursor = arrowHit.part === "shaft" ? "pointer" : "grab";
    else if (tool === "force") {
      const hit = pick();
      if (hit && simulation.refForBody(hit.body)) cursor = "crosshair";
    }
    renderer.domElement.style.cursor = cursor;

    if (tool === "box") {
      const hit = pick();
      boxPreview.visible = hit !== null;
      if (hit) {
        boxPreview.position.copy(boxPositionFor(hit));
        const blocked = boxBlocked(boxPreview.position);
        (boxPreview.material as THREE.MeshBasicMaterial).color.set(blocked ? 0xff4040 : 0xffffff);
      }
    }
  });

  window.addEventListener("pointerup", (event) => {
    if (event.button !== 0) return;
    const down = pointerDownAt;
    pointerDownAt = null;

    if (drag) {
      finishDrag();
      return;
    }
    if (pointerDownHandled) return;

    const isClick =
      down !== null &&
      event.target === renderer.domElement &&
      Math.hypot(event.clientX - down.x, event.clientY - down.y) < CLICK_SLOP_PX;
    if (!isClick || running) return;
    setPointer(event);
    const hit = pick();

    if (tool === "box") {
      if (!hit) return;
      const position = boxPositionFor(hit);
      if (boxBlocked(position)) return;
      boxPreview.visible = false;
      addPlacement({ kind: "box", id: nextPropId(), position: position.toArray() });
      return;
    }

    // Clicking a box selects it; clicking anything else deselects.
    const ref = hit && simulation.refForBody(hit.body);
    const index = ref?.kind === "prop" ? placements.findIndex((p) => p.kind === "box" && p.id === ref.id) : -1;
    select(index >= 0 ? index : null);
  });

  // Scrolling over the selected arrow changes its strength instead of zooming.
  container.addEventListener(
    "wheel",
    (event) => {
      if (event.target !== renderer.domElement || running || drag || selected === null) return;
      setPointer(event);
      if (hitArrow()?.index !== selected) return;
      event.preventDefault();
      event.stopPropagation();
      adjustStrength(event.deltaY < 0 ? STRENGTH_STEP : 1 / STRENGTH_STEP);
    },
    { capture: true, passive: false },
  );

  // Keys typed into a text field (e.g. the leaderboard name) aren't game controls.
  const isTyping = (event: KeyboardEvent) => event.target instanceof HTMLInputElement;

  const onModifierChange = (event: KeyboardEvent) => {
    if (isTyping(event) || (event.key !== "Shift" && event.key !== "Alt")) return;
    modifiers.shift = event.shiftKey;
    modifiers.alt = event.altKey;
    if (drag) {
      event.preventDefault();
      updateDrag();
    }
  };
  document.addEventListener("keyup", onModifierChange);

  document.addEventListener("keydown", (event) => {
    if (isTyping(event)) {
      if (event.code === "Escape") (event.target as HTMLElement).blur();
      return;
    }
    onModifierChange(event);
    if (event.repeat) return;
    switch (event.code) {
      case "Space":
        event.preventDefault();
        if (running) reset();
        else play();
        break;
      case "Escape":
        if (drag) cancelDrag();
        else if (selected !== null) select(null);
        else selectTool(null);
        break;
      case "KeyZ":
        undo();
        break;
      case "KeyF":
        if (!running) iso.centerOn(ragdollMotion().center);
        break;
      case "Delete":
      case "Backspace":
        if (!running && !drag && selected !== null) removePlacement(selected);
        break;
      case "BracketLeft":
      case "BracketRight":
        if (!running && !drag) adjustStrength(event.code === "BracketRight" ? STRENGTH_STEP : 1 / STRENGTH_STEP);
        break;
      case "KeyV":
        togglePreview();
        break;
      case "KeyP":
        debugVisible = !debugVisible;
        physicsDebug!.object3d.visible = debugVisible;
        if (debugVisible) physicsDebug!.update();
        break;
      default:
        if (event.code in TOOL_KEYS) selectTool(TOOL_KEYS[event.code]);
    }
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    iso.resize();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  rebuild();

  // Editing starts in the isometric view, centred on the ragdoll. Rotation
  // pivots on whatever the view is centred on, found with a physics raycast.
  iso = new IsometricCamera(renderer.domElement, ragdollMotion().center, (ray) => {
    const result = b3.b3World_CastRayClosest(
      simulation.world,
      ray.origin.toArray(),
      ray.direction.clone().multiplyScalar(PICK_DISTANCE).toArray(),
      queryFilter,
    );
    return result.hit ? new THREE.Vector3(...result.point) : null;
  });
  useEditCamera(true);

  const trajectory = createTrajectoryPreview(b3, map, ragdollMeshes);
  scene.add(trajectory.object3d);

  const hintElement = document.createElement("div");
  hintElement.id = "hint";
  container.appendChild(hintElement);

  const debugInfo = ({ dt }: { dt: number }) =>
    [
      `FPS: ${Math.round(1000 / dt)}`,
      `Physics debug: ${debugVisible ? "on" : "off"} (P)`,
    ].join(" | ");

  let lastTime = 0;
  const animate = (time: number) => {
    const dt = time - lastTime;
    lastTime = time;

    // The run waits for the camera to settle on the ragdoll, so nothing is missed.
    if (running && run && !run.finished && !rig.transitioning) {
      stepRun(run);
      syncVisuals();
    }
    if (running) {
      const { center, velocity } = ragdollMotion();
      rig.follow(center.add(velocity.multiplyScalar(LOOK_AHEAD_SECONDS).clampLength(0, MAX_LOOK_AHEAD)));
    } else if (previewEnabled && previewDirty) {
      trajectory.update(draft());
      previewDirty = false;
    }
    trajectory.object3d.visible = !running && previewEnabled;
    runTimer.update(running ? run : null);
    rig.update(Math.min(dt, 100) / 1000);
    iso.update(Math.min(dt, 100) / 1000);
    updateFlashes(Math.min(dt, 100) / 1000);

    renderer.render(scene, activeCamera);
    debugElement.innerText = debugInfo({ dt });
    const hintText = hint();
    if (hintElement.textContent !== hintText) hintElement.textContent = hintText;
  };
  renderer.setAnimationLoop(animate);
};
