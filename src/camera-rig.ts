import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/Addons.js";

const GLIDE_SECONDS = 0.35;
/** Time constant for following the ragdoll; higher is lazier. */
const FOLLOW_LAG_SECONDS = 0.2;

export type CameraView = { target: THREE.Vector3; position: THREE.Vector3 };

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Orbit camera anchored to a point (usually the ragdoll): orbit and zoom only,
 * no panning. The anchor can glide to a new point, or smoothly follow a moving
 * one, carrying the camera along so the player's orbit angle and zoom persist.
 */
export class CameraRig {
  readonly controls: OrbitControls;
  private readonly camera: THREE.PerspectiveCamera;
  private glide: { from: CameraView; to: CameraView; elapsed: number } | null = null;
  private followPoint: THREE.Vector3 | null = null;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    const controls = new OrbitControls(camera, domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 1;
    controls.maxDistance = 25;
    // Stop just past horizontal so the camera can't orbit under the floor.
    controls.maxPolarAngle = Math.PI * 0.52;
    this.controls = controls;
  }

  get view(): CameraView {
    return { target: this.controls.target.clone(), position: this.camera.position.clone() };
  }

  /** Jump straight to a view, e.g. for the initial framing. */
  setView(view: CameraView) {
    this.glide = null;
    this.controls.target.copy(view.target);
    this.camera.position.copy(view.position);
    this.controls.update();
  }

  /** Glide the anchor to `point`, keeping the current orbit angle and zoom. */
  focusOn(point: THREE.Vector3) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.glideTo({ target: point.clone(), position: point.clone().add(offset) });
  }

  glideTo(view: CameraView) {
    this.followPoint = null;
    this.glide = { from: this.view, to: view, elapsed: 0 };
  }

  /** Follow a moving point each frame (pass null to stop). */
  follow(point: THREE.Vector3 | null) {
    if (point) this.glide = null;
    this.followPoint = point?.clone() ?? null;
  }

  update(dt: number) {
    const { target } = this.controls;
    if (this.glide) {
      const glide = this.glide;
      glide.elapsed += dt;
      const k = easeInOut(Math.min(glide.elapsed / GLIDE_SECONDS, 1));
      target.lerpVectors(glide.from.target, glide.to.target, k);
      this.camera.position.lerpVectors(glide.from.position, glide.to.position, k);
      if (k >= 1) this.glide = null;
    } else if (this.followPoint) {
      const smoothing = 1 - Math.exp(-dt / FOLLOW_LAG_SECONDS);
      const delta = this.followPoint.clone().sub(target).multiplyScalar(smoothing);
      target.add(delta);
      this.camera.position.add(delta);
    }
    this.controls.update();
  }
}
