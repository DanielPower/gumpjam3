import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/Addons.js";

/** Time constant for following the ragdoll; higher is lazier. */
const FOLLOW_LAG_SECONDS = 0.2;
const TRANSITION_SECONDS = 1;
/** Orthographic ends of a transition use a field of view this narrow, which is nearly indistinguishable. */
const NEAR_ORTHOGRAPHIC_FOV = 5;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export type CameraView = { target: THREE.Vector3; position: THREE.Vector3 };

/** An orthographic view to transition to or from: what it's centred on, and how much it shows. */
export type OrthographicView = {
  focus: THREE.Vector3;
  /** World height visible at the focus, in metres. */
  viewHeight: number;
  /** From the focus towards the camera. */
  direction: THREE.Vector3;
};

/** A perspective camera pose, described by what it frames rather than where it sits. */
type Pose = {
  focus: THREE.Vector3;
  /** From the focus towards the camera. */
  direction: THREE.Vector3;
  /** World height visible at the focus, in metres. */
  height: number;
  fov: number;
};

const distanceFor = (pose: Pose) => pose.height / 2 / Math.tan(THREE.MathUtils.degToRad(pose.fov / 2));

const nearOrthographic = (view: OrthographicView): Pose => ({
  focus: view.focus.clone(),
  direction: view.direction.clone().normalize(),
  height: view.viewHeight,
  fov: NEAR_ORTHOGRAPHIC_FOV,
});

/**
 * Orbit camera for runs, anchored to a point (usually the ragdoll): orbit and
 * zoom only, no panning. The anchor smoothly follows a moving point, carrying
 * the camera along so the player's orbit angle and zoom persist. It can also
 * ease between itself and an orthographic view, via a very narrow perspective
 * that looks nearly orthographic, so switching cameras doesn't jump.
 */
export class CameraRig {
  readonly controls: OrbitControls;
  private readonly camera: THREE.PerspectiveCamera;
  private followPoint: THREE.Vector3 | null = null;
  private readonly baseFov: number;
  private transition: {
    from: Pose;
    /** Evaluated every frame, so a transition can end on a moving target. */
    to: () => Pose;
    elapsed: number;
    onDone?: () => void;
  } | null = null;
  /** What the camera is framing mid-transition. */
  private transitionFocus: THREE.Vector3 | null = null;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.baseFov = camera.fov;
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

  /** Jump straight to a view, e.g. for the start of a run. Cancels any transition. */
  setView(view: CameraView) {
    this.transition = null;
    this.transitionFocus = null;
    this.setFov(this.baseFov);
    this.controls.target.copy(view.target);
    this.camera.position.copy(view.position);
    this.controls.update();
  }

  /** Follow a moving point each frame (pass null to stop). */
  follow(point: THREE.Vector3 | null) {
    this.followPoint = point?.clone() ?? null;
  }

  /** True while easing between views. */
  get transitioning() {
    return this.transition !== null;
  }

  /** The current view as an orthographic one: its focus, direction, and framed height. */
  get orthographicView(): OrthographicView {
    const pose = this.currentPose();
    return { focus: pose.focus, direction: pose.direction, viewHeight: pose.height };
  }

  /**
   * Ease into an orbit view (the start of a run), gliding over to the target as
   * it keeps following. Starts from the orthographic view `from`, nearly
   * orthographic, or from wherever the camera is if it's already mid-transition.
   * Orbit input is ignored until it's done.
   */
  transitionInto(view: CameraView, from: OrthographicView) {
    const start = this.transition ? this.currentPose() : nearOrthographic(from);
    this.setView(view);
    const endOffset = this.camera.position.clone().sub(this.controls.target);
    const endDistance = endOffset.length();
    this.start(start, () => ({
      focus: this.controls.target.clone(),
      direction: endOffset.clone().divideScalar(endDistance),
      height: 2 * endDistance * Math.tan(THREE.MathUtils.degToRad(this.baseFov / 2)),
      fov: this.baseFov,
    }), () => {
      this.camera.position.copy(this.controls.target).add(endOffset);
      this.controls.enabled = true;
      this.controls.update();
    });
  }

  /**
   * Ease from wherever the camera is now (even mid-transition) into an
   * orthographic view, narrowing towards orthographic. `onDone` runs at the end,
   * when the caller should switch to its orthographic camera.
   */
  transitionTo(to: OrthographicView, onDone: () => void) {
    const target = nearOrthographic(to);
    this.start(this.currentPose(), () => target, onDone);
  }

  update(dt: number) {
    const { target } = this.controls;
    if (this.followPoint) {
      const smoothing = 1 - Math.exp(-dt / FOLLOW_LAG_SECONDS);
      const delta = this.followPoint.clone().sub(target).multiplyScalar(smoothing);
      target.add(delta);
      this.camera.position.add(delta);
    }

    if (this.transition) this.applyTransition(dt);
    else this.controls.update();
  }

  private start(from: Pose, to: () => Pose, onDone?: () => void) {
    this.transition = { from, to, elapsed: 0, onDone };
    this.controls.enabled = false;
  }

  private currentPose(): Pose {
    const focus = (this.transitionFocus ?? this.controls.target).clone();
    const offset = this.camera.position.clone().sub(focus);
    const distance = offset.length();
    return {
      focus,
      direction: offset.divideScalar(distance),
      height: 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)),
      fov: this.camera.fov,
    };
  }

  private applyTransition(dt: number) {
    const transition = this.transition!;
    transition.elapsed += dt;
    const k = easeInOut(Math.min(transition.elapsed / TRANSITION_SECONDS, 1));
    const { from } = transition;
    const to = transition.to();

    // The framed height changes in log space so the zoom feels even; the camera
    // backs off or closes in to keep that height framed as the FOV changes.
    const pose: Pose = {
      focus: from.focus.clone().lerp(to.focus, k),
      direction: from.direction.clone().lerp(to.direction, k).normalize(),
      height: Math.exp(THREE.MathUtils.lerp(Math.log(from.height), Math.log(to.height), k)),
      fov: THREE.MathUtils.lerp(from.fov, to.fov, k),
    };
    this.setFov(pose.fov);
    this.camera.position.copy(pose.focus).addScaledVector(pose.direction, distanceFor(pose));
    this.camera.lookAt(pose.focus);
    this.transitionFocus = pose.focus;

    if (k >= 1) {
      const { onDone } = transition;
      this.transition = null;
      this.transitionFocus = null;
      this.setFov(this.baseFov);
      onDone?.();
    }
  }

  private setFov(fov: number) {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
}
