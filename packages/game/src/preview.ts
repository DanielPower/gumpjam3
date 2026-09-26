import type { Box3DModule, b3BodyId, b3Vec3 } from "box3d.js";
import * as THREE from "three";
import { syncObjectToBody } from "./box3d-three";
import { createSimulation, TIME_STEP, type Placement } from "@stairs/shared/simulation";
import type { TrenchBroomMap } from "@stairs/shared/trenchbroom-map";

const PREVIEW_SECONDS = 2;
const SAMPLE_EVERY = 2;
const HEAD_BONE = 5;
const PELVIS_BONE = 0;

export type TrajectoryPreview = {
  readonly object3d: THREE.Object3D;
  /** Simulate `placements` ahead and redraw the paths and final ghost pose. */
  update(placements: readonly Placement[]): void;
};

/**
 * Predicts what a setup will do. The engine is deterministic, so simulating the
 * same placements in a scratch world gives exactly what pressing Go! will.
 */
export function createTrajectoryPreview(
  b3: Box3DModule,
  map: TrenchBroomMap,
  ragdollMeshes: readonly THREE.Object3D[],
): TrajectoryPreview {
  const object3d = new THREE.Group();
  object3d.name = "Trajectory preview";

  const trailMaterials = {
    head: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    pelvis: new THREE.LineBasicMaterial({ color: 0x7fb2ff, transparent: true, opacity: 0.85 }),
    prop: new THREE.LineBasicMaterial({ color: 0xd9a066, transparent: true, opacity: 0.85 }),
  };
  const trails = new THREE.Group();
  object3d.add(trails);

  // A translucent copy of the ragdoll, posed where it will be at the end.
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const ghost = ragdollMeshes.map((bone) => {
    const copy = bone.clone();
    copy.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = ghostMaterial;
        child.castShadow = child.receiveShadow = false;
      }
    });
    object3d.add(copy);
    return copy;
  });

  const update = (placements: readonly Placement[]) => {
    const simulation = createSimulation(b3, map, placements);
    simulation.applyForces();

    const tracked: [b3BodyId, THREE.LineBasicMaterial][] = [
      [simulation.ragdoll[HEAD_BONE], trailMaterials.head],
      [simulation.ragdoll[PELVIS_BONE], trailMaterials.pelvis],
      ...[...simulation.props.values()].map((body): [b3BodyId, THREE.LineBasicMaterial] => [body, trailMaterials.prop]),
    ];
    const points = tracked.map(() => [] as THREE.Vector3[]);
    const p: b3Vec3 = [0, 0, 0];
    const sample = () =>
      tracked.forEach(([body], i) => points[i].push(new THREE.Vector3(...b3.b3Body_GetPosition(p, body))));

    sample();
    const steps = Math.round(PREVIEW_SECONDS / TIME_STEP);
    for (let step = 1; step <= steps; step++) {
      simulation.step();
      if (step % SAMPLE_EVERY === 0 || step === steps) sample();
    }

    simulation.ragdoll.forEach((body, bone) => syncObjectToBody(b3, body, ghost[bone]));
    simulation.destroy();

    for (const line of trails.children as THREE.Line[]) line.geometry.dispose();
    trails.clear();
    tracked.forEach(([, material], i) => {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points[i]), material);
      line.frustumCulled = false;
      trails.add(line);
    });
  };

  return { object3d, update };
}
