import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/** Default line width, in CSS pixels. WebGL's own lines are always 1 pixel. */
export const LINE_PIXELS = 2.5;

export type FatLineOptions = {
  color: THREE.ColorRepresentation;
  opacity?: number;
  /** Width in CSS pixels, the same at any zoom. */
  width?: number;
  /** Draw over everything, e.g. for guides and handles. */
  overlay?: boolean;
  dashed?: { dashSize: number; gapSize: number };
};

export function fatLineMaterial({ color, opacity = 1, width = LINE_PIXELS, overlay = false, dashed }: FatLineOptions) {
  return new LineMaterial({
    color: new THREE.Color(color).getHex(),
    linewidth: width,
    transparent: opacity < 1 || overlay,
    opacity,
    depthTest: !overlay,
    depthWrite: !overlay,
    dashed: dashed !== undefined,
    dashSize: dashed?.dashSize ?? 1,
    gapSize: dashed?.gapSize ?? 1,
  });
}

/**
 * Screen-space thick lines. `points` are pairs of segment ends, as for
 * THREE.LineSegments; see `strip` for a connected path. They aren't pickable.
 */
export function fatLines(points: readonly THREE.Vector3[], material: LineMaterial) {
  const geometry = new LineSegmentsGeometry().setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  const line = new LineSegments2(geometry, material);
  if (material.dashed) line.computeLineDistances();
  line.frustumCulled = false;
  line.raycast = () => {};
  return line;
}

/** A connected path through `points`, as segment pairs for `fatLines`. */
export function strip(points: readonly THREE.Vector3[], closed = false) {
  const pairs: THREE.Vector3[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) pairs.push(points[i], points[(i + 1) % points.length]);
  return pairs;
}

/**
 * Move a one-segment line's ends, in place. (Rebuilding its geometry each time
 * would leave the old GPU buffers behind.)
 */
export function setSegment(line: LineSegments2, a: THREE.Vector3, b: THREE.Vector3) {
  const start = line.geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
  start.data.array.set([a.x, a.y, a.z, b.x, b.y, b.z]);
  start.data.needsUpdate = true;
  const distance = line.geometry.getAttribute("instanceDistanceStart") as THREE.InterleavedBufferAttribute | undefined;
  if (distance) {
    distance.data.array.set([0, a.distanceTo(b)]);
    distance.data.needsUpdate = true;
  }
}

/**
 * Move the points of a line made with `fatLines(strip(points))`, in place.
 * There must be as many points as it was made with.
 */
export function setStrip(line: LineSegments2, points: readonly THREE.Vector3[]) {
  const start = line.geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute;
  const array = start.data.array as Float32Array;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    array.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
  }
  start.data.needsUpdate = true;
}
