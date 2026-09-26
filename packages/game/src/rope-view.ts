import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { fatLineMaterial, fatLines, setStrip, strip } from "./fat-lines";

/** Points along each drawn rope. */
const SEGMENTS = 20;
const ROPE_COLOR = 0xb08850;

/**
 * Points along a rope of `length` hanging between `a` and `b`: straight when
 * taut, sagging when slack. The sag is a parabola as deep as a rope that long
 * would hang, near enough.
 */
function ropePoints(a: THREE.Vector3, b: THREE.Vector3, length: number, out: THREE.Vector3[]) {
  const span = a.distanceTo(b);
  const slack = Math.max(0, length - span);
  // A shallow parabola of depth s over span d is about d + 8s²/3d long.
  const sag = span > 1e-3 ? Math.sqrt((3 * span * slack) / 8) : length / 2;
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    out[i].lerpVectors(a, b, t);
    out[i].y -= 4 * sag * t * (1 - t);
  }
  return out;
}

/** Draws ropes, and the one being tied while the player drags it out. */
export class RopeView {
  readonly object3d = new THREE.Group();
  private readonly material = fatLineMaterial({ color: ROPE_COLOR, width: 4 });
  private readonly selectedMaterial = fatLineMaterial({ color: 0xffd98a, width: 5 });
  private readonly previewMaterial = fatLineMaterial({ color: 0xffffff, width: 4, opacity: 0.7 });
  private readonly blockedMaterial = fatLineMaterial({ color: 0xff4040, width: 4, opacity: 0.7 });
  private ropes: { line: LineSegments2; length: number; points: THREE.Vector3[] }[] = [];
  private readonly preview = this.newRope(this.previewMaterial);

  constructor() {
    this.preview.line.visible = false;
    this.object3d.add(this.preview.line);
  }

  private newRope(material: LineMaterial) {
    const points = Array.from({ length: SEGMENTS + 1 }, () => new THREE.Vector3());
    const line = fatLines(strip(points), material);
    return { line, length: 0, points };
  }

  /** One rope per entry, as long as it is when the run starts. */
  setRopes(lengths: readonly number[]) {
    while (this.ropes.length < lengths.length) {
      const rope = this.newRope(this.material);
      this.ropes.push(rope);
      this.object3d.add(rope.line);
    }
    for (const rope of this.ropes.splice(lengths.length)) {
      rope.line.removeFromParent();
      rope.line.geometry.dispose();
    }
    lengths.forEach((length, i) => (this.ropes[i].length = length));
  }

  /** Redraw rope `i` between where its ends are now (or hide it, if it's gone). */
  update(i: number, a: THREE.Vector3, b: THREE.Vector3, selected: boolean, visible = true) {
    const rope = this.ropes[i];
    if (!rope) return;
    rope.line.visible = visible;
    setStrip(rope.line, ropePoints(a, b, rope.length, rope.points));
    rope.line.material = selected ? this.selectedMaterial : this.material;
  }

  /** Show a rope being tied from `a` to `b` (taut), red if it can't be; null hides it. */
  showPreview(a: THREE.Vector3 | null, b: THREE.Vector3 | null, valid: boolean) {
    this.preview.line.visible = a !== null && b !== null;
    if (!a || !b) return;
    setStrip(this.preview.line, ropePoints(a, b, a.distanceTo(b), this.preview.points));
    this.preview.line.material = valid ? this.previewMaterial : this.blockedMaterial;
  }

  /** The rope drawn nearest `pointer` (screen pixels), within `reach` pixels, or -1. */
  hit(pointer: THREE.Vector2, toScreen: (point: THREE.Vector3) => THREE.Vector2, reach: number) {
    let best = -1;
    let bestDistance = reach;
    this.ropes.forEach((rope, i) => {
      for (let j = 0; j < SEGMENTS; j++) {
        const [a, b] = [toScreen(rope.points[j]), toScreen(rope.points[j + 1])];
        const along = b.clone().sub(a);
        const t = THREE.MathUtils.clamp(pointer.clone().sub(a).dot(along) / Math.max(along.lengthSq(), 1e-6), 0, 1);
        const distance = a.clone().addScaledVector(along, t).distanceTo(pointer);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
    });
    return best;
  }
}
