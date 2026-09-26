import * as THREE from "three";
import { MAX_ARROW_LENGTH } from "@stairs/shared/simulation";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { fatLineMaterial, fatLines } from "./fat-lines";
import type { Aim } from "./force-aim";

const DEG = Math.PI / 180;
const FLAT_COLOR = 0x4dd0e1;
const HEIGHT_COLOR = 0xff80ab;
const RULER_COLOR = 0xffffff;
/** Rings on the flat guide and ticks on the strength ruler, marking arrow lengths. */
const RINGS = [0.5, 1, MAX_ARROW_LENGTH];
/** Minor spokes start this far out, so the centre doesn't clutter. */
const MINOR_SPOKE_START = 0.25;
/** The height guide never shrinks below this, so it stays readable for short arrows. */
const MIN_HEIGHT_GUIDE_RADIUS = 0.35;

/** Faint lines are drawn thinner, so the brighter ones stand out. */
function lines(points: THREE.Vector3[], color: number, opacity: number) {
  const segments = fatLines(points, fatLineMaterial({ color, opacity, width: opacity >= 0.5 ? 3 : 2, overlay: true }));
  segments.renderOrder = 1999;
  return segments;
}

function arc(radius: number, from: number, to: number, steps: number, point: (angle: number) => THREE.Vector3) {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < steps; i++) {
    const a = from + ((to - from) * i) / steps;
    const b = from + ((to - from) * (i + 1)) / steps;
    points.push(point(a).multiplyScalar(radius), point(b).multiplyScalar(radius));
  }
  return points;
}

/** Guide spokes are this many degrees apart. */
const GUIDE_DEGREES = 15;

/**
 * Guides for whichever part of a force is being dragged, to judge angles by:
 * spokes every GUIDE_DEGREES, with the main directions (forward, back, the
 * sides, level, straight up and down) drawn brighter.
 *
 * - Creating or turning: a level disc of spokes around the arrow's base,
 *   counted from the way the ragdoll faces. While creating, rings mark
 *   strength (the pointer's distance from the base).
 * - Tilting: a half circle of vertical angles, straight down to straight up,
 *   pivoting on the arrow's base in the arrow's own vertical plane, with the
 *   arrowhead on its edge.
 * - Strength: a ruler along the arrow's line out to full strength, with ticks
 *   at the same lengths as the rings.
 */
export class AimGuides {
  private readonly flat = new THREE.Group();
  private readonly flatRings: LineSegments2;
  private readonly height = new THREE.Group();
  private readonly ruler = new THREE.Group();
  /** The flat direction of the height guide, kept when the arrow points straight up or down. */
  private readonly heightFacing = new THREE.Vector3(1, 0, 0);

  constructor(scene: THREE.Scene, forwardYaw: number) {
    // Flat guide, in the XZ plane. Yaw is measured about +Y from +Z towards +X.
    const flatPoint = (yaw: number) => new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const major: THREE.Vector3[] = [];
    const minor: THREE.Vector3[] = [];
    for (let step = 0; step < 360 / GUIDE_DEGREES; step++) {
      const degrees = step * GUIDE_DEGREES;
      const direction = flatPoint(forwardYaw + degrees * DEG);
      if (degrees % 90 === 0) major.push(new THREE.Vector3(), direction.clone().multiplyScalar(MAX_ARROW_LENGTH));
      else minor.push(direction.clone().multiplyScalar(MINOR_SPOKE_START), direction.clone().multiplyScalar(MAX_ARROW_LENGTH));
    }
    this.flatRings = lines(RINGS.flatMap((radius) => arc(radius, 0, 2 * Math.PI, 64, flatPoint)), FLAT_COLOR, 0.3);
    this.flat.add(lines(major, FLAT_COLOR, 0.8), lines(minor, FLAT_COLOR, 0.3), this.flatRings);

    // Height guide, in a unit half circle: local +X is the arrow's flat
    // direction, local +Y is up. Pitch runs from -90° (down) to +90° (up).
    const heightPoint = (pitch: number) => new THREE.Vector3(Math.cos(pitch), Math.sin(pitch), 0);
    const heightMajor: THREE.Vector3[] = [];
    const heightMinor: THREE.Vector3[] = [];
    for (let degrees = -90; degrees <= 90; degrees += GUIDE_DEGREES) {
      const tip = heightPoint(degrees * DEG);
      (degrees % 90 === 0 ? heightMajor : heightMinor).push(new THREE.Vector3(), tip);
    }
    const outline = arc(1, -Math.PI / 2, Math.PI / 2, 48, heightPoint);
    this.height.add(lines(heightMajor, HEIGHT_COLOR, 0.8), lines(heightMinor, HEIGHT_COLOR, 0.3), lines(outline, HEIGHT_COLOR, 0.5));

    // Strength ruler, along local +Y (turned to the arrow's direction): the
    // line out to full strength, with a cross tick at each ring length.
    const ruler: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(0, MAX_ARROW_LENGTH, 0)];
    for (const length of RINGS) {
      for (const [a, b] of [[new THREE.Vector3(-0.08, length, 0), new THREE.Vector3(0.08, length, 0)], [new THREE.Vector3(0, length, -0.08), new THREE.Vector3(0, length, 0.08)]]) {
        ruler.push(a, b);
      }
    }
    this.ruler.add(lines(ruler, RULER_COLOR, 0.8));

    this.flat.visible = this.height.visible = this.ruler.visible = false;
    scene.add(this.flat, this.height, this.ruler);
  }

  /**
   * Show the guide for what's being dragged, or hide them all when nothing is.
   * `vector` is the arrow as displayed, which the guides line up with.
   */
  update(aim: Aim | null, vector: THREE.Vector3 | null) {
    const mode = aim?.currentMode ?? null;
    this.flat.visible = mode === "create" || mode === "heading";
    this.flatRings.visible = mode === "create";
    this.height.visible = mode === "tilt";
    this.ruler.visible = mode === "length";
    if (!aim || !vector) return;

    this.flat.position.copy(aim.origin);

    const flatDirection = new THREE.Vector3(vector.x, 0, vector.z);
    if (flatDirection.lengthSq() > 1e-6) this.heightFacing.copy(flatDirection.normalize());
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(this.heightFacing, up);
    this.height.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.heightFacing, up, side));
    this.height.position.copy(aim.origin);
    this.height.scale.setScalar(Math.max(vector.length(), MIN_HEIGHT_GUIDE_RADIUS));

    this.ruler.position.copy(aim.origin);
    if (vector.lengthSq() > 1e-8) this.ruler.quaternion.setFromUnitVectors(up, vector.clone().normalize());
  }
}
