import * as THREE from "three";
import {
  entityBrushGeometry,
  getEntityWorldOrigin,
  mapUnitsToMeters,
  mapVectorToWorld,
  type BrushGeometry,
  type TrenchBroomEntity,
  type TrenchBroomMap,
} from "./trenchbroom-map";

/*
 * Brush entities understood by the game, set up in TrenchBroom:
 *
 *   worldspawn, func_group, func_detail, func_wall
 *       Static level geometry.
 *   func_bouncy
 *       Static and springy. "restitution" (default 1.1; above 1 adds energy),
 *       "friction" (default 0.6).
 *   func_rotating
 *       Spins forever about "axis" in map coordinates (vertical by default)
 *       through "origin" (or the centre of its brushes). "speed" is in degrees
 *       per second; negative spins the other way.
 *   func_mover
 *       Travels along "move" (an offset in map units) at "speed" map units per
 *       second. "mode" is "loop" (jump back to the start at the end; hide the
 *       jump inside geometry) or "pingpong". "phase" (0-1) is how far along the
 *       cycle it starts.
 *   func_rat
 *       Waits at its authored origin until assigned player-placed bait, then
 *       makes one charge through it when the ragdoll approaches. "speed" is
 *       map units per second, "delay" is the arming time after Go, and
 *       "forward" is the direction the brushwork faces in map axes.
 *
 * Moving entities are driven purely by the physics step count, so every
 * replay (including the server's) sees them in exactly the same place.
 */

const STATIC_CLASSES = new Set(["worldspawn", "func_group", "func_detail", "func_wall"]);

export type SurfaceMaterial = { friction: number; restitution: number };

export type StaticSolid = { brushes: BrushGeometry[]; material: SurfaceMaterial | null };

export type MoverMotion =
  | { kind: "rotate"; angularVelocity: THREE.Vector3 }
  | { kind: "path"; offset: THREE.Vector3; speed: number; loop: boolean; phase: number }
  | { kind: "rat"; speed: number; delay: number; forward: THREE.Vector3 }
  /** A physics car driving once along `offset` at `speed`, until it hits something or gets to the end. */
  | { kind: "car"; offset: THREE.Vector3; speed: number; phase: number; mass: number };

export type MovingSolid = {
  /** Index into map.entities, for looking the entity up again. */
  entityIndex: number;
  /** Body origin in world space; `brushes` are relative to it. */
  pivot: THREE.Vector3;
  brushes: BrushGeometry[];
  motion: MoverMotion;
};

export type LevelSolids = { statics: StaticSolid[]; movers: MovingSolid[] };

function number(entity: TrenchBroomEntity, key: string, fallback: number) {
  const value = Number(entity.properties[key]);
  return entity.properties[key] !== undefined && Number.isFinite(value) ? value : fallback;
}

function brushBounds(brushes: BrushGeometry[]) {
  const bounds = new THREE.Box3();
  for (const brush of brushes) for (const vertex of brush.vertices) bounds.expandByPoint(vertex);
  return bounds;
}

/** Make brush geometry relative to `pivot`. */
function relativeTo(brushes: BrushGeometry[], pivot: THREE.Vector3): BrushGeometry[] {
  return brushes.map((brush) => ({ ...brush, vertices: brush.vertices.map((v) => v.clone().sub(pivot)) }));
}

const solidsCache = new WeakMap<TrenchBroomMap, LevelSolids>();

/** Sort a level's brushes into static solids and moving ones. Cached per map; don't mutate the result. */
export function levelSolids(map: TrenchBroomMap): LevelSolids {
  const cached = solidsCache.get(map);
  if (cached) return cached;
  const statics: StaticSolid[] = [];
  const movers: MovingSolid[] = [];

  map.entities.forEach((entity, entityIndex) => {
    const classname = entity.properties.classname ?? "";
    if (entity.brushes.length === 0) return;
    const brushes = entityBrushGeometry(entity);

    if (STATIC_CLASSES.has(classname)) {
      statics.push({ brushes, material: null });
    } else if (classname === "func_bouncy") {
      statics.push({
        brushes,
        material: { restitution: number(entity, "restitution", 1.1), friction: number(entity, "friction", 0.6) },
      });
    } else if (classname === "func_rotating") {
      const pivot = getEntityWorldOrigin(entity) ?? brushBounds(brushes).getCenter(new THREE.Vector3());
      const radiansPerSecond = THREE.MathUtils.degToRad(number(entity, "speed", 90));
      const axis = mapVectorToWorld(entity.properties.axis)?.normalize() ?? new THREE.Vector3(0, 1, 0);
      movers.push({
        entityIndex,
        pivot,
        brushes: relativeTo(brushes, pivot),
        motion: { kind: "rotate", angularVelocity: axis.multiplyScalar(radiansPerSecond) },
      });
    } else if (classname === "func_mover") {
      const pivot = brushBounds(brushes).getCenter(new THREE.Vector3());
      movers.push({
        entityIndex,
        pivot,
        brushes: relativeTo(brushes, pivot),
        motion: {
          kind: "path",
          offset: mapVectorToWorld(entity.properties.move) ?? new THREE.Vector3(),
          speed: mapUnitsToMeters(number(entity, "speed", 256)),
          loop: entity.properties.mode !== "pingpong",
          phase: THREE.MathUtils.euclideanModulo(number(entity, "phase", 0), 1),
        },
      });
    } else if (classname === "func_car") {
      const pivot = brushBounds(brushes).getCenter(new THREE.Vector3());
      movers.push({
        entityIndex,
        pivot,
        brushes: relativeTo(brushes, pivot),
        motion: {
          kind: "car",
          offset: mapVectorToWorld(entity.properties.move) ?? new THREE.Vector3(),
          speed: mapUnitsToMeters(number(entity, "speed", 256)),
          phase: THREE.MathUtils.euclideanModulo(number(entity, "phase", 0), 1),
          mass: Math.max(1, number(entity, "mass", 1200)),
        },
      });
    } else if (classname === "func_rat") {
      const pivot = getEntityWorldOrigin(entity) ?? brushBounds(brushes).getCenter(new THREE.Vector3());
      const forward = mapVectorToWorld(entity.properties.forward)?.setY(0).normalize() ?? new THREE.Vector3(0, 0, 1);
      movers.push({
        entityIndex,
        pivot,
        brushes: relativeTo(brushes, pivot),
        motion: {
          kind: "rat",
          speed: mapUnitsToMeters(number(entity, "speed", 320)),
          delay: Math.max(0, number(entity, "delay", 0.5)),
          forward,
        },
      });
    }
  });

  const solids = { statics, movers };
  solidsCache.set(map, solids);
  return solids;
}

/**
 * Where a path mover is at time `t` (seconds into the run), as a fraction of
 * its path (0 = start, 1 = end). Loops jump from 1 back to 0.
 */
export function pathProgress(motion: Extract<MoverMotion, { kind: "path" }>, t: number) {
  const length = motion.offset.length();
  if (length === 0 || motion.speed <= 0) return 0;
  if (motion.loop) return THREE.MathUtils.euclideanModulo(motion.phase + (t * motion.speed) / length, 1);
  const cycle = THREE.MathUtils.euclideanModulo(motion.phase + (t * motion.speed) / (2 * length), 1);
  return cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
}
