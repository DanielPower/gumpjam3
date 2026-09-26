import * as THREE from "three";

type Pose = { position: THREE.Vector3; quaternion: THREE.Quaternion };

const poseOf = (object: THREE.Object3D): Pose => ({
  position: object.position.clone(),
  quaternion: object.quaternion.clone(),
});

/**
 * Smooths objects moved by fixed-rate physics on screens that refresh at other
 * rates: each is drawn partway between its poses after the last two steps.
 *
 * Per step: `beginStep()`, step the physics and move the objects to their
 * bodies, then `capture()` them. Per frame: `apply()` with how far it is
 * through the next step.
 */
export class PoseInterpolator {
  private readonly poses = new Map<THREE.Object3D, { from: Pose; to: Pose }>();

  /** The poses captured after the last step become the ones to ease from. */
  beginStep() {
    for (const pose of this.poses.values()) {
      pose.from.position.copy(pose.to.position);
      pose.from.quaternion.copy(pose.to.quaternion);
    }
  }

  /** Record where objects are after a step. New ones start without easing. */
  capture(objects: Iterable<THREE.Object3D>) {
    for (const object of objects) {
      const pose = this.poses.get(object);
      if (pose) {
        pose.to.position.copy(object.position);
        pose.to.quaternion.copy(object.quaternion);
      } else {
        this.poses.set(object, { from: poseOf(object), to: poseOf(object) });
      }
    }
  }

  /** Place every object `alpha` (0–1) of the way from its previous pose to its latest. */
  apply(alpha: number) {
    for (const [object, { from, to }] of this.poses) {
      object.position.lerpVectors(from.position, to.position, alpha);
      object.quaternion.slerpQuaternions(from.quaternion, to.quaternion, alpha);
    }
  }

  /** Forget everything, e.g. when the objects are rebuilt or reset. */
  clear() {
    this.poses.clear();
  }
}
