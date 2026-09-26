import * as THREE from "three";
import { type Box3DModule, type b3Vec3 } from "box3d.js";
import { BODY_PARTS, scoreOf } from "@stairs/shared/damage";
import { loadLevel } from "@stairs/shared/level";
import { startRun, type Run } from "@stairs/shared/run";
import {
  BAIT_SURFACE_OFFSET,
  BOX_HALF_EXTENTS,
  createSimulation,
  MAX_ARROW_LENGTH,
  MIN_ARROW_LENGTH,
  MINE_SURFACE_OFFSET,
  TIME_STEP,
  VELOCITY_PER_METER,
  type BodyRef,
  type ForcePlacement,
  type Placement,
  type PlacementKind,
  type Simulation,
} from "@stairs/shared/simulation";
import { getEntityWorldOrigin, getEntityWorldYaw } from "@stairs/shared/trenchbroom-map";
import levelSources from "virtual:levels";
import {
  createPhysicsDebugRenderer,
  createShapeDebugGeometry,
  syncObjectToBody,
  type PhysicsDebugRenderer,
} from "./box3d-three";
import { CameraRig, type OrthographicView } from "./camera-rig";
import { IsometricCamera, yawFacingMapAngle } from "./iso-camera";
import { DamagePanel, hitFlashColor, hitFlashStrength } from "./damage-panel";
import { AimGuides } from "./aim-guides";
import { Aim, describeAim, snapAim, type AimMode } from "./force-aim";
import { ForceArrow, type ArrowPart } from "./force-arrow";
import { LevelPicker } from "./level-picker";
import { createLevelObjects } from "./map-object";
import { ExplosivesView } from "./explosives-view";
import { createTrajectoryPreview } from "./preview";
import { leaderboardAvailable } from "./api";
import { LeaderboardPanel } from "./leaderboard-panel";
import { RunTimer } from "./run-timer";
import { inventoryIcon } from "./inventory-icons";
import { PoseInterpolator } from "./pose-interpolator";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { fatLineMaterial, fatLines, strip } from "./fat-lines";

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
const LEVEL_IDS = Object.keys(levelSources);

/** Screens this narrow get the portrait layout. Keep in step with style.css. */
const NARROW_SCREEN = "(max-aspect-ratio: 4/5)";
const TOOL_LABELS: Record<PlacementKind, string> = { force: "Force", box: "Box", mine: "Mine", bait: "Bait" };
const TOOL_KEYS: Record<string, PlacementKind> = { Digit1: "force", Digit2: "box", Digit3: "mine", Digit4: "bait" };

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

const baitGeometry = new THREE.CylinderGeometry(0.07, 0.28, BAIT_SURFACE_OFFSET * 2, 18, 1, false, -0.65, 1.3);
const baitMaterial = new THREE.MeshStandardMaterial({ color: 0xf2bd32, roughness: 0.82 });
const selectedBaitMaterial = new THREE.MeshStandardMaterial({
  color: 0xffd95a,
  emissive: 0x806020,
  roughness: 0.82,
});
const cheeseHoleGeometry = new THREE.SphereGeometry(0.035, 10, 6);
const cheeseHoleMaterial = new THREE.MeshStandardMaterial({ color: 0xb97818, roughness: 1, side: THREE.DoubleSide });

function baitMesh(material: THREE.Material = baitMaterial) {
  const group = new THREE.Group();
  const cheese = new THREE.Mesh(baitGeometry, material);
  cheese.castShadow = cheese.receiveShadow = true;
  group.add(cheese);
  for (const [x, y, z] of [[0.08, 0.06, 0.08], [0.15, 0.035, -0.02], [0.06, 0.04, -0.1]] as const) {
    const hole = new THREE.Mesh(cheeseHoleGeometry, cheeseHoleMaterial);
    hole.position.set(x, y, z);
    group.add(hole);
  }
  return group;
}

/** The level named by ?level=<id> in the URL, or the first one. */
export function levelFromUrl() {
  const requested = new URLSearchParams(window.location.search).get("level");
  return requested && requested in levelSources ? requested : LEVEL_IDS[0];
}

export type GameHandle = { dispose(): void };

/**
 * Play a level inside `container`. `onSelectLevel` is called when the player
 * picks another level; the caller disposes this game and starts that one.
 */
export const Game = ({
  b3,
  container,
  levelId,
  onSelectLevel,
}: {
  b3: Box3DModule;
  container: HTMLElement;
  levelId: string;
  onSelectLevel: (levelId: string) => void;
}): GameHandle => {
  const level = loadLevel(levelSources[levelId]);
  // Everything this game adds to the page, and every listener it adds outside
  // it, goes when it's disposed.
  const root = document.createElement("div");
  container.appendChild(root);
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const { map, inventory } = level;
  const worldspawn = map.entities.find((e) => e.properties.classname === "worldspawn")?.properties ?? {};

  const scene = new THREE.Scene();
  // A level can set its sky colour with a worldspawn "sky" key, e.g. "#9ecbf2".
  scene.background = new THREE.Color(worldspawn.sky ?? 0x1a1a1a);
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
  root.appendChild(renderer.domElement);

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
  root.appendChild(debugElement);

  const hudElement = document.createElement("div");
  hudElement.id = "hud";
  root.appendChild(hudElement);

  const levelObjects = createLevelObjects(map);
  const mapObject = levelObjects.statics;
  scene.add(mapObject, ...levelObjects.movers);

  // Fit the sun's shadow camera around the whole level (with headroom for the
  // ragdoll) so everything in it can cast shadows.
  const levelBounds = new THREE.Box3()
    .setFromObject(mapObject)
    .expandByPoint(focus)
    .getBoundingSphere(new THREE.Sphere());
  levelBounds.radius += 3;
  const sun = new THREE.DirectionalLight("#fff2dc", 2.5);
  // A level can aim the sun with a worldspawn "sun" key: the direction
  // towards it in map axes, e.g. "32 -64 384" (mostly overhead).
  const sunDirection = new THREE.Vector3(-6, 11, 4);
  const [sunX, sunY, sunZ] = (worldspawn.sun ?? "").trim().split(/\s+/).map(Number);
  if ([sunX, sunY, sunZ].every(Number.isFinite)) sunDirection.set(sunX, sunZ, -sunY);
  sun.position
    .copy(sunDirection)
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

  // --- Placements and selection ----------------------------------------------

  let placements: Placement[] = [];
  let selected: number | null = null;
  let running = false;
  let tool: PlacementKind | null = null;
  let debugVisible = false;
  let previewDirty = true;

  let simulation: Simulation;
  let physicsDebug: PhysicsDebugRenderer | null = null;
  const propMeshes = new Map<number, THREE.Mesh>();
  const baitMeshes = new Map<number, THREE.Group>();
  const ratRouteLines = new THREE.Group();
  ratRouteLines.name = "Rat charge routes";
  scene.add(ratRouteLines);
  const explosives = new ExplosivesView(scene, b3);

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
  root.append(leftColumn, rightColumn);
  const damagePanel = new DamagePanel();
  const levelPicker =
    LEVEL_IDS.length > 1
      ? new LevelPicker(
          LEVEL_IDS.map((id) => {
            const message = loadLevel(levelSources[id]).map.entities[0]?.properties.message;
            return { id, name: message ?? id };
          }),
          levelId,
          onSelectLevel,
        )
      : null;
  const leaderboard = leaderboardAvailable ? new LeaderboardPanel(levelId) : null;
  // Narrow (portrait) screens stack every panel down one side, leaving the
  // rest of the screen to the game; wider ones split them across both sides.
  const narrowScreen = window.matchMedia(NARROW_SCREEN);
  const arrangePanels = () => {
    const [picker, board] = [levelPicker?.element, leaderboard?.element];
    if (narrowScreen.matches) {
      leftColumn.replaceChildren(...[picker, damagePanel.element, board].filter((el) => el !== undefined));
      rightColumn.replaceChildren();
    } else {
      leftColumn.replaceChildren(damagePanel.element);
      rightColumn.replaceChildren(...[picker, board].filter((el) => el !== undefined));
    }
  };
  arrangePanels();
  narrowScreen.addEventListener("change", arrangePanels, { signal });
  // The placements the current run started from, for submitting its score.
  let runPlacements: Placement[] = [];

  const runTitle = (r: Run) => (r.finished ? "Final score" : "Damage");
  const runTimer = new RunTimer();
  root.appendChild(runTimer.element);

  const stepRun = (r: Run) => {
    const hits = r.step();
    explosives.explode(simulation.explosions());
    for (const { bone, damage: amount } of hits) {
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

  const nextMineId = () =>
    Math.max(0, ...placements.map((p) => (p.kind === "mine" ? p.id : 0))) + 1;

  const nextPropId = () =>
    Math.max(0, ...placements.map((p) => (p.kind === "box" ? p.id : 0))) + 1;

  const nextBaitId = () =>
    Math.max(0, ...placements.map((p) => (p.kind === "bait" ? p.id : 0))) + 1;

  const syncVisuals = () => {
    simulation.movers.forEach((body, i) => syncObjectToBody(b3, body, levelObjects.movers[i]));
    for (const [id, mesh] of propMeshes) syncObjectToBody(b3, simulation.props.get(id)!, mesh);
    for (const [id, mesh] of baitMeshes) mesh.visible = !simulation.baitConsumed(id);
    explosives.sync(simulation);
    simulation.ragdoll.forEach((body, bone) => syncObjectToBody(b3, body, ragdollMeshes[bone]));
    if (physicsDebug?.object3d.visible) physicsDebug.update();
  };
  /** Everything that moves with the physics, for drawing between steps. */
  const physicsObjects = () => [
    ...levelObjects.movers,
    ...propMeshes.values(),
    ...explosives.barrelMeshes,
    ...ragdollMeshes,
  ];
  const interpolator = new PoseInterpolator();
  /** Unsimulated time (seconds) carried between frames, less than a step once caught up. */
  let stepBacklog = 0;

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
    interpolator.clear();
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

    explosives.rebuild(simulation, placements);
    for (const mesh of propMeshes.values()) mesh.removeFromParent();
    propMeshes.clear();
    for (const id of simulation.props.keys()) {
      const mesh = new THREE.Mesh(boxGeometry, boxMaterial);
      mesh.castShadow = mesh.receiveShadow = true;
      propMeshes.set(id, mesh);
      scene.add(mesh);
    }

    for (const mesh of baitMeshes.values()) mesh.removeFromParent();
    baitMeshes.clear();
    for (const placement of placements) {
      if (placement.kind !== "bait") continue;
      const mesh = baitMesh();
      mesh.position.set(...placement.position);
      mesh.userData.baitId = placement.id;
      baitMeshes.set(placement.id, mesh);
      scene.add(mesh);
    }
    for (const line of ratRouteLines.children) {
      if (!(line instanceof LineSegments2)) continue;
      line.geometry.dispose();
      if (Array.isArray(line.material)) line.material.forEach((material) => material.dispose());
      else line.material.dispose();
    }
    ratRouteLines.clear();
    const routeColors = [0xffd54a, 0xff8a65];
    simulation.ratRoutes().forEach((route, index) => {
      const points = [route.start, route.bait, route.end].map(([x, y, z]) => new THREE.Vector3(x, y + 0.12, z));
      const line = fatLines(
        strip(points),
        fatLineMaterial({ color: routeColors[index % routeColors.length], width: 3, dashed: { dashSize: 0.35, gapSize: 0.18 } }),
      );
      line.renderOrder = 1000;
      ratRouteLines.add(line);
    });
    ratRouteLines.visible = !running;

    syncVisuals();
    refreshForces();
  };

  /** Replace the placements. */
  const commit = (next: Placement[]) => {
    if (JSON.stringify(next) === JSON.stringify(placements)) {
      refreshForces();
      return;
    }
    placements = next;
    rebuild();
  };

  const addPlacement = (placement: Placement) => {
    if (running || remaining(placement.kind) <= 0) return;
    if (placement.kind === "force") selected = placements.length;
    commit([...placements, placement]);
    if (remaining(placement.kind) <= 0 && tool === placement.kind) selectTool(null);
  };

  const replacePlacement = (index: number, placement: Placement) => {
    const next = [...placements];
    next[index] = placement;
    commit(next);
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
    baitPreview.visible = false;
    explosives.showPreview(null);
    updateHud();
  };

  const useEditCamera = (editing: boolean) => {
    iso.enabled = editing;
    rig.controls.enabled = !editing;
    activeCamera = editing ? iso.camera : camera;
  };

  /** Where the edit camera goes back to after a run. */
  let editViewBeforeRun: OrthographicView = { focus: new THREE.Vector3(), direction: new THREE.Vector3(0, 1, 0), viewHeight: 8 };

  const stopRunning = () => {
    if (!running) return;
    running = false;
    for (const flash of flashes) flash.remaining = 0;
    damagePanel.update(run?.damage ?? noDamage, "Last run");
    leaderboard?.withdraw();
    // Ease back to the edit camera centred on the ragdoll's starting spot, where
    // it's about to be reset to, turned and zoomed as it was before the run.
    // It takes over once the transition ends.
    rig.follow(null);
    const view = editViewBeforeRun;
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
    editViewBeforeRun = { focus: center.clone(), direction: iso.direction.clone(), viewHeight: iso.viewHeight };
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
    // Moving things ease from where they start, not from after the first step.
    interpolator.capture(physicsObjects());
    damagePanel.update(run.damage, runTitle(run));
    boxPreview.visible = false;
    baitPreview.visible = false;
    ratRouteLines.visible = false;
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

  // Guides for the plane a force is being aimed across, matching the snapping.
  const aimGuides = new AimGuides(scene, forwardYaw);

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
      if (iso) arrows[i].setView(iso.metresPerPixel, iso.camera);
      arrows[i].setState({ selected: index === selected || (drag !== null && (drag.index ?? placements.length) === index) });
      arrowIndices.push(index);
    });
    forceArrows.visible = !running;

    for (const [id, mesh] of propMeshes) {
      const selectedProp = selected !== null ? placements[selected] : null;
      mesh.material = selectedProp?.kind === "box" && selectedProp.id === id ? selectedBoxMaterial : boxMaterial;
    }
    for (const [id, group] of baitMeshes) {
      const selectedBait = selected !== null ? placements[selected] : null;
      (group.children[0] as THREE.Mesh).material = selectedBait?.kind === "bait" && selectedBait.id === id
        ? selectedBaitMaterial
        : baitMaterial;
    }
    const selectedPlacement = selected !== null ? placements[selected] : null;
    explosives.highlight(selectedPlacement?.kind === "mine" ? selectedPlacement.id : null);

    updateGuides();
    previewDirty = true;
    updateHud();
  }

  function updateGuides() {
    const aim = drag?.kind === "aim" ? drag.aim : null;
    aimGuides.update(aim, aim && aimVector(aim));
  }

  // --- HUD --------------------------------------------------------------------

  /** An action in the toolbar, with its key in the corner like the slots' numbers. */
  function action(label: string, key: string, onClick: () => void, className = "") {
    const el = document.createElement("button");
    el.className = `action ${className}`.trim();
    el.title = `${label} (${key})`;
    const keyLabel = document.createElement("span");
    keyLabel.className = "slot-key";
    keyLabel.textContent = key;
    el.append(label, keyLabel);
    el.addEventListener("click", onClick);
    return el;
  }

  /** A hotbar slot: the item's icon, its number key, and how many are left. */
  function slot(kind: PlacementKind) {
    const key = Object.keys(TOOL_LABELS).indexOf(kind) + 1;
    const left = remaining(kind);
    const el = document.createElement("button");
    el.className = "slot";
    el.title = `${TOOL_LABELS[kind]} (${key})`;
    el.setAttribute("aria-label", `${TOOL_LABELS[kind]}, ${left} left`);
    el.classList.toggle("active", tool === kind);
    el.classList.toggle("empty", left <= 0);
    el.disabled = running || left <= 0;
    const keyLabel = document.createElement("span");
    keyLabel.className = "slot-key";
    keyLabel.textContent = String(key);
    const count = document.createElement("span");
    count.className = "slot-count";
    count.textContent = String(left);
    el.append(inventoryIcon(kind), keyLabel, count);
    el.addEventListener("click", () => selectTool(kind));
    return el;
  }

  /**
   * One toolbar: the level's items, then only the actions that can be used
   * right now. Delete (with something selected) and Clear share a place, so
   * it stays narrow.
   */
  function updateHud() {
    const offered = (Object.keys(TOOL_LABELS) as PlacementKind[]).filter((kind) => inventory[kind] > 0);
    const actions: HTMLButtonElement[] = [];
    if (!running && selected !== null) {
      const index = selected;
      actions.push(action("Delete", "Del", () => removePlacement(index)));
    } else if (!running && placements.length) {
      actions.push(action("Clear", "C", clear));
    }
    actions.push(running ? action("Reset", "Space", reset, "reset") : action("Go!", "Space", play, "go"));
    const divider = document.createElement("div");
    divider.className = "divider";
    hudElement.classList.toggle("running", running);
    hudElement.replaceChildren(...offered.map(slot), divider, ...actions);
  }

  const hint = () => {
    const touch = pointerType !== "mouse";
    const tap = touch ? "Tap" : "Click";
    if (running && run?.finished) return "Run over · reset to try again";
    if (running) return touch ? "Drag to orbit · pinch to zoom" : "Drag to orbit · scroll to zoom";
    if (drag?.kind === "aim") {
      const hints: Record<AimMode, string> = {
        create: "Drag to aim, further out for more strength",
        heading: "Drag round to turn the force",
        tilt: "Drag up or down to tilt the force",
        length: "Drag along the arrow for more or less strength",
      };
      return hints[drag.mode];
    }
    if (drag?.kind === "move") return "Drag across a body to move where the force pushes";
    const current = selected !== null ? placements[selected] : null;
    if (current?.kind === "force") {
      return "Drag the white arrows for strength · the blue arrows to turn · the pink arrows to tilt · the base to move it";
    }
    if (current?.kind === "box") return "Box selected";
    if (current?.kind === "mine") return "Mine selected";
    if (current?.kind === "bait") return "The rat charges along this line when the body approaches";
    if (tool === "force") return "Drag out from a body part to add a force";
    if (tool === "box") return `${tap} a surface to place a box`;
    if (tool === "mine") return `${tap} a surface to place a mine · anything that touches it sets it off, and blasts set off other explosives`;
    if (tool === "bait") return "Place bait on the sewer floor · the rat waits for the body, then charges along the dashed line";
    return touch
      ? "Choose an item to set up the run · tap a placed item to select it · drag to pan · pinch to zoom · twist two fingers to rotate"
      : "Choose an item to set up the run · click a placed item to select it · drag to rotate · right-drag to pan · scroll to zoom";
  };

  // --- Picking ----------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const queryFilter = b3.b3DefaultQueryFilter();
  const modifiers = { alt: false };
  const pointer = { x: 0, y: 0 };

  // Fingers need bigger targets than a mouse pointer, and different tips. Go
  // by whatever was used last (starting from the device's main pointer), so
  // touchscreen laptops follow along.
  let pointerType = window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse";
  window.addEventListener("pointerdown", (event) => (pointerType = event.pointerType), { capture: true, signal });
  const pickPixels = () => (pointerType === "touch" ? 24 : 12);

  const setPointer = (event: MouseEvent) => {
    if (event instanceof PointerEvent) pointerType = event.pointerType;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
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
      const hit = arrow.hitTest(raycaster, pickPixels());
      if (hit && (!best || hit.distance < best.distance)) best = { index: arrowIndices[i], ...hit };
    });
    return best as { index: number; part: ArrowPart; distance: number } | null;
  };

  const boxPositionFor = (hit: NonNullable<ReturnType<typeof pick>>) => {
    const [hx, hy, hz] = BOX_HALF_EXTENTS;
    const n = hit.normal;
    return hit.point.clone().add(new THREE.Vector3(n.x * hx, n.y * hy, n.z * hz));
  };

  /** A mine sitting on the surface under the pointer. */
  const minePlacementFor = (hit: NonNullable<ReturnType<typeof pick>>) => {
    const normal = hit.normal.clone().normalize();
    return {
      position: hit.point.clone().addScaledVector(normal, MINE_SURFACE_OFFSET).toArray(),
      normal: normal.toArray(),
    };
  };

  const boxBlocked = (position: THREE.Vector3) => simulation.boxOverlaps(position.toArray());

  const baitPositionFor = (hit: NonNullable<ReturnType<typeof pick>>) =>
    hit.normal.y >= 0.95 ? hit.point.clone().addScaledVector(hit.normal, BAIT_SURFACE_OFFSET) : null;

  const hitBait = () => {
    const [hit] = raycaster.intersectObjects([...baitMeshes.values()], true);
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object && object.userData.baitId === undefined) object = object.parent;
    return (object?.userData.baitId as number | undefined) ?? null;
  };

  const boxPreview = new THREE.Mesh(
    boxGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  boxPreview.visible = false;
  scene.add(boxPreview);
  const baitPreviewMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false });
  const baitPreview = baitMesh(baitPreviewMaterial);
  baitPreview.visible = false;
  scene.add(baitPreview);

  // --- Dragging forces ----------------------------------------------------------

  // "aim" sets a force's direction and strength from a fixed base point; "move"
  // slides the base point across bodies while keeping the vector. `index` is
  // the placement being edited, or null for a new force.
  type Drag =
    // `mode`: which part of the force the drag changes (see AimMode).
    | { kind: "aim"; index: number | null; target: BodyRef; localPoint: b3Vec3; aim: Aim; mode: AimMode }
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
  root.appendChild(aimLabel);
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
      drag.aim.update(raycaster.ray, drag.mode, activeCamera);
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
    replacePlacement(selected, { ...placement, vector: vector.toArray() });
    showAimLabel(vector, true);
  };

  // --- Input ------------------------------------------------------------------

  let pointerDownAt: { x: number; y: number } | null = null;
  // Set when pointerdown already did something, so pointerup isn't also a click.
  let pointerDownHandled = false;

  // Capture phase on the container, so this runs before the cameras' own
  // pointer handlers on the canvas. A press used for editing stops here, so it
  // doesn't also rotate the edit camera.
  root.addEventListener(
    "pointerdown",
    (event) => {
      // Extra fingers are for the camera (pinch and pan), not editing.
      if (event.target !== renderer.domElement || event.button !== 0 || !event.isPrimary) return;
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
        const modes: Partial<Record<ArrowPart, AimMode>> = { head: "length", tilt: "tilt", heading: "heading" };
        const mode = modes[arrowHit.part];
        if (mode) {
          startDrag({ kind: "aim", ...common, aim: new Aim(origin, new THREE.Vector3(...force.vector)), mode });
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
      startDrag({ kind: "aim", index: null, target, localPoint, aim: new Aim(hit.point), mode: "create" });
    },
    { capture: true, signal },
  );

  renderer.domElement.addEventListener("pointermove", (event) => {
    if (!event.isPrimary) return;
    setPointer(event);
    if (running) return;
    if (drag) {
      updateDrag();
      return;
    }

    const arrowHit = hitArrow();
    let cursor = "";
    const cursors: Record<ArrowPart, string> = { shaft: "pointer", tilt: "ns-resize", heading: "grab", head: "grab", tail: "move" };
    if (arrowHit) cursor = cursors[arrowHit.part];
    else if (tool === "force") {
      const hit = pick();
      if (hit && simulation.refForBody(hit.body)) cursor = "crosshair";
    }
    renderer.domElement.style.cursor = cursor;

    if (tool === "mine") {
      const hit = pick();
      const mine = hit && minePlacementFor(hit);
      explosives.showPreview(mine, mine ? simulation.mineProblem(mine.position, mine.normal) !== null : false);
    }

    if (tool === "box") {
      const hit = pick();
      boxPreview.visible = hit !== null;
      if (hit) {
        boxPreview.position.copy(boxPositionFor(hit));
        const blocked = boxBlocked(boxPreview.position);
        (boxPreview.material as THREE.MeshBasicMaterial).color.set(blocked ? 0xff4040 : 0xffffff);
      }
    }

    if (tool === "bait") {
      const hit = pick();
      const position = hit && baitPositionFor(hit);
      baitPreview.visible = position !== null;
      if (position) {
        baitPreview.position.copy(position);
        baitPreviewMaterial.color.set(simulation.baitProblem(position.toArray()) ? 0xff4040 : 0xffffff);
      }
    }
  });

  window.addEventListener("pointerup", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
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

    if (tool === "mine") {
      const mine = hit && minePlacementFor(hit);
      if (!mine || simulation.mineProblem(mine.position, mine.normal)) return;
      explosives.showPreview(null);
      addPlacement({ kind: "mine", id: nextMineId(), ...mine });
      return;
    }

    if (tool === "box") {
      if (!hit) return;
      const position = boxPositionFor(hit);
      if (boxBlocked(position)) return;
      boxPreview.visible = false;
      addPlacement({ kind: "box", id: nextPropId(), position: position.toArray() });
      return;
    }

    if (tool === "bait") {
      if (!hit) return;
      const position = baitPositionFor(hit);
      if (!position || simulation.baitProblem(position.toArray())) return;
      baitPreview.visible = false;
      addPlacement({ kind: "bait", id: nextBaitId(), position: position.toArray() });
      return;
    }

    // Bait has no physics body, so select its rendered mesh before physics picking.
    const baitId = hitBait();
    if (baitId !== null) {
      select(placements.findIndex((p) => p.kind === "bait" && p.id === baitId));
      return;
    }
    // Clicking a mine or a box selects it; clicking anything else deselects.
    const mineId = explosives.hitMine(raycaster);
    if (mineId !== null) {
      select(placements.findIndex((p) => p.kind === "mine" && p.id === mineId));
      return;
    }
    const ref = hit && simulation.refForBody(hit.body);
    const index = ref?.kind === "prop"
      ? placements.findIndex((p) => p.kind === "box" && p.id === ref.id)
      : -1;
    select(index >= 0 ? index : null);
  }, { signal });

  // Scrolling over the selected arrow changes its strength instead of zooming.
  root.addEventListener(
    "wheel",
    (event) => {
      if (event.target !== renderer.domElement || running || drag || selected === null) return;
      setPointer(event);
      if (hitArrow()?.index !== selected) return;
      event.preventDefault();
      event.stopPropagation();
      adjustStrength(event.deltaY < 0 ? STRENGTH_STEP : 1 / STRENGTH_STEP);
    },
    { capture: true, passive: false, signal },
  );

  // Keys typed into a text field (e.g. the leaderboard name) aren't game controls.
  const isTyping = (event: KeyboardEvent) => event.target instanceof HTMLInputElement;

  const onModifierChange = (event: KeyboardEvent) => {
    if (isTyping(event) || event.key !== "Alt") return;
    modifiers.alt = event.altKey;
    if (drag) {
      event.preventDefault();
      updateDrag();
    }
  };
  document.addEventListener("keyup", onModifierChange, { signal });

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
      case "KeyC":
        if (!running && !drag && placements.length) clear();
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
      case "KeyP":
        debugVisible = !debugVisible;
        physicsDebug!.object3d.visible = debugVisible;
        if (debugVisible) physicsDebug!.update();
        break;
      default:
        if (event.code in TOOL_KEYS) selectTool(TOOL_KEYS[event.code]);
    }
  }, { signal });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    iso.resize();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  }, { signal });

  rebuild();

  // Editing starts in the isometric view, centred on the ragdoll unless the
  // level says otherwise. Rotation pivots on whatever the view is centred on,
  // found with a physics raycast.
  // A level can frame its edit camera with an info_edit_camera point entity:
  // it looks at the entity's origin, facing its "angle" (a compass angle, like
  // any entity's), with "view" metres of the level visible top to bottom.
  const editCamera = map.entities.find((e) => e.properties.classname === "info_edit_camera");
  const cameraFocus = (editCamera && getEntityWorldOrigin(editCamera)) ?? ragdollMotion().center;
  const cameraAngle = Number(editCamera?.properties.angle);
  const cameraView = Number(editCamera?.properties.view);
  iso = new IsometricCamera(renderer.domElement, cameraFocus, (ray) => {
    const result = b3.b3World_CastRayClosest(
      simulation.world,
      ray.origin.toArray(),
      ray.direction.clone().multiplyScalar(PICK_DISTANCE).toArray(),
      queryFilter,
    );
    return result.hit ? new THREE.Vector3(...result.point) : null;
  }, {
    yaw: Number.isFinite(cameraAngle) ? yawFacingMapAngle(cameraAngle) : undefined,
    viewHeight: cameraView > 0 ? cameraView : undefined,
  });
  useEditCamera(true);

  const trajectory = createTrajectoryPreview(b3, map, ragdollMeshes);
  scene.add(trajectory.object3d);

  const hintElement = document.createElement("div");
  hintElement.id = "hint";
  root.appendChild(hintElement);

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
    // The physics steps at a fixed rate, however fast the screen refreshes;
    // frames between steps draw moving things partway between them.
    if (running && run && !run.finished && !rig.transitioning) {
      stepBacklog += Math.min(dt, 100) / 1000;
      while (stepBacklog >= TIME_STEP && !run.finished) {
        stepBacklog -= TIME_STEP;
        interpolator.beginStep();
        stepRun(run);
        syncVisuals();
        interpolator.capture(physicsObjects());
      }
      interpolator.apply(run.finished ? 1 : stepBacklog / TIME_STEP);
    } else {
      stepBacklog = 0;
      if (running && run?.finished) interpolator.apply(1);
    }
    if (running) {
      const { center, velocity } = ragdollMotion();
      rig.follow(center.add(velocity.multiplyScalar(LOOK_AHEAD_SECONDS).clampLength(0, MAX_LOOK_AHEAD)));
    } else if (previewDirty) {
      trajectory.update(draft());
      previewDirty = false;
    }
    trajectory.object3d.visible = !running;
    runTimer.update(running ? run : null);
    // Keep arrow handles a constant size on screen, facing the edit camera as it zooms and turns.
    if (!running) for (const arrow of arrows) arrow.setView(iso.metresPerPixel, iso.camera);
    rig.update(Math.min(dt, 100) / 1000);
    iso.update(Math.min(dt, 100) / 1000);
    updateFlashes(Math.min(dt, 100) / 1000);
    explosives.update(Math.min(dt, 100) / 1000);

    renderer.render(scene, activeCamera);
    debugElement.innerText = debugInfo({ dt });
    const hintText = hint();
    if (hintElement.textContent !== hintText) hintElement.textContent = hintText;
  };
  // Draw straight away, so switching levels doesn't show a blank frame first.
  renderer.render(scene, activeCamera);
  renderer.setAnimationLoop(animate);

  return {
    dispose() {
      lifetime.abort();
      renderer.setAnimationLoop(null);
      window.clearTimeout(aimLabelTimeout);
      rig.controls.dispose();
      simulation.destroy();
      renderer.dispose();
      // Free the GPU memory now, rather than whenever the context is collected.
      renderer.forceContextLoss();
      root.remove();
    },
  };
};
