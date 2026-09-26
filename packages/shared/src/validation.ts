import type { Box3DModule, b3Vec3 } from "box3d.js";
import * as THREE from "three";
import { BODY_PARTS } from "./damage";
import type { Level } from "./level";
import {
  createSimulation,
  MAX_ARROW_LENGTH,
  MIN_ARROW_LENGTH,
  type BodyRef,
  type Placement,
} from "./simulation";

/** Forces must attach within this distance (metres) of their body's origin. */
const MAX_ATTACH_DISTANCE = 0.6;
/** Boxes can be placed a little above the tallest part of the level. */
const MAX_HEIGHT_ABOVE_LEVEL = 5;
/** Allow for floating-point error in lengths computed on the client. */
const LENGTH_EPSILON = 1e-6;

export class PlacementError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function vec3(value: unknown, what: string): b3Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new PlacementError(`${what} must be an array of three finite numbers`);
  }
  return [value[0], value[1], value[2]];
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new PlacementError(`${what} must be an integer`);
  return value;
}

function bodyRef(value: unknown, what: string): BodyRef {
  if (!isRecord(value)) throw new PlacementError(`${what} must be an object`);
  if (value.kind === "ragdoll") return { kind: "ragdoll", bone: integer(value.bone, `${what}.bone`) };
  if (value.kind === "prop") return { kind: "prop", id: integer(value.id, `${what}.id`) };
  throw new PlacementError(`${what}.kind must be "ragdoll" or "prop"`);
}

/**
 * Parse untrusted JSON into placements, rebuilding each one from the known
 * fields only. Throws PlacementError if anything is malformed.
 */
export function parsePlacements(input: unknown, maxCount: number): Placement[] {
  if (!Array.isArray(input)) throw new PlacementError("placements must be an array");
  if (input.length > maxCount) throw new PlacementError(`at most ${maxCount} placements are allowed`);

  return input.map((item, i): Placement => {
    const what = `placements[${i}]`;
    if (!isRecord(item)) throw new PlacementError(`${what} must be an object`);
    if (item.kind === "force") {
      return {
        kind: "force",
        target: bodyRef(item.target, `${what}.target`),
        localPoint: vec3(item.localPoint, `${what}.localPoint`),
        vector: vec3(item.vector, `${what}.vector`),
      };
    }
    if (item.kind === "box") {
      return { kind: "box", id: integer(item.id, `${what}.id`), position: vec3(item.position, `${what}.position`) };
    }
    throw new PlacementError(`${what}.kind must be "force" or "box"`);
  });
}

/**
 * Check placements obey the same rules the game enforces: the level's
 * inventory, force strength and attachment limits, and boxes that sit inside the
 * level without overlapping anything. Throws PlacementError on the first problem.
 */
export function validatePlacements(b3: Box3DModule, level: Level, placements: readonly Placement[]) {
  for (const kind of Object.keys(level.inventory) as (keyof Level["inventory"])[]) {
    const used = placements.filter((p) => p.kind === kind).length;
    if (used > level.inventory[kind]) {
      throw new PlacementError(`this level allows ${level.inventory[kind]} ${kind} placements, got ${used}`);
    }
  }

  const boxIds = new Set<number>();
  const minY = level.bounds.min.y;
  const maxY = level.bounds.max.y + MAX_HEIGHT_ABOVE_LEVEL;
  for (const p of placements) {
    if (p.kind !== "box") continue;
    if (p.id <= 0 || boxIds.has(p.id)) throw new PlacementError(`box id ${p.id} must be positive and unique`);
    boxIds.add(p.id);
    const [x, y, z] = p.position;
    const { min, max } = level.bounds;
    if (x < min.x || x > max.x || z < min.z || z > max.z || y < minY || y > maxY) {
      throw new PlacementError(`box ${p.id} is outside the level`);
    }
  }

  for (const p of placements) {
    if (p.kind !== "force") continue;
    const { target } = p;
    if (target.kind === "ragdoll" && !(target.bone >= 0 && target.bone < BODY_PARTS.length)) {
      throw new PlacementError(`there is no ragdoll bone ${target.bone}`);
    }
    if (target.kind === "prop" && !boxIds.has(target.id)) {
      throw new PlacementError(`a force targets missing box ${target.id}`);
    }
    if (new THREE.Vector3(...p.localPoint).length() > MAX_ATTACH_DISTANCE) {
      throw new PlacementError("a force is attached too far from its body");
    }
    const length = new THREE.Vector3(...p.vector).length();
    if (length < MIN_ARROW_LENGTH - LENGTH_EPSILON || length > MAX_ARROW_LENGTH + LENGTH_EPSILON) {
      throw new PlacementError("a force is too weak or too strong");
    }
  }

  if (boxIds.size === 0) return;
  const simulation = createSimulation(b3, level.map, placements);
  try {
    for (const p of placements) {
      if (p.kind === "box" && simulation.boxOverlaps(p.position, p.id)) {
        throw new PlacementError(`box ${p.id} overlaps something`);
      }
    }
  } finally {
    simulation.destroy();
  }
}
