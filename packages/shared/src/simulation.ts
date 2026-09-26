import type { Box3DModule, b3BodyId, b3ShapeId, b3Vec3, b3WorldId } from "box3d.js";
import { levelSolids, pathProgress, type SurfaceMaterial } from "./level-entities";
import { createHuman } from "./ragdoll";
import {
  getEntityWorldOrigin,
  getEntityWorldYaw,
  type BrushGeometry,
  type TrenchBroomMap,
} from "./trenchbroom-map";

/** Change in velocity (m/s) applied per metre of force-vector arrow. */
export const VELOCITY_PER_METER = 9;
export const TIME_STEP = 1 / 60;
const SUB_STEPS = 4;
export const BOX_HALF_EXTENTS: b3Vec3 = [0.25, 0.25, 0.25];
/** Force arrows are limited to this length (metres), i.e. a maximum strength. */
export const MAX_ARROW_LENGTH = 1.5;
export const MIN_ARROW_LENGTH = 0.05;
/** Boxes may touch other things, but not overlap them by more than this. */
const BOX_OVERLAP_TOLERANCE = 0.01;
const PROP_DENSITY = 0.6;
const RAGDOLL_GROUP = 1;
const RAGDOLL_JOINT_FRICTION = 0.05;
/** Contacts approaching slower than this (m/s) aren't reported as hits. */
export const HIT_SPEED_THRESHOLD = 1.5;

/*
 * Explosives: mines the player places, and barrels placed in the map
 * ("prop_barrel", origin at the centre of its base). A mine goes off when
 * anything moving touches it; a barrel when it's hit hard. Either one caught in
 * another's blast goes off a moment later, so they chain. A blast kicks every
 * moving body within its radius outwards (and a little upwards), hardest at the
 * centre; each ragdoll part it catches takes a hit as if it struck something at
 * that speed.
 */
export const MINE_TRIGGER_RADIUS = 0.3;
export const MINE_BLAST = { radius: 3.5, speed: 16 };
export const BARREL_BLAST = { radius: 4.5, speed: 18 };
export const BARREL_RADIUS = 0.3;
export const BARREL_HEIGHT = 0.9;
/** A barrel hit harder than this (m/s) goes off. */
const BARREL_IMPACT_SPEED = 6;
/** Steps between an explosive being caught in a blast and going off itself. */
const CHAIN_DELAY_STEPS = 6;
/** Added to a blast's outward direction before normalising, to throw things up. */
const BLAST_LIFT = 0.5;
/**
 * A ragdoll part caught in a blast takes a hit at this fraction of the kick it
 * gets, so most of a blast's damage comes from where it throws the ragdoll.
 */
const BLAST_HIT_FRACTION = 0.6;
const BARREL_DENSITY = 0.4;
/** Mines sit this far off the surface they're placed on. */
export const MINE_SURFACE_OFFSET = 0.04;

/** Identifies a dynamic body in a way that survives rebuilding the world. */
export type BodyRef =
  | { kind: "ragdoll"; bone: number }
  | { kind: "prop"; id: number }
  | { kind: "barrel"; index: number };

export type ForcePlacement = {
  kind: "force";
  target: BodyRef;
  /** Attachment point in the target body's local frame. */
  localPoint: b3Vec3;
  /** Arrow drawn by the player, in world space (metres). */
  vector: b3Vec3;
};

export type BoxPlacement = {
  kind: "box";
  /** Stable identifier that forces use to refer to this prop. */
  id: number;
  position: b3Vec3;
};

export type MinePlacement = {
  kind: "mine";
  id: number;
  /** Where the mine sits, just off the surface. */
  position: b3Vec3;
  /** The surface's normal, for drawing it flat against the surface. */
  normal: b3Vec3;
};

export type Placement = ForcePlacement | BoxPlacement | MinePlacement;
export type PlacementKind = Placement["kind"];
export type Inventory = Record<PlacementKind, number>;

/** A ragdoll bone striking the level or a prop, or caught in a blast. */
export type RagdollHit = { bone: number; speed: number; point: b3Vec3 };

export type ExplosiveRef = { kind: "mine"; id: number } | { kind: "barrel"; index: number };

export type Explosion = { source: ExplosiveRef; position: b3Vec3; radius: number };

export type Simulation = {
  world: b3WorldId;
  /** Ragdoll bodies, indexed by bone. */
  ragdoll: b3BodyId[];
  /** Moving level bodies, in the same order as levelSolids(map).movers. */
  movers: b3BodyId[];
  /** Prop bodies keyed by their placement's id. */
  props: Map<number, b3BodyId>;
  /** Barrel bodies, by their order in the map. Destroyed when they go off. */
  barrels: b3BodyId[];
  /** Explosives that have gone off so far. */
  detonated(source: ExplosiveRef): boolean;
  /** Explosions during the last step. */
  explosions(): Explosion[];
  /** Why a mine can't go at `position` (on a surface with this normal), or null if it can. */
  mineProblem(position: b3Vec3, normal: b3Vec3, ignoreMine?: number): string | null;
  resolve(ref: BodyRef): b3BodyId;
  /** Look up the BodyRef for a dynamic body, or null for static geometry. */
  refForBody(body: b3BodyId): BodyRef | null;
  /** Apply every force placement's impulse. Call once, before the first step. */
  applyForces(): void;
  /**
   * True if a box at `position` would overlap the level, the ragdoll, or
   * another box (other than the box with id `ignoreProp`).
   */
  boxOverlaps(position: b3Vec3, ignoreProp?: number): boolean;
  step(): void;
  /**
   * Hits on the ragdoll during the last step, including blasts. Hits between
   * the ragdoll's own bones are skipped so flailing limbs don't count.
   */
  ragdollHits(): RagdollHit[];
  destroy(): void;
};

const bodyKey = (body: b3BodyId) =>
  `${body.index1}:${body.world0}:${body.generation}`;

/**
 * Build a fresh world from the level and the player's placements. The engine is
 * deterministic, so rebuilding from the same placements always replays the same.
 */
export function createSimulation(
  b3: Box3DModule,
  map: TrenchBroomMap,
  placements: readonly Placement[],
): Simulation {
  const world = b3.b3CreateWorld({
    ...b3.b3DefaultWorldDef(),
    gravity: [0, -9.8, 0],
    hitEventThreshold: HIT_SPEED_THRESHOLD,
  });

  // Level geometry: static solids, then kinematic movers driven by the step count.
  const solids = levelSolids(map);
  const addBrushes = (body: b3BodyId, brushes: BrushGeometry[], material: SurfaceMaterial | null) => {
    const shapeDef = b3.b3DefaultShapeDef();
    if (material) {
      shapeDef.baseMaterial.restitution = material.restitution;
      shapeDef.baseMaterial.friction = material.friction;
    }
    for (const brush of brushes) {
      const hull = b3.b3CreateHull(brush.vertices.flatMap((v) => v.toArray()));
      if (hull === null) throw new Error("Box3D could not create a hull for a map brush");
      b3.b3CreateHullShape(body, shapeDef, hull);
      hull.delete();
    }
  };
  const levelBody = b3.b3CreateBody(world, b3.b3DefaultBodyDef());
  for (const solid of solids.statics) addBrushes(levelBody, solid.brushes, solid.material);

  const movers = solids.movers.map((mover) => {
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type = b3.b3BodyType.b3_kinematicBody;
    const start = mover.motion.kind === "path"
      ? mover.pivot.clone().addScaledVector(mover.motion.offset, pathProgress(mover.motion, 0))
      : mover.pivot;
    bodyDef.position = start.toArray();
    if (mover.motion.kind === "rotate") bodyDef.angularVelocity = mover.motion.angularVelocity.toArray();
    const body = b3.b3CreateBody(world, bodyDef);
    addBrushes(body, mover.brushes, null);
    return body;
  });
  let stepCount = 0;

  /** Drive path movers so they reach where they should be at the end of the next step. */
  const driveMovers = () => {
    const identity: [number, number, number, number] = [0, 0, 0, 1];
    solids.movers.forEach(({ motion, pivot }, i) => {
      if (motion.kind !== "path") return;
      const now = pathProgress(motion, stepCount * TIME_STEP);
      const next = pathProgress(motion, (stepCount + 1) * TIME_STEP);
      const at = (progress: number) => pivot.clone().addScaledVector(motion.offset, progress).toArray();
      // A loop that wraps round jumps back to the start instead of sweeping
      // back along the path: teleport to one step's travel before `next`.
      if (motion.loop && next < now) b3.b3Body_SetTransform(movers[i], at(next - (next + 1 - now)), identity);
      b3.b3Body_SetTargetTransform(movers[i], { position: at(next), quaternion: identity }, TIME_STEP, true);
    });
  };

  const refs = new Map<string, BodyRef>();
  let ragdoll: b3BodyId[] = [];

  for (const entity of map.entities) {
    if (entity.properties.classname !== "info_player_start") continue;
    const position = getEntityWorldOrigin(entity);
    if (!position) throw new Error("Player Start has no position");
    const yaw = getEntityWorldYaw(entity);
    ragdoll = createHuman(
      b3,
      world,
      [position.x, position.y, position.z],
      [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      RAGDOLL_GROUP,
      RAGDOLL_JOINT_FRICTION,
    ).bodies;
  }
  ragdoll.forEach((body, bone) => {
    refs.set(bodyKey(body), { kind: "ragdoll", bone });
    const shapes = b3.b3Body_GetShapes(body);
    for (const shape of shapes) b3.b3Shape_EnableHitEvents(shape, true);
    shapes.delete();
  });

  const props = new Map<number, b3BodyId>();
  for (const placement of placements) {
    if (placement.kind !== "box") continue;
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type = b3.b3BodyType.b3_dynamicBody;
    bodyDef.position = placement.position;
    const body = b3.b3CreateBody(world, bodyDef);
    const shapeDef = b3.b3DefaultShapeDef();
    shapeDef.density = PROP_DENSITY;
    b3.b3CreateBoxShape(body, shapeDef, ...BOX_HALF_EXTENTS);
    props.set(placement.id, body);
    refs.set(bodyKey(body), { kind: "prop", id: placement.id });
  }

  // Barrels from the map, standing on their origins.
  const barrels: b3BodyId[] = [];
  const barrelHull = (() => {
    const points: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (2 * Math.PI * i) / 10;
      for (const y of [-BARREL_HEIGHT / 2, BARREL_HEIGHT / 2]) {
        points.push(BARREL_RADIUS * Math.cos(a), y, BARREL_RADIUS * Math.sin(a));
      }
    }
    return points;
  })();
  for (const entity of map.entities) {
    if (entity.properties.classname !== "prop_barrel") continue;
    const origin = getEntityWorldOrigin(entity);
    if (!origin) continue;
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type = b3.b3BodyType.b3_dynamicBody;
    bodyDef.position = [origin.x, origin.y + BARREL_HEIGHT / 2, origin.z];
    const body = b3.b3CreateBody(world, bodyDef);
    const shapeDef = b3.b3DefaultShapeDef();
    shapeDef.density = BARREL_DENSITY;
    shapeDef.enableHitEvents = true;
    const hull = b3.b3CreateHull(barrelHull);
    if (hull === null) throw new Error("Box3D could not create a barrel hull");
    b3.b3CreateHullShape(body, shapeDef, hull);
    hull.delete();
    refs.set(bodyKey(body), { kind: "barrel", index: barrels.length });
    barrels.push(body);
  }

  const resolve = (ref: BodyRef): b3BodyId => {
    const body = ref.kind === "ragdoll" ? ragdoll[ref.bone] : ref.kind === "prop" ? props.get(ref.id) : barrels[ref.index];
    if (!body) throw new Error(`No body for ${JSON.stringify(ref)}`);
    return body;
  };

  const applyForces = () => {
    const point: b3Vec3 = [0, 0, 0];
    for (const placement of placements) {
      if (placement.kind !== "force") continue;
      const body = resolve(placement.target);
      b3.b3Body_GetWorldPoint(point, body, placement.localPoint);
      const scale = b3.b3Body_GetMass(body) * VELOCITY_PER_METER;
      const [x, y, z] = placement.vector;
      b3.b3Body_ApplyLinearImpulse(body, [x * scale, y * scale, z * scale], point, true);
    }
  };

  const boxCorners: number[] = [];
  const [hx, hy, hz] = BOX_HALF_EXTENTS.map((h) => h - BOX_OVERLAP_TOLERANCE);
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) boxCorners.push(x, y, z);
  const queryFilter = b3.b3DefaultQueryFilter();

  const boxOverlaps = (position: b3Vec3, ignoreProp?: number) => {
    let overlaps = false;
    b3.b3World_OverlapShape(world, position, boxCorners, 0, queryFilter, (shapeId: b3ShapeId) => {
      const ref = refs.get(bodyKey(b3.b3Shape_GetBody(shapeId)));
      if (ref?.kind === "prop" && ref.id === ignoreProp) return true;
      overlaps = true;
      return false;
    });
    return overlaps;
  };

  let events: ReturnType<Box3DModule["createEventsBuffer"]> | null = null;
  const hitEvent = b3.createContactHitEvent();
  let lastHits: RagdollHit[] = [];
  let lastExplosions: Explosion[] = [];

  // Explosives: which have gone off, and which are due to (at a later step).
  const mines = placements.filter((p): p is MinePlacement => p.kind === "mine");
  const detonatedMines = new Set<number>();
  const detonatedBarrels = new Set<number>();
  const pending: { source: ExplosiveRef; step: number }[] = [];
  const keyOf = (source: ExplosiveRef) => (source.kind === "mine" ? `m${source.id}` : `b${source.index}`);
  const isDetonated = (source: ExplosiveRef) =>
    source.kind === "mine" ? detonatedMines.has(source.id) : detonatedBarrels.has(source.index);
  const schedule = (source: ExplosiveRef, step: number) => {
    if (isDetonated(source) || pending.some((p) => keyOf(p.source) === keyOf(source))) return;
    pending.push({ source, step });
  };

  const explosivePosition = (source: ExplosiveRef): b3Vec3 =>
    source.kind === "mine"
      ? mines.find((m) => m.id === source.id)!.position
      : b3.b3Body_GetWorldCenterOfMass([0, 0, 0], barrels[source.index]);

  /** Everything a blast can move: ragdoll parts, boxes, and barrels still in one piece. */
  const movingBodies = (): [b3BodyId, BodyRef][] => [
    ...ragdoll.map((body, bone): [b3BodyId, BodyRef] => [body, { kind: "ragdoll", bone }]),
    ...[...props].map(([id, body]): [b3BodyId, BodyRef] => [body, { kind: "prop", id }]),
    ...barrels.flatMap((body, index): [b3BodyId, BodyRef][] =>
      detonatedBarrels.has(index) ? [] : [[body, { kind: "barrel", index }]],
    ),
  ];

  const detonate = (source: ExplosiveRef) => {
    const center = explosivePosition(source);
    const { radius, speed } = source.kind === "mine" ? MINE_BLAST : BARREL_BLAST;
    if (source.kind === "mine") detonatedMines.add(source.id);
    else {
      detonatedBarrels.add(source.index);
      b3.b3DestroyBody(barrels[source.index]);
    }
    lastExplosions.push({ source, position: [...center], radius });

    const com: b3Vec3 = [0, 0, 0];
    for (const [body, ref] of movingBodies()) {
      b3.b3Body_GetWorldCenterOfMass(com, body);
      const dx = com[0] - center[0], dy = com[1] - center[1], dz = com[2] - center[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= radius) continue;
      const kick = speed * (1 - distance / radius);
      let [ux, uy, uz] = distance > 1e-6 ? [dx / distance, dy / distance, dz / distance] : [0, 1, 0];
      uy += BLAST_LIFT;
      const length = Math.hypot(ux, uy, uz);
      const scale = (b3.b3Body_GetMass(body) * kick) / length;
      b3.b3Body_ApplyLinearImpulseToCenter(body, [ux * scale, uy * scale, uz * scale], true);
      const hitSpeed = kick * BLAST_HIT_FRACTION;
      if (ref.kind === "ragdoll" && hitSpeed > HIT_SPEED_THRESHOLD) lastHits.push({ bone: ref.bone, speed: hitSpeed, point: [...com] });
    }
    // Set off other explosives within the blast, after a short delay.
    for (const mine of mines) {
      const [x, y, z] = mine.position;
      if (Math.hypot(x - center[0], y - center[1], z - center[2]) < radius) {
        schedule({ kind: "mine", id: mine.id }, stepCount + CHAIN_DELAY_STEPS);
      }
    }
    barrels.forEach((body, index) => {
      if (detonatedBarrels.has(index)) return;
      b3.b3Body_GetWorldCenterOfMass(com, body);
      if (Math.hypot(com[0] - center[0], com[1] - center[1], com[2] - center[2]) < radius) {
        schedule({ kind: "barrel", index }, stepCount + CHAIN_DELAY_STEPS);
      }
    });
  };

  /** True if any moving body is within `radius` of `position`. */
  const touched = (position: b3Vec3, radius: number) => {
    let found = false;
    b3.b3World_OverlapShape(world, position, [0, 0, 0], radius, queryFilter, (shapeId: b3ShapeId) => {
      if (!refs.has(bodyKey(b3.b3Shape_GetBody(shapeId)))) return true;
      found = true;
      return false;
    });
    return found;
  };

  /** After each physics step: record hits, and set off explosives. */
  const afterStep = () => {
    lastHits = [];
    lastExplosions = [];
    events ??= b3.createEventsBuffer();
    b3.getEvents(events, world);
    for (let i = 0; i < b3.getNumContactHitEvents(events); i++) {
      b3.getContactHitEventAt(hitEvent, events, i);
      const a = refs.get(bodyKey(b3.b3Shape_GetBody(hitEvent.shapeIdA)));
      const b = refs.get(bodyKey(b3.b3Shape_GetBody(hitEvent.shapeIdB)));
      // A barrel hit hard enough goes off.
      for (const ref of [a, b]) {
        if (ref?.kind === "barrel" && hitEvent.approachSpeed > BARREL_IMPACT_SPEED) schedule(ref, stepCount);
      }
      const bone = a?.kind === "ragdoll" ? a : b?.kind === "ragdoll" ? b : null;
      const other = bone === a ? b : a;
      if (!bone || other?.kind === "ragdoll") continue;
      lastHits.push({ bone: bone.bone, speed: hitEvent.approachSpeed, point: [...hitEvent.point] });
    }
    if (mines.length === 0 && barrels.length === 0) return;

    for (const mine of mines) {
      if (!detonatedMines.has(mine.id) && touched(mine.position, MINE_TRIGGER_RADIUS)) {
        schedule({ kind: "mine", id: mine.id }, stepCount);
      }
    }
    // Go off in the order they were set off; blasts can schedule more.
    for (let i = 0; i < pending.length; ) {
      if (pending[i].step > stepCount) {
        i++;
        continue;
      }
      const [{ source }] = pending.splice(i, 1);
      if (!isDetonated(source)) detonate(source);
    }
  };

  /** Mines must sit on the level's surface: not floating, and not buried in it. */
  const mineProblem = (position: b3Vec3, normal: b3Vec3, ignoreMine?: number): string | null => {
    const length = Math.hypot(...normal);
    if (Math.abs(length - 1) > 1e-3) return "a mine's normal must be a unit vector";
    const along = (d: number): b3Vec3 => [position[0] + normal[0] * d, position[1] + normal[1] * d, position[2] + normal[2] * d];
    const onLevel = (point: b3Vec3, radius: number) => {
      let found = false;
      b3.b3World_OverlapShape(world, point, [0, 0, 0], radius, queryFilter, (shapeId: b3ShapeId) => {
        if (bodyKey(b3.b3Shape_GetBody(shapeId)) !== bodyKey(levelBody)) return true;
        found = true;
        return false;
      });
      return found;
    };
    if (!onLevel(position, MINE_SURFACE_OFFSET + 0.02)) return "a mine must be placed on a surface";
    if (onLevel(along(0.12), 0.05)) return "a mine can't be buried in the level";
    for (const other of mines) {
      if (other.id === ignoreMine) continue;
      const [x, y, z] = other.position;
      if (Math.hypot(x - position[0], y - position[1], z - position[2]) < 2 * MINE_TRIGGER_RADIUS) {
        return "mines can't be placed on top of each other";
      }
    }
    return null;
  };

  return {
    world,
    ragdoll,
    movers,
    props,
    barrels,
    detonated: isDetonated,
    explosions: () => lastExplosions,
    mineProblem,
    resolve,
    refForBody: (body) => refs.get(bodyKey(body)) ?? null,
    applyForces,
    boxOverlaps,
    step: () => {
      driveMovers();
      b3.b3World_Step(world, TIME_STEP, SUB_STEPS);
      stepCount++;
      afterStep();
    },
    ragdollHits: () => lastHits,
    destroy: () => {
      if (events) b3.destroyEventsBuffer(events);
      b3.b3DestroyWorld(world);
    },
  };
}
