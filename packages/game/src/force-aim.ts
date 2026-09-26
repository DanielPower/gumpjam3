import * as THREE from "three";
import { MAX_ARROW_LENGTH } from "@stairs/shared/simulation";

/**
 * What a drag changes. "create" pulls a new arrow out flat (heading and
 * length); the others are the selected arrow's handles, each changing one thing.
 */
export type AimMode = "create" | "heading" | "tilt" | "length";

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Tracks a drag that aims a force vector from a fixed origin, as a heading
 * (yaw), a tilt (pitch) and a length (strength):
 *
 * - create: the pointer moves across a level plane through the origin; which
 *   way sets the heading and how far sets the length.
 * - heading: turns the arrow to point (on the level plane) towards the pointer.
 * - tilt: swings the arrow up or down towards the pointer, in its own
 *   vertical plane.
 * - length: slides the arrowhead along the arrow's line to the pointer.
 *
 * Every mode keeps whatever it doesn't change. Drags are measured from where
 * they began, so grabbing a handle never makes the arrow jump.
 */
export class Aim {
  /** The aimed vector, in world space. */
  readonly raw = new THREE.Vector3();
  readonly origin: THREE.Vector3;
  private yaw = 0;
  private pitch = 0;
  private length = 0;
  private mode: AimMode | null = null;
  private readonly plane = new THREE.Plane();
  private readonly anchorHit = new THREE.Vector3();
  private readonly anchorFlat = new THREE.Vector3();
  private anchorOut = 0;
  private anchorUp = 0;
  private anchorLength = 0;
  private anchorYaw = 0;
  /** Tilt: the plane's horizontal axis, pointing the way the arrow leans on screen. */
  private readonly outward = new THREE.Vector3();

  constructor(origin: THREE.Vector3, initial = new THREE.Vector3()) {
    this.origin = origin.clone();
    this.length = Math.min(initial.length(), MAX_ARROW_LENGTH);
    if (this.length > 0) {
      this.yaw = Math.atan2(initial.x, initial.z);
      this.pitch = Math.atan2(initial.y, Math.hypot(initial.x, initial.z));
    }
    this.updateRaw();
  }

  get currentMode() {
    return this.mode;
  }

  tip(target = new THREE.Vector3()) {
    return target.copy(this.origin).add(this.raw);
  }

  /** The arrow's direction, or its last heading laid flat if it has no length yet. */
  direction(target = new THREE.Vector3()) {
    const flat = Math.cos(this.pitch);
    return target.set(flat * Math.sin(this.yaw), Math.sin(this.pitch), flat * Math.cos(this.yaw));
  }

  update(ray: THREE.Ray, mode: AimMode, camera: THREE.Camera) {
    if (mode !== this.mode && !this.reanchor(ray, mode, camera)) return;

    if (mode === "length") {
      // The point on the arrow's line nearest the pointer's ray.
      const along = closestAlongLine(this.origin, this.direction(), ray);
      if (along !== null) this.length = THREE.MathUtils.clamp(this.anchorLength + along - this.anchorOut, 0, MAX_ARROW_LENGTH);
      this.updateRaw();
      return;
    }

    const hit = ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) return;
    const delta = hit.clone().sub(this.anchorHit);
    if (mode === "create") {
      const flat = this.anchorFlat.clone().add(delta.setY(0));
      if (flat.lengthSq() > 1e-8) this.yaw = Math.atan2(flat.x, flat.z);
      this.length = Math.min(flat.length(), MAX_ARROW_LENGTH);
    } else if (mode === "heading") {
      // Turn by however far the pointer has swung round the base since the grab,
      // so grabbing the knob slightly off-centre doesn't make the arrow jump.
      const now = hit.sub(this.origin).setY(0);
      const then = this.anchorHit.clone().sub(this.origin).setY(0);
      if (now.lengthSq() > 1e-8 && then.lengthSq() > 1e-8) {
        this.yaw = this.anchorYaw + Math.atan2(now.x, now.z) - Math.atan2(then.x, then.z);
      }
    } else {
      const out = Math.max(0, this.anchorOut + delta.dot(this.outward));
      const up = this.anchorUp + delta.y;
      if (out > 1e-6 || Math.abs(up) > 1e-6) this.pitch = Math.atan2(up, out);
    }
    this.updateRaw();
  }

  private updateRaw() {
    this.raw.copy(this.direction()).multiplyScalar(this.length);
  }

  private reanchor(ray: THREE.Ray, mode: AimMode, camera: THREE.Camera) {
    this.anchorLength = this.length;
    this.anchorYaw = this.yaw;
    if (mode === "length") {
      const along = closestAlongLine(this.origin, this.direction(), ray);
      if (along === null) return false;
      this.anchorOut = along;
      this.mode = mode;
      return true;
    }
    if (mode === "tilt") {
      const normal = camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
      normal.normalize();
      this.plane.setFromNormalAndCoplanarPoint(normal, this.tip());
      // "Out" is the screen-horizontal direction the arrow leans towards; if it
      // points (nearly) straight at or away from the camera, pick either side.
      this.outward.crossVectors(UP, normal).normalize();
      const flat = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      if (flat.dot(this.outward) < 0) this.outward.negate();
    } else {
      this.plane.setFromNormalAndCoplanarPoint(UP, this.origin);
    }
    if (!ray.intersectPlane(this.plane, this.anchorHit)) return false;
    this.anchorFlat.set(this.raw.x, 0, this.raw.z);
    this.anchorOut = this.length * Math.cos(this.pitch);
    this.anchorUp = this.length * Math.sin(this.pitch);
    this.mode = mode;
    return true;
  }
}

/**
 * How far along the line from `origin` in `direction` its closest point to
 * `ray` is, or null if the ray runs (nearly) parallel to it.
 */
function closestAlongLine(origin: THREE.Vector3, direction: THREE.Vector3, ray: THREE.Ray) {
  const w = origin.clone().sub(ray.origin);
  const b = direction.dot(ray.direction);
  const denominator = 1 - b * b;
  if (denominator < 1e-4) return null;
  return (b * ray.direction.dot(w) - direction.dot(w)) / denominator;
}


/** Yaw is measured about +Y from +Z towards +X, matching getEntityWorldYaw. */
function yawOf(v: THREE.Vector3) {
  return Math.atan2(v.x, v.z);
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
