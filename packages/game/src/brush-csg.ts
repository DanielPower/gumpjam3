import * as THREE from "three";
import type { BrushGeometry } from "@stairs/shared/trenchbroom-map";

/** Distances below this (metres) count as touching. */
const EPSILON = 1e-4;

export type VisibleFace = { vertices: THREE.Vector3[]; normal: THREE.Vector3; texture: string };

type Plane = { normal: THREE.Vector3; distance: number };

type Brush = { planes: Plane[]; bounds: THREE.Box3; faces: { polygon: THREE.Vector3[]; plane: Plane; texture: string }[] };

/** Outward plane of a face whose vertices wind counter-clockwise seen from outside. */
function facePlane(polygon: THREE.Vector3[]): Plane {
  // Newell's method: robust for any convex polygon.
  const normal = new THREE.Vector3();
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  normal.normalize();
  return { normal, distance: normal.dot(polygon[0]) };
}

function prepare(brush: BrushGeometry): Brush {
  const faces = brush.faces.map((indices, i) => {
    const polygon = indices.map((index) => brush.vertices[index]);
    return { polygon, plane: facePlane(polygon), texture: brush.textures[i] };
  });
  return { planes: faces.map((f) => f.plane), bounds: new THREE.Box3().setFromPoints(brush.vertices), faces };
}

/** Split a convex polygon by a plane into the parts in front of and behind it. */
function split(polygon: THREE.Vector3[], plane: Plane) {
  const front: THREE.Vector3[] = [];
  const back: THREE.Vector3[] = [];
  const sides = polygon.map((p) => plane.normal.dot(p) - plane.distance);
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const sa = sides[i];
    const sb = sides[(i + 1) % polygon.length];
    if (sa >= -EPSILON) front.push(a);
    if (sa <= EPSILON) back.push(a);
    // The edge crosses the plane: both halves get the crossing point.
    if ((sa > EPSILON && sb < -EPSILON) || (sa < -EPSILON && sb > EPSILON)) {
      const crossing = a.clone().lerp(b, sa / (sa - sb));
      front.push(crossing);
      back.push(crossing.clone());
    }
  }
  return { front: front.length >= 3 ? front : null, back: back.length >= 3 ? back : null };
}

/**
 * The parts of `polygon` (a face of brush number `self`) outside `other`
 * (brush number `otherIndex`). A face lying flat against one of `other`'s faces
 * is hidden if they face opposite ways (the two brushes touch there); if they
 * face the same way, only the earlier brush's face is kept, so duplicates
 * don't z-fight.
 */
function outsideOf(polygon: THREE.Vector3[], normal: THREE.Vector3, self: number, other: Brush, otherIndex: number) {
  // Entirely outside one of the brush's planes: nothing to clip, so keep the
  // face whole rather than cutting it into needless pieces.
  for (const plane of other.planes) {
    const sides = polygon.map((p) => plane.normal.dot(p) - plane.distance);
    if (sides.every((d) => d >= -EPSILON) && sides.some((d) => d > EPSILON)) return [polygon];
  }
  const outside: THREE.Vector3[][] = [];
  let remaining: THREE.Vector3[] | null = polygon;
  for (const plane of other.planes) {
    if (!remaining) break;
    const coplanar = remaining.every((p) => Math.abs(plane.normal.dot(p) - plane.distance) <= EPSILON);
    if (coplanar) {
      const sameWay = plane.normal.dot(normal) > 0;
      if (sameWay && self < otherIndex) {
        outside.push(remaining);
        remaining = null;
      }
      continue; // otherwise it stays in `remaining`, to be clipped by the other planes
    }
    const { front, back } = split(remaining, plane);
    if (front) outside.push(front);
    remaining = back;
  }
  return outside; // whatever is still `remaining` is inside `other`, so hidden
}

/**
 * The visible parts of a group of brushes' faces: every face clipped against
 * every other brush, dropping the parts buried inside them. Brushes are drawn
 * as one solid this way, without hidden faces that would still cast shadows
 * (e.g. between the steps of a staircase) or z-fight.
 */
export function visibleFaces(brushes: BrushGeometry[]): VisibleFace[] {
  const prepared = brushes.map(prepare);
  const result: VisibleFace[] = [];
  prepared.forEach((brush, self) => {
    for (const face of brush.faces) {
      const faceBounds = new THREE.Box3().setFromPoints(face.polygon).expandByScalar(EPSILON);
      let fragments = [face.polygon];
      prepared.forEach((other, otherIndex) => {
        if (otherIndex === self || fragments.length === 0 || !other.bounds.intersectsBox(faceBounds)) return;
        fragments = fragments.flatMap((fragment) => outsideOf(fragment, face.plane.normal, self, other, otherIndex));
      });
      for (const vertices of fragments) result.push({ vertices, normal: face.plane.normal, texture: face.texture });
    }
  });
  return fixTJunctions(result);
}

/**
 * Make the clipped pieces watertight. Where cuts cross, the same corner can be
 * computed in different pieces and come out microscopically different, so
 * first weld corners within EPSILON of each other into one shared point. Then
 * fix T-junctions (a corner lying partway along a neighbouring piece's edge)
 * by adding the corner to that edge. Otherwise the GPU leaves pinholes and
 * hairline cracks where pieces meet.
 */
function fixTJunctions(faces: VisibleFace[]): VisibleFace[] {
  // Every distinct corner, bucketed on a coarse grid to keep searches local.
  const CELL = 1;
  const grid = new Map<string, THREE.Vector3[]>();
  const cell = (n: number) => Math.floor(n / CELL);
  const inCells = (min: THREE.Vector3, max: THREE.Vector3) => {
    const found: THREE.Vector3[] = [];
    for (let x = cell(min.x); x <= cell(max.x); x++) {
      for (let y = cell(min.y); y <= cell(max.y); y++) {
        for (let z = cell(min.z); z <= cell(max.z); z++) found.push(...(grid.get(`${x},${y},${z}`) ?? []));
      }
    }
    return found;
  };
  const margin = new THREE.Vector3(EPSILON, EPSILON, EPSILON);
  const weld = (v: THREE.Vector3) => {
    const existing = inCells(v.clone().sub(margin), v.clone().add(margin)).find((u) => u.distanceToSquared(v) < EPSILON * EPSILON);
    if (existing) return existing;
    const key = `${cell(v.x)},${cell(v.y)},${cell(v.z)}`;
    grid.set(key, [...(grid.get(key) ?? []), v]);
    return v;
  };
  const welded = faces.map((face) => ({ ...face, vertices: face.vertices.map(weld) }));

  const edge = new THREE.Line3();
  const closest = new THREE.Vector3();
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();
  return welded.map((face) => {
    const vertices: THREE.Vector3[] = [];
    face.vertices.forEach((a, i) => {
      const b = face.vertices[(i + 1) % face.vertices.length];
      vertices.push(a);
      edge.set(a, b);
      const length = a.distanceTo(b);
      min.copy(a).min(b).sub(margin);
      max.copy(a).max(b).add(margin);
      const between = inCells(min, max)
        .map((p) => ({ p, t: edge.closestPointToPointParameter(p, false) }))
        .filter(({ p, t }) => t * length > EPSILON && (1 - t) * length > EPSILON && edge.at(t, closest).distanceTo(p) < EPSILON)
        .sort((l, r) => l.t - r.t);
      for (const { p } of between) vertices.push(p);
    });
    // Welding can merge neighbouring corners of a tiny piece; drop repeats.
    const unique = vertices.filter((v, i) => v !== vertices[(i + 1) % vertices.length]);
    return { ...face, vertices: unique };
  }).filter((face) => face.vertices.length >= 3);
}
