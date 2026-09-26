import type { Box3DModule, b3BodyId, b3Quat, b3ShapeId, b3Vec3, b3WorldId } from "box3d.js";
import * as THREE from "three";
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
/** Cheese bait sits just above the floor it is placed on. */
export const BAIT_SURFACE_OFFSET = 0.08;
/** A baited rat launches once the ragdoll enters this radius around its bait. */
export const RAT_BAIT_TRIGGER_RADIUS = 5;
/** Force arrows are limited to this length (metres), i.e. a maximum strength. */
export const MAX_ARROW_LENGTH = 1.5;
export const MIN_ARROW_LENGTH = 0.05;
/** Boxes may touch other things, but not overlap them by more than this. */
const BOX_OVERLAP_TOLERANCE = 0.01;
/** Solid wood (kg/m³): a box weighs 75 kg, enough to hold its own against the ragdoll. */
const PROP_DENSITY = 600;
const RAGDOLL_GROUP = 1;
const RAGDOLL_JOINT_FRICTION = 0.05;
/** Contacts approaching slower than this (m/s) aren't reported as hits. */
export const HIT_SPEED_THRESHOLD = 1.5;

/*
 * Explosives: mines the player places, and barrels placed in the map
 * ("prop_barrel", origin at the centre of its base).
 * - A mine is a loose physics object, like a box, that can be pushed and
 *   thrown. It arms when the ragdoll comes close, then goes off when its fuse
 *   runs out. Bumps and blasts don't set it off.
 * - A barrel goes off when it's hit hard, or a moment after being caught in
 *   another blast, so they chain.
 * A blast kicks every moving body within its radius outwards (and a little
 * upwards), hardest at the centre; each ragdoll part it catches takes a hit as
 * if it struck something at that speed.
 */
/** A mine arms when any part of the ragdoll comes within this distance (metres) of its centre. */
export const MINE_ARM_RADIUS = 0.6;
/** How long an armed mine takes to go off. */
export const MINE_FUSE_SECONDS = 1;
export const MINE_RADIUS = 0.22;
export const MINE_THICKNESS = 0.07;
/** Steel-ish (kg/m³): a mine weighs about 16 kg. */
const MINE_DENSITY = 1500;
/** Ropes can be this long at most, and no shorter than the minimum (metres). */
export const MAX_ROPE_LENGTH = 6;
export const MIN_ROPE_LENGTH = 0.2;
/**
 * A rope is a chain of capsules, each at most this long (metres), linked end to
 * end by ball joints, so it swings, drapes, and wraps around what it hits.
 */
const ROPE_SEGMENT_LENGTH = 0.2;
export const ROPE_RADIUS = 0.035;
/** About 5 kg per metre: heavy enough to hold together between heavy boxes. */
const ROPE_DENSITY = 1300;
/** Each rope's capsules share a collision group (the negative of this plus its index), so they don't collide with each other. */
const ROPE_GROUP_BASE = 100;

/*
 * Cars (func_car) are physics bodies driven by a steady push towards their
 * cruising speed, like a driver holding the throttle. They slide on the road
 * with little friction, as if rolling. Each drives its road once: once it hits
 * anything that isn't the static level, or reaches the end of the road, the
 * driver lifts off and it just coasts from then on.
 */
/** The most a car's engine accelerates it (m/s²). */
const CAR_MAX_ACCELERATION = 6;
/** How hard the throttle responds to being under cruising speed (per second). */
const CAR_THROTTLE_GAIN = 10;
const CAR_SURFACE: SurfaceMaterial = { friction: 0.2, restitution: 0.1 };

/** A thruster's push (newtons): enough to lift the whole ragdoll, and send a box flying. */
export const THRUSTER_FORCE = 1500;
/** How long a thruster burns before it runs out of fuel. */
export const THRUSTER_SECONDS = 6;

/** Mines may touch other things, but not overlap them by more than this (metres). */
const MINE_OVERLAP_TOLERANCE = 0.01;
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
/**
 * A mine's centre sits this far off the surface it's placed on: just over half
 * its thickness, so it starts resting on the surface, not in it.
 */
export const MINE_SURFACE_OFFSET = 0.04;

/** Identifies a dynamic body in a way that survives rebuilding the world. */
export type BodyRef =
  | { kind: "ragdoll"; bone: number }
  | { kind: "prop"; id: number }
  | { kind: "barrel"; index: number }
  | { kind: "mine"; id: number };

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
  /** Where the mine's centre starts, just off the surface. */
  position: b3Vec3;
  /** The surface's normal: the mine starts lying flat against the surface. */
  normal: b3Vec3;
};

export type BaitPlacement = {
  kind: "bait";
  id: number;
  /** Centre of the cheese, just above the sewer floor. */
  position: b3Vec3;
};

/** Where a rope is tied: to a body, or to the level itself. */
export type RopeTarget = BodyRef | { kind: "level" };

export type RopeEnd = {
  target: RopeTarget;
  /** The point it's tied at, in the target body's local frame (the level's frame is the world). */
  localPoint: b3Vec3;
};

/**
 * A rope tying two things together. It's as long as its ends are apart when
 * the run starts, and can go slack but not stretch.
 */
export type RopePlacement = { kind: "rope"; a: RopeEnd; b: RopeEnd };

/**
 * A thruster stuck to a body's surface, pushing into it for its first
 * THRUSTER_SECONDS, turning with the body as it goes.
 */
export type ThrusterPlacement = {
  kind: "thruster";
  target: BodyRef;
  /** Where it's stuck on, in the body's local frame. */
  localPoint: b3Vec3;
  /** The surface's outward normal there, in the body's local frame. It pushes the opposite way. */
  localNormal: b3Vec3;
};

export type Placement = ForcePlacement | BoxPlacement | MinePlacement | BaitPlacement | RopePlacement | ThrusterPlacement;
export type PlacementKind = Placement["kind"];
export type Inventory = Record<PlacementKind, number>;

/** A ragdoll bone striking the level or a prop, or caught in a blast. */
export type RagdollHit = { bone: number; speed: number; point: b3Vec3 };

export type ExplosiveRef = { kind: "mine"; id: number } | { kind: "barrel"; index: number };

export type Explosion = { source: ExplosiveRef; position: b3Vec3; radius: number };

/** The deterministic charge assigned to a rat by one piece of bait. */
export type RatRoute = {
  moverIndex: number;
  baitId: number;
  start: b3Vec3;
  bait: b3Vec3;
  end: b3Vec3;
};

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
  /** Each rope's chain of capsules, in placement order, and each capsule's half-length. */
  ropes: { segments: b3BodyId[]; halfLength: number }[];
  /** Mine bodies keyed by their placement's id. Destroyed when they go off. */
  mines: Map<number, b3BodyId>;
  /** Seconds left on an armed mine's fuse, or null if it isn't armed (or has gone off). */
  mineFuse(id: number): number | null;
  /** Explosives that have gone off so far. */
  detonated(source: ExplosiveRef): boolean;
  /** Explosions during the last step. */
  explosions(): Explosion[];
  /** Rat charges created by the current bait placements. */
  ratRoutes(): readonly RatRoute[];
  /** Whether a rat has reached and eaten this bait. */
  baitConsumed(id: number): boolean;
  /** Whether thruster `index` (counting thrusters in placement order) is burning. */
  thrusterBurning(index: number): boolean;
  /** Whether `body` is the level's static geometry (not a moving part). */
  isLevel(body: b3BodyId): boolean;
  /** Where a rope end is in the world right now. */
  ropeEndPoint(end: RopeEnd): b3Vec3;
  /** Why a rope can't tie these ends together, or null if it can. */
  ropeProblem(a: RopeEnd, b: RopeEnd): string | null;
  /** Why a mine can't go at `position` (on a surface with this normal), or null if it can. */
  mineProblem(position: b3Vec3, normal: b3Vec3, ignoreMine?: number): string | null;
  /** Why bait cannot be placed at `position`, or null if a rat can reach it. */
  baitProblem(position: b3Vec3, ignoreBait?: number): string | null;
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
  const baits = placements.filter((placement): placement is BaitPlacement => placement.kind === "bait");

  type InternalRatRoute = RatRoute & {
    rotation: [number, number, number, number];
    baitDistance: number;
    travelDistance: number;
    triggerStep: number | null;
    consumed: boolean;
    completed: boolean;
  };
  const ratRoutes: InternalRatRoute[] = [];
  const pairs = solids.movers.flatMap((mover, moverIndex) =>
    mover.motion.kind !== "rat" ? [] : baits.map((bait) => ({
      moverIndex,
      bait,
      distance: Math.hypot(bait.position[0] - mover.pivot.x, bait.position[2] - mover.pivot.z),
    })),
  ).sort((a, b) => a.distance - b.distance || a.moverIndex - b.moverIndex || a.bait.id - b.bait.id);
  const assignedRats = new Set<number>();
  const assignedBaits = new Set<number>();
  for (const { moverIndex, bait, distance } of pairs) {
    if (assignedRats.has(moverIndex) || assignedBaits.has(bait.id) || distance < 1e-6) continue;
    assignedRats.add(moverIndex);
    assignedBaits.add(bait.id);
    const mover = solids.movers[moverIndex];
    const motion = mover.motion;
    if (motion.kind !== "rat") continue;
    const direction = new THREE.Vector3(
      bait.position[0] - mover.pivot.x,
      0,
      bait.position[2] - mover.pivot.z,
    ).normalize();
    const travelDistance = distance + 2.5;
    const end = mover.pivot.clone().addScaledVector(direction, travelDistance);
    const authoredYaw = Math.atan2(motion.forward.x, motion.forward.z);
    const routeYaw = Math.atan2(direction.x, direction.z);
    const yaw = routeYaw - authoredYaw;
    ratRoutes.push({
      moverIndex,
      baitId: bait.id,
      start: mover.pivot.toArray(),
      bait: bait.position,
      end: end.toArray(),
      baitDistance: distance,
      travelDistance,
      triggerStep: null,
      consumed: false,
      completed: false,
      rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    });
  }
  const routeForMover = (index: number) => ratRoutes.find((route) => route.moverIndex === index);
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

  /** Cars, by their index in `movers`: which way they drive, and whether the driver still is. */
  const cars = new Map<number, { direction: THREE.Vector3; start: THREE.Vector3; length: number; speed: number; driving: boolean }>();
  const carKeys = new Map<string, number>();

  const movers = solids.movers.map((mover, index) => {
    const bodyDef = b3.b3DefaultBodyDef();
    if (mover.motion.kind === "car") {
      const { offset, speed, phase, mass } = mover.motion;
      const direction = offset.clone().normalize();
      bodyDef.type = b3.b3BodyType.b3_dynamicBody;
      bodyDef.position = mover.pivot.clone().addScaledVector(offset, phase).toArray();
      bodyDef.linearVelocity = direction.clone().multiplyScalar(speed).toArray();
      const body = b3.b3CreateBody(world, bodyDef);
      addBrushes(body, mover.brushes, CAR_SURFACE);
      // Scale the (default) density so the car weighs `mass`, whatever its shape.
      const shapes = b3.b3Body_GetShapes(body);
      const density = (b3.b3DefaultShapeDef().density * mass) / Math.max(b3.b3Body_GetMass(body), 1e-6);
      for (const shape of shapes) {
        b3.b3Shape_SetDensity(shape, density, false);
        b3.b3Shape_EnableHitEvents(shape, true);
      }
      shapes.delete();
      b3.b3Body_ApplyMassFromShapes(body);
      cars.set(index, { direction, start: mover.pivot.clone(), length: offset.length(), speed, driving: true });
      carKeys.set(bodyKey(body), index);
      return body;
    }
    bodyDef.type = b3.b3BodyType.b3_kinematicBody;
    const start = mover.motion.kind === "path"
      ? mover.pivot.clone().addScaledVector(mover.motion.offset, pathProgress(mover.motion, 0))
      : mover.pivot;
    bodyDef.position = start.toArray();
    if (mover.motion.kind === "rotate") bodyDef.angularVelocity = mover.motion.angularVelocity.toArray();
    const ratRoute = routeForMover(index);
    if (ratRoute) bodyDef.rotation = ratRoute.rotation;
    const body = b3.b3CreateBody(world, bodyDef);
    addBrushes(body, mover.brushes, null);
    return body;
  });
  let stepCount = 0;

  /** Drive path movers and baited rats to the end of the next step. */
  const driveMovers = () => {
    const identity: [number, number, number, number] = [0, 0, 0, 1];
    solids.movers.forEach(({ motion, pivot }, i) => {
      const car = cars.get(i);
      if (car) {
        if (!car.driving) return;
        const body = movers[i];
        const position = new THREE.Vector3(...b3.b3Body_GetPosition([0, 0, 0], body));
        if (position.clone().sub(car.start).dot(car.direction) >= car.length) {
          car.driving = false;
          return;
        }
        const velocity = new THREE.Vector3(...b3.b3Body_GetLinearVelocity([0, 0, 0], body));
        // Enough to overcome the road's friction, plus more the further it's under speed.
        const cruise = CAR_SURFACE.friction * 9.8;
        const acceleration = THREE.MathUtils.clamp(cruise + CAR_THROTTLE_GAIN * (car.speed - velocity.dot(car.direction)), 0, CAR_MAX_ACCELERATION);
        const force = car.direction.clone().multiplyScalar(b3.b3Body_GetMass(body) * acceleration);
        b3.b3Body_ApplyForceToCenter(body, force.toArray(), true);
        return;
      }
      if (motion.kind === "path") {
        const now = pathProgress(motion, stepCount * TIME_STEP);
        const next = pathProgress(motion, (stepCount + 1) * TIME_STEP);
        const at = (progress: number) => pivot.clone().addScaledVector(motion.offset, progress).toArray();
        // A loop that wraps round jumps back to the start instead of sweeping
        // back along the path: teleport to one step's travel before `next`.
        if (motion.loop && next < now) b3.b3Body_SetTransform(movers[i], at(next - (next + 1 - now)), identity);
        b3.b3Body_SetTargetTransform(movers[i], { position: at(next), quaternion: identity }, TIME_STEP, true);
        return;
      }
      if (motion.kind !== "rat") return;
      const route = routeForMover(i);
      if (!route || route.completed) return;
      const t = (stepCount + 1) * TIME_STEP;
      if (route.triggerStep === null) {
        const nearBait = ragdoll.some((body) => {
          const position = b3.b3Body_GetPosition([0, 0, 0], body);
          return Math.hypot(
            position[0] - route.bait[0],
            position[1] - route.bait[1],
            position[2] - route.bait[2],
          ) <= RAT_BAIT_TRIGGER_RADIUS;
        });
        if (t < motion.delay || !nearBait) return;
        route.triggerStep = stepCount;
      }
      const elapsed = (stepCount + 1 - route.triggerStep) * TIME_STEP;
      route.consumed ||= elapsed >= route.baitDistance / motion.speed;
      const progress = (elapsed * motion.speed) / route.travelDistance;
      if (progress >= 1) {
        // The rat has entered the opposite tunnel. Teleport it home instead of
        // sweeping it backwards through the arena for a second, surprise hit.
        b3.b3Body_SetTransform(movers[i], pivot.toArray(), route.rotation);
        b3.b3Body_SetLinearVelocity(movers[i], [0, 0, 0]);
        b3.b3Body_SetAngularVelocity(movers[i], [0, 0, 0]);
        route.completed = true;
        return;
      }
      const position = pivot.clone().lerp(new THREE.Vector3(...route.end), THREE.MathUtils.clamp(progress, 0, 1));
      b3.b3Body_SetTargetTransform(movers[i], { position: position.toArray(), quaternion: route.rotation }, TIME_STEP, true);
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

  // Mines, lying flat on the surfaces they were placed on.
  const mines = new Map<number, b3BodyId>();
  const mineHull = (() => {
    const points: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (2 * Math.PI * i) / 12;
      for (const y of [-MINE_THICKNESS / 2, MINE_THICKNESS / 2]) points.push(MINE_RADIUS * Math.cos(a), y, MINE_RADIUS * Math.sin(a));
    }
    return points;
  })();
  for (const placement of placements) {
    if (placement.kind !== "mine") continue;
    const bodyDef = b3.b3DefaultBodyDef();
    bodyDef.type = b3.b3BodyType.b3_dynamicBody;
    bodyDef.position = placement.position;
    const up = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...placement.normal).normalize());
    bodyDef.rotation = [up.x, up.y, up.z, up.w];
    const body = b3.b3CreateBody(world, bodyDef);
    const shapeDef = b3.b3DefaultShapeDef();
    shapeDef.density = MINE_DENSITY;
    const hull = b3.b3CreateHull(mineHull);
    if (hull === null) throw new Error("Box3D could not create a mine hull");
    b3.b3CreateHullShape(body, shapeDef, hull);
    hull.delete();
    mines.set(placement.id, body);
    refs.set(bodyKey(body), { kind: "mine", id: placement.id });
  }

  const resolve = (ref: BodyRef): b3BodyId => {
    const body =
      ref.kind === "ragdoll" ? ragdoll[ref.bone]
      : ref.kind === "prop" ? props.get(ref.id)
      : ref.kind === "mine" ? mines.get(ref.id)
      : barrels[ref.index];
    if (!body) throw new Error(`No body for ${JSON.stringify(ref)}`);
    return body;
  };

  const ropeBody = (target: RopeTarget) => (target.kind === "level" ? levelBody : resolve(target));
  const ropeEndPoint = (end: RopeEnd): b3Vec3 => b3.b3Body_GetWorldPoint([0, 0, 0], ropeBody(end.target), end.localPoint);

  // Ropes: a chain of capsules from one end to the other, starting straight.
  const ropes: { segments: b3BodyId[]; halfLength: number }[] = [];
  const ropeSegmentKeys = new Set<string>();
  const identity: b3Quat = [0, 0, 0, 1];
  const ballJoint = (bodyA: b3BodyId, pointA: b3Vec3, bodyB: b3BodyId, pointB: b3Vec3) => {
    const def = b3.b3DefaultSphericalJointDef();
    def.base.bodyIdA = bodyA;
    def.base.bodyIdB = bodyB;
    def.base.localFrameA = { position: pointA, quaternion: identity };
    def.base.localFrameB = { position: pointB, quaternion: identity };
    b3.b3CreateSphericalJoint(world, def);
  };
  placements.filter((p): p is RopePlacement => p.kind === "rope").forEach((placement, ropeIndex) => {
    const [a, b] = [ropeEndPoint(placement.a), ropeEndPoint(placement.b)];
    const start = new THREE.Vector3(...a);
    const span = new THREE.Vector3(...b).sub(start);
    const length = Math.max(MIN_ROPE_LENGTH, span.length());
    const count = Math.max(2, Math.ceil(length / ROPE_SEGMENT_LENGTH));
    const halfLength = length / count / 2;
    // Each capsule lies along its local Y, turned to point along the rope.
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), span.clone().normalize());
    const segments: b3BodyId[] = [];
    for (let i = 0; i < count; i++) {
      const bodyDef = b3.b3DefaultBodyDef();
      bodyDef.type = b3.b3BodyType.b3_dynamicBody;
      bodyDef.position = start.clone().addScaledVector(span, (i + 0.5) / count).toArray();
      bodyDef.rotation = [turn.x, turn.y, turn.z, turn.w];
      const body = b3.b3CreateBody(world, bodyDef);
      const shapeDef = b3.b3DefaultShapeDef();
      shapeDef.density = ROPE_DENSITY;
      shapeDef.filter.groupIndex = -(ROPE_GROUP_BASE + ropeIndex);
      b3.b3CreateCapsuleShape(body, shapeDef, { center1: [0, -halfLength, 0], center2: [0, halfLength, 0], radius: ROPE_RADIUS });
      if (i > 0) ballJoint(segments[i - 1], [0, halfLength, 0], body, [0, -halfLength, 0]);
      segments.push(body);
      ropeSegmentKeys.add(bodyKey(body));
    }
    ballJoint(ropeBody(placement.a.target), placement.a.localPoint, segments[0], [0, -halfLength, 0]);
    ballJoint(ropeBody(placement.b.target), placement.b.localPoint, segments[count - 1], [0, halfLength, 0]);
    ropes.push({ segments, halfLength });

    // And a limit on how far apart the ends can get, so heavy things on the
    // ends can't stretch the chain: free to shorten (a spring with no
    // stiffness), but not lengthen past the rope's length.
    const def = b3.b3DefaultDistanceJointDef();
    def.base.bodyIdA = ropeBody(placement.a.target);
    def.base.bodyIdB = ropeBody(placement.b.target);
    def.base.localFrameA = { position: placement.a.localPoint, quaternion: [0, 0, 0, 1] };
    def.base.localFrameB = { position: placement.b.localPoint, quaternion: [0, 0, 0, 1] };
    // The things it ties together still bump into each other.
    def.base.collideConnected = true;
    def.length = length;
    def.enableSpring = true;
    def.hertz = 0;
    def.dampingRatio = 0;
    def.enableLimit = true;
    def.minLength = 0;
    def.maxLength = length;
    b3.b3CreateDistanceJoint(world, def);
  });

  // Thrusters, each pushing into its body while it has fuel.
  const thrusters = placements.filter((p): p is ThrusterPlacement => p.kind === "thruster");
  const burnSteps = Math.round(THRUSTER_SECONDS / TIME_STEP);
  const thrusterBurning = (index: number) => {
    const thruster = thrusters[index];
    if (!thruster || stepCount >= burnSteps) return false;
    // Nothing to push once what it's stuck to has blown up.
    const { target } = thruster;
    return !(target.kind === "mine" && detonatedMines.has(target.id)) && !(target.kind === "barrel" && detonatedBarrels.has(target.index));
  };
  const fireThrusters = () => {
    const point: b3Vec3 = [0, 0, 0];
    const direction: b3Vec3 = [0, 0, 0];
    thrusters.forEach((thruster, index) => {
      if (!thrusterBurning(index)) return;
      const body = resolve(thruster.target);
      b3.b3Body_GetWorldPoint(point, body, thruster.localPoint);
      b3.b3Body_GetWorldVector(direction, body, thruster.localNormal);
      const scale = -THRUSTER_FORCE / Math.max(Math.hypot(...direction), 1e-6);
      b3.b3Body_ApplyForce(body, [direction[0] * scale, direction[1] * scale, direction[2] * scale], point, true);
    });
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
      const key = bodyKey(b3.b3Shape_GetBody(shapeId));
      const ref = refs.get(key);
      // Ropes follow whatever they're tied to, so they're never in the way.
      if ((ref?.kind === "prop" && ref.id === ignoreProp) || ropeSegmentKeys.has(key)) return true;
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
  const fuseSteps = Math.round(MINE_FUSE_SECONDS / TIME_STEP);
  /** The step each armed mine armed at. */
  const armedAt = new Map<number, number>();
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
    b3.b3Body_GetWorldCenterOfMass([0, 0, 0], source.kind === "mine" ? mines.get(source.id)! : barrels[source.index]);

  /** Everything a blast can move: ragdoll parts, boxes, and barrels and mines still in one piece. */
  const movingBodies = (): [b3BodyId, BodyRef][] => [
    ...ragdoll.map((body, bone): [b3BodyId, BodyRef] => [body, { kind: "ragdoll", bone }]),
    ...[...props].map(([id, body]): [b3BodyId, BodyRef] => [body, { kind: "prop", id }]),
    ...barrels.flatMap((body, index): [b3BodyId, BodyRef][] =>
      detonatedBarrels.has(index) ? [] : [[body, { kind: "barrel", index }]],
    ),
    ...[...mines].flatMap(([id, body]): [b3BodyId, BodyRef][] => (detonatedMines.has(id) ? [] : [[body, { kind: "mine", id }]])),
  ];

  const detonate = (source: ExplosiveRef) => {
    const center = explosivePosition(source);
    const { radius, speed } = source.kind === "mine" ? MINE_BLAST : BARREL_BLAST;
    if (source.kind === "mine") {
      detonatedMines.add(source.id);
      b3.b3DestroyBody(mines.get(source.id)!);
    } else {
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
    // Set off barrels within the blast, after a short delay. (Mines just get thrown.)
    barrels.forEach((body, index) => {
      if (detonatedBarrels.has(index)) return;
      b3.b3Body_GetWorldCenterOfMass(com, body);
      if (Math.hypot(com[0] - center[0], com[1] - center[1], com[2] - center[2]) < radius) {
        schedule({ kind: "barrel", index }, stepCount + CHAIN_DELAY_STEPS);
      }
    });
  };

  /** True if any part of the ragdoll is within `radius` of `position`. */
  const ragdollNear = (position: b3Vec3, radius: number) => {
    let found = false;
    b3.b3World_OverlapShape(world, position, [0, 0, 0], radius, queryFilter, (shapeId: b3ShapeId) => {
      if (refs.get(bodyKey(b3.b3Shape_GetBody(shapeId)))?.kind !== "ragdoll") return true;
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
      const [keyA, keyB] = [hitEvent.shapeIdA, hitEvent.shapeIdB].map((shape) => bodyKey(b3.b3Shape_GetBody(shape)));
      // A car that hits anything but the static level stops driving.
      for (const [car, other] of [[keyA, keyB], [keyB, keyA]]) {
        const index = carKeys.get(car);
        if (index !== undefined && other !== bodyKey(levelBody)) cars.get(index)!.driving = false;
      }
      const a = refs.get(keyA);
      const b = refs.get(keyB);
      // A barrel hit hard enough goes off.
      for (const ref of [a, b]) {
        if (ref?.kind === "barrel" && hitEvent.approachSpeed > BARREL_IMPACT_SPEED) schedule(ref, stepCount);
      }
      const bone = a?.kind === "ragdoll" ? a : b?.kind === "ragdoll" ? b : null;
      const other = bone === a ? b : a;
      if (!bone || other?.kind === "ragdoll") continue;
      lastHits.push({ bone: bone.bone, speed: hitEvent.approachSpeed, point: [...hitEvent.point] });
    }
    if (mines.size === 0 && barrels.length === 0) return;

    // Mines arm when the ragdoll comes close, and go off when their fuse runs out.
    const com: b3Vec3 = [0, 0, 0];
    for (const [id, body] of mines) {
      if (detonatedMines.has(id)) continue;
      const armed = armedAt.get(id);
      if (armed === undefined) {
        if (ragdollNear(b3.b3Body_GetWorldCenterOfMass(com, body), MINE_ARM_RADIUS)) armedAt.set(id, stepCount);
      } else if (stepCount - armed >= fuseSteps) {
        schedule({ kind: "mine", id }, stepCount);
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

  /**
   * Mines must rest on something (the level, or any other object), without
   * floating or overlapping anything. `ignoreMine` is the mine being checked,
   * if it's already in the world.
   */
  const mineProblem = (position: b3Vec3, normal: b3Vec3, ignoreMine?: number): string | null => {
    const length = Math.hypot(...normal);
    if (Math.abs(length - 1) > 1e-3) return "a mine's normal must be a unit vector";
    // Ropes follow whatever they're tied to, so they're never in the way.
    const isSelf = (shapeId: b3ShapeId) => {
      const key = bodyKey(b3.b3Shape_GetBody(shapeId));
      const ref = refs.get(key);
      return (ref?.kind === "mine" && ref.id === ignoreMine) || ropeSegmentKeys.has(key);
    };

    let resting = false;
    b3.b3World_OverlapShape(world, position, [0, 0, 0], MINE_SURFACE_OFFSET + 0.02, queryFilter, (shapeId: b3ShapeId) => {
      if (isSelf(shapeId)) return true;
      resting = true;
      return false;
    });
    if (!resting) return "a mine must be placed on a surface";

    // The mine's shape, turned to lie flat on the surface and shrunk a little
    // so resting on something doesn't count as overlapping it.
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...normal));
    const shape: number[] = [];
    for (let i = 0; i < mineHull.length; i += 3) {
      const corner = new THREE.Vector3(mineHull[i], mineHull[i + 1], mineHull[i + 2]);
      corner.set(corner.x * (1 - MINE_OVERLAP_TOLERANCE / MINE_RADIUS), corner.y - Math.sign(corner.y) * MINE_OVERLAP_TOLERANCE, corner.z * (1 - MINE_OVERLAP_TOLERANCE / MINE_RADIUS));
      shape.push(...corner.applyQuaternion(turn).toArray());
    }
    let problem: string | null = null;
    b3.b3World_OverlapShape(world, position, shape, 0, queryFilter, (shapeId: b3ShapeId) => {
      if (isSelf(shapeId)) return true;
      const body = b3.b3Shape_GetBody(shapeId);
      const ref = refs.get(bodyKey(body));
      problem =
        bodyKey(body) === bodyKey(levelBody) ? "a mine can't be buried in the level"
        : ref?.kind === "mine" ? "mines can't be placed on top of each other"
        : "a mine can't overlap something else";
      return false;
    });
    return problem;
  };

  const sameTarget = (a: RopeTarget, b: RopeTarget) => JSON.stringify(a) === JSON.stringify(b);

  /** Ropes tie two different things together, within reach, and to the level only at its surface. */
  const ropeProblem = (a: RopeEnd, b: RopeEnd): string | null => {
    if (sameTarget(a.target, b.target)) return "a rope must tie two different things together";
    for (const end of [a, b]) {
      if (end.target.kind !== "level") continue;
      let onLevel = false;
      b3.b3World_OverlapShape(world, end.localPoint, [0, 0, 0], 0.05, queryFilter, (shapeId: b3ShapeId) => {
        if (bodyKey(b3.b3Shape_GetBody(shapeId)) !== bodyKey(levelBody)) return true;
        onLevel = true;
        return false;
      });
      if (!onLevel) return "a rope must be tied to the level at its surface";
    }
    const [pa, pb] = [ropeEndPoint(a), ropeEndPoint(b)];
    const length = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    if (length > MAX_ROPE_LENGTH) return `a rope can be at most ${MAX_ROPE_LENGTH} m long`;
    if (length < MIN_ROPE_LENGTH) return "a rope's ends are too close together";

    // It starts straight, so it mustn't pass through anything on the way,
    // except what it's tied to (and other ropes, which just push aside).
    const tiedTo = new Set([a.target, b.target].flatMap((target) => (target.kind === "level" ? [] : [bodyKey(resolve(target))])));
    const along = new THREE.Vector3(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]).normalize();
    // Clear of the surfaces its ends are tied to.
    const clearance = ROPE_RADIUS + 0.05;
    if (length > 2 * clearance) {
      const from = new THREE.Vector3(...pa).addScaledVector(along, clearance);
      const to = new THREE.Vector3(...pb).addScaledVector(along, -clearance);
      let blocked = false;
      b3.b3World_OverlapShape(world, from.toArray(), [0, 0, 0, ...to.clone().sub(from).toArray()], ROPE_RADIUS * 0.8, queryFilter, (shapeId: b3ShapeId) => {
        const key = bodyKey(b3.b3Shape_GetBody(shapeId));
        if (tiedTo.has(key) || ropeSegmentKeys.has(key)) return true;
        blocked = true;
        return false;
      });
      if (blocked) return "a rope can't pass through things";
    }
    return null;
  };

  /** Bait must sit on the rats' floor, where their horizontal charge can reach it. */
  const baitProblem = (position: b3Vec3, ignoreBait?: number): string | null => {
    const ratFloors = solids.movers.flatMap((mover) => mover.motion.kind === "rat" ? [mover.pivot.y] : []);
    if (ratFloors.length === 0) return "this level has no rats to bait";
    if (ratFloors.every((floor) => Math.abs(position[1] - (floor + BAIT_SURFACE_OFFSET)) > 0.12)) {
      return "bait must be placed on the sewer floor";
    }
    let onLevel = false;
    b3.b3World_OverlapShape(world, position, [0, 0, 0], BAIT_SURFACE_OFFSET + 0.02, queryFilter, (shapeId: b3ShapeId) => {
      if (bodyKey(b3.b3Shape_GetBody(shapeId)) !== bodyKey(levelBody)) return true;
      onLevel = true;
      return false;
    });
    if (!onLevel) return "bait must be placed on the sewer floor";
    for (const other of baits) {
      if (other.id === ignoreBait) continue;
      if (Math.hypot(other.position[0] - position[0], other.position[2] - position[2]) < 0.55) {
        return "bait pieces cannot overlap";
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
    ropes,
    mines,
    mineFuse: (id) => {
      const armed = armedAt.get(id);
      if (armed === undefined || detonatedMines.has(id)) return null;
      return Math.max(0, (fuseSteps - (stepCount - armed)) * TIME_STEP);
    },
    detonated: isDetonated,
    explosions: () => lastExplosions,
    ratRoutes: () => ratRoutes,
    baitConsumed: (id) => ratRoutes.some((route) => route.baitId === id && route.consumed),
    mineProblem,
    baitProblem,
    isLevel: (body) => bodyKey(body) === bodyKey(levelBody),
    thrusterBurning,
    ropeEndPoint,
    ropeProblem,
    resolve,
    refForBody: (body) => refs.get(bodyKey(body)) ?? null,
    applyForces,
    boxOverlaps,
    step: () => {
      driveMovers();
      fireThrusters();
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
