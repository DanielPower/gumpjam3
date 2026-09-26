import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { fatLineMaterial, fatLines, setStrip, strip } from "./fat-lines";

const ROPE_COLOR = 0xb08850;

type Rope = { line: LineSegments2; points: THREE.Vector3[] };

/**
 * Draws ropes through the points of their physical chains, and the one being
 * tied (straight, as it starts) while the player drags it out.
 */
export class RopeView {
  readonly object3d = new THREE.Group();
  private readonly material = fatLineMaterial({ color: ROPE_COLOR, width: 4 });
  private readonly selectedMaterial = fatLineMaterial({ color: 0xffd98a, width: 5 });
  private readonly previewMaterial = fatLineMaterial({ color: 0xffffff, width: 4, opacity: 0.7 });
  private readonly blockedMaterial = fatLineMaterial({ color: 0xff4040, width: 4, opacity: 0.7 });
  private ropes: Rope[] = [];
  private readonly preview = this.newRope(2, this.previewMaterial);

  constructor() {
    this.preview.line.visible = false;
    this.object3d.add(this.preview.line);
  }

  private newRope(pointCount: number, material: LineMaterial): Rope {
    const points = Array.from({ length: pointCount }, () => new THREE.Vector3());
    return { line: fatLines(strip(points), material), points };
  }

  /** One rope per entry, drawn through that many points. */
  setRopes(pointCounts: readonly number[]) {
    for (const rope of this.ropes) {
      rope.line.removeFromParent();
      rope.line.geometry.dispose();
    }
    this.ropes = pointCounts.map((count) => {
      const rope = this.newRope(count, this.material);
      this.object3d.add(rope.line);
      return rope;
    });
  }

  /** Redraw rope `i` through `points` (or hide it, if it's gone). */
  update(i: number, points: readonly THREE.Vector3[], selected: boolean, visible = true) {
    const rope = this.ropes[i];
    if (!rope) return;
    rope.line.visible = visible;
    points.forEach((point, j) => rope.points[j]?.copy(point));
    setStrip(rope.line, rope.points);
    rope.line.material = selected ? this.selectedMaterial : this.material;
  }

  /** Show a rope being tied from `a` to `b`, red if it can't be; null hides it. */
  showPreview(a: THREE.Vector3 | null, b: THREE.Vector3 | null, valid: boolean) {
    this.preview.line.visible = a !== null && b !== null;
    if (!a || !b) return;
    this.preview.points[0].copy(a);
    this.preview.points[1].copy(b);
    setStrip(this.preview.line, this.preview.points);
    this.preview.line.material = valid ? this.previewMaterial : this.blockedMaterial;
  }

  /** The rope drawn nearest `pointer` (screen pixels), within `reach` pixels, or -1. */
  hit(pointer: THREE.Vector2, toScreen: (point: THREE.Vector3) => THREE.Vector2, reach: number) {
    let best = -1;
    let bestDistance = reach;
    this.ropes.forEach((rope, i) => {
      for (let j = 0; j < rope.points.length - 1; j++) {
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
