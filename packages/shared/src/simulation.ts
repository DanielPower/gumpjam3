import type { Box3DModule, b3BodyId, b3ShapeId, b3Vec3, b3WorldId } from "box3d.js";
import { createHuman } from "./ragdoll";
import {
  createMapCollisionObjects,
  getEntityWorldOrigin,
  getEntityWorldYaw,
  type TrenchBroomMap,
} from "./trenchbroom-map";

/** Change in velocity (m/s) applied per metre of force-vector arrow. */
export const VELOCITY_PER_METER = 6;
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

/** Identifies a dynamic body in a way that survives rebuilding the world. */
export type BodyRef =
  | { kind: "ragdoll"; bone: number }
  | { kind: "prop"; id: number };

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

export type Placement = ForcePlacement | BoxPlacement;
export type PlacementKind = Placement["kind"];
export type Inventory = Record<PlacementKind, number>;

/** A ragdoll bone striking the level or a prop. */
export type RagdollHit = { bone: number; speed: number; point: b3Vec3 };

export type Simulation = {
  world: b3WorldId;
  /** Ragdoll bodies, indexed by bone. */
  ragdoll: b3BodyId[];
  /** Prop bodies keyed by their placement's id. */
  props: Map<number, b3BodyId>;
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
   * Hits on the ragdoll during the last step. Hits between the ragdoll's own
   * bones are skipped so flailing limbs don't count as impacts.
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
  createMapCollisionObjects(b3, world, map);

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

  const resolve = (ref: BodyRef): b3BodyId => {
    const body = ref.kind === "ragdoll" ? ragdoll[ref.bone] : props.get(ref.id);
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

  const ragdollHits = (): RagdollHit[] => {
    events ??= b3.createEventsBuffer();
    b3.getEvents(events, world);
    const hits: RagdollHit[] = [];
    for (let i = 0; i < b3.getNumContactHitEvents(events); i++) {
      b3.getContactHitEventAt(hitEvent, events, i);
      const a = refs.get(bodyKey(b3.b3Shape_GetBody(hitEvent.shapeIdA)));
      const b = refs.get(bodyKey(b3.b3Shape_GetBody(hitEvent.shapeIdB)));
      const bone = a?.kind === "ragdoll" ? a : b?.kind === "ragdoll" ? b : null;
      const other = bone === a ? b : a;
      if (!bone || other?.kind === "ragdoll") continue;
      hits.push({ bone: bone.bone, speed: hitEvent.approachSpeed, point: [...hitEvent.point] });
    }
    return hits;
  };

  return {
    world,
    ragdoll,
    props,
    resolve,
    refForBody: (body) => refs.get(bodyKey(body)) ?? null,
    applyForces,
    boxOverlaps,
    step: () => b3.b3World_Step(world, TIME_STEP, SUB_STEPS),
    ragdollHits,
    destroy: () => {
      if (events) b3.destroyEventsBuffer(events);
      b3.b3DestroyWorld(world);
    },
  };
}
