import * as THREE from "three";

export const MAX_ARROW_LENGTH = 1.5;
export const MIN_ARROW_LENGTH = 0.05;

/** Horizontal drags aim across the floor; vertical drags only change height. */
export type AimMode = "horizontal" | "vertical";

const DEG = Math.PI / 180;
const SNAP_STEP = 15 * DEG;
/** Preferred directions capture the aim from further away than the grid does. */
const STRONG_SNAP_WINDOW = 8 * DEG;
const PREFERRED_YAWS = [0, 90 * DEG, -90 * DEG, 180 * DEG];
const PREFERRED_PITCHES = [0, 90 * DEG, -90 * DEG];
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Tracks a drag that aims a force vector from a fixed origin. The pointer moves
 * across a plane through the arrow's tip: a horizontal plane, or (for height) a
 * vertical plane facing the camera. Movement is applied relative to where the
 * drag, or the latest mode switch, began, so switching modes never jumps.
 */
export class Aim {
  /** Unsnapped vector, in world space. */
  readonly raw: THREE.Vector3;
  private mode: AimMode | null = null;
  private readonly plane = new THREE.Plane();
  private readonly anchorHit = new THREE.Vector3();
  private readonly anchorVector = new THREE.Vector3();

  readonly origin: THREE.Vector3;

  constructor(origin: THREE.Vector3, initial = new THREE.Vector3()) {
    this.origin = origin.clone();
    this.raw = initial.clone();
  }

  get currentMode() {
    return this.mode;
  }

  tip(target = new THREE.Vector3()) {
    return target.copy(this.origin).add(this.raw);
  }

  /** The plane the pointer currently moves across, for drawing a guide. */
  get dragPlane(): Readonly<THREE.Plane> {
    return this.plane;
  }

  update(ray: THREE.Ray, mode: AimMode, camera: THREE.Camera) {
    if (mode !== this.mode && !this.reanchor(ray, mode, camera)) return;

    const hit = ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) return;
    const delta = hit.sub(this.anchorHit);
    const v = this.raw.copy(this.anchorVector);

    // The component being dragged wins; the other shrinks to keep within the
    // maximum length. Both are recomputed from the anchor, so it recovers if the
    // pointer moves back.
    if (mode === "horizontal") {
      v.x += delta.x;
      v.z += delta.z;
      const flat = Math.hypot(v.x, v.z);
      if (flat > MAX_ARROW_LENGTH) {
        v.x *= MAX_ARROW_LENGTH / flat;
        v.z *= MAX_ARROW_LENGTH / flat;
      }
      const maxHeight = Math.sqrt(Math.max(0, MAX_ARROW_LENGTH ** 2 - v.x ** 2 - v.z ** 2));
      v.y = THREE.MathUtils.clamp(v.y, -maxHeight, maxHeight);
    } else {
      v.y = THREE.MathUtils.clamp(v.y + delta.y, -MAX_ARROW_LENGTH, MAX_ARROW_LENGTH);
      const maxFlat = Math.sqrt(Math.max(0, MAX_ARROW_LENGTH ** 2 - v.y ** 2));
      const flat = Math.hypot(v.x, v.z);
      if (flat > maxFlat) {
        v.x *= maxFlat / flat;
        v.z *= maxFlat / flat;
      }
    }
  }

  private reanchor(ray: THREE.Ray, mode: AimMode, camera: THREE.Camera) {
    const tip = this.tip();
    let normal = UP.clone();
    if (mode === "vertical") {
      normal = camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
      normal.normalize();
    }
    this.plane.setFromNormalAndCoplanarPoint(normal, tip);
    if (!ray.intersectPlane(this.plane, this.anchorHit)) return false;
    this.anchorVector.copy(this.raw);
    this.mode = mode;
    return true;
  }
}

function snapAngle(angle: number, preferred: number[]) {
  for (const p of preferred) {
    const diff = Math.atan2(Math.sin(angle - p), Math.cos(angle - p));
    if (Math.abs(diff) <= STRONG_SNAP_WINDOW) return p;
  }
  return Math.round(angle / SNAP_STEP) * SNAP_STEP;
}

/** Yaw is measured about +Y from +Z towards +X, matching getEntityWorldYaw. */
function yawOf(v: THREE.Vector3) {
  return Math.atan2(v.x, v.z);
}

/**
 * Snap direction to 15° steps, with a stronger pull towards straight forward,
 * back, left and right (relative to `forwardYaw`), level, and straight up/down.
 */
export function snapAim(v: THREE.Vector3, forwardYaw: number): THREE.Vector3 {
  const length = v.length();
  if (length < MIN_ARROW_LENGTH) return v.clone();
  const yaw = forwardYaw + snapAngle(yawOf(v) - forwardYaw, PREFERRED_YAWS);
  const pitch = snapAngle(Math.atan2(v.y, Math.hypot(v.x, v.z)), PREFERRED_PITCHES);
  const flat = length * Math.cos(pitch);
  return new THREE.Vector3(flat * Math.sin(yaw), length * Math.sin(pitch), flat * Math.cos(yaw));
}

/** Human-readable direction relative to the ragdoll, e.g. "forward, 30° up". */
export function describeAim(v: THREE.Vector3, forwardYaw: number): string {
  const pitch = Math.round(Math.atan2(v.y, Math.hypot(v.x, v.z)) / DEG);
  if (Math.abs(pitch) === 90) return pitch > 0 ? "straight up" : "straight down";

  // Positive relative yaw is towards the ragdoll's left.
  let rel = Math.round((yawOf(v) - forwardYaw) / DEG);
  rel = ((((rel + 180) % 360) + 360) % 360) - 180;
  const named: Record<number, string> = { 0: "forward", 90: "left", [-90]: "right", [-180]: "back" };
  const direction =
    named[rel] ??
    (Math.abs(rel) < 90
      ? `forward ${Math.abs(rel)}° ${rel > 0 ? "left" : "right"}`
      : `back ${180 - Math.abs(rel)}° ${rel > 0 ? "left" : "right"}`);
  const height = pitch === 0 ? "level" : `${Math.abs(pitch)}° ${pitch > 0 ? "up" : "down"}`;
  return `${direction}, ${height}`;
}
