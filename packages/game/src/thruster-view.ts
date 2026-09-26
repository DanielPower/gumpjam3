import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const CANISTER_RADIUS = 0.06;
const CANISTER_HEIGHT = 0.18;
const NOZZLE_HEIGHT = 0.06;
const FLAME_LENGTH = 0.5;

// Unit parts, stacked along +Y (the surface's outward normal) from the surface.
const plateGeometry = new THREE.CylinderGeometry(CANISTER_RADIUS * 1.3, CANISTER_RADIUS * 1.3, 0.02, 16).translate(0, 0.01, 0);
const canisterGeometry = new THREE.CylinderGeometry(CANISTER_RADIUS, CANISTER_RADIUS, CANISTER_HEIGHT, 16).translate(0, CANISTER_HEIGHT / 2, 0);
const nozzleGeometry = new THREE.CylinderGeometry(CANISTER_RADIUS * 0.9, CANISTER_RADIUS * 0.5, NOZZLE_HEIGHT, 16)
  .translate(0, CANISTER_HEIGHT + NOZZLE_HEIGHT / 2, 0);
// The flame points out of the nozzle, away from the surface, one unit long (scaled to flicker).
const flameGeometry = new THREE.ConeGeometry(CANISTER_RADIUS * 0.9, 1, 16, 1, true).rotateX(Math.PI).translate(0, 0.5, 0);

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.35, metalness: 0.6 });
const selectedBodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0x806030, roughness: 0.35, metalness: 0.4 });
const stripeMaterial = new THREE.MeshStandardMaterial({ color: 0xe0452d, roughness: 0.5 });
const nozzleMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.7 });
const flameMaterial = new THREE.MeshBasicMaterial({
  color: 0xffa040,
  transparent: true,
  opacity: 0.9,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});
const coreMaterial = flameMaterial.clone();
coreMaterial.color.set(0xfff3c0);

function thrusterMesh(material: THREE.Material = bodyMaterial) {
  const group = new THREE.Group();
  const plate = new THREE.Mesh(plateGeometry, nozzleMaterial);
  const canister = new THREE.Mesh(canisterGeometry, material);
  const stripe = new THREE.Mesh(canisterGeometry, stripeMaterial);
  stripe.scale.set(1.04, 0.2, 1.04);
  stripe.position.y = CANISTER_HEIGHT * 0.45;
  const nozzle = new THREE.Mesh(nozzleGeometry, nozzleMaterial);
  for (const part of [plate, canister, stripe, nozzle]) part.castShadow = true;
  const flame = new THREE.Group();
  flame.position.y = CANISTER_HEIGHT + NOZZLE_HEIGHT;
  const outer = new THREE.Mesh(flameGeometry, flameMaterial);
  const core = new THREE.Mesh(flameGeometry, coreMaterial);
  core.scale.set(0.5, 0.6, 0.5);
  flame.add(outer, core);
  flame.visible = false;
  group.add(plate, canister, stripe, nozzle, flame);
  return { group, canister, flame };
}

type Thruster = ReturnType<typeof thrusterMesh>;

/** Draws thrusters stuck to things, their flames while they burn, and the one about to be placed. */
export class ThrusterView {
  readonly object3d = new THREE.Group();
  private thrusters: Thruster[] = [];
  private readonly preview: Thruster;
  private readonly previewMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false });

  constructor() {
    this.preview = thrusterMesh(this.previewMaterial);
    this.preview.group.visible = false;
    this.object3d.add(this.preview.group);
  }

  /** Have `count` thrusters. */
  setCount(count: number) {
    while (this.thrusters.length < count) {
      const thruster = thrusterMesh();
      this.thrusters.push(thruster);
      this.object3d.add(thruster.group);
    }
    for (const thruster of this.thrusters.splice(count)) thruster.group.removeFromParent();
  }

  /**
   * Put thruster `i` at `point` on a surface facing `normal` (both world
   * space), or hide it if what it's on has gone. A burning one flickers.
   */
  update(i: number, pose: { point: THREE.Vector3; normal: THREE.Vector3 } | null, burning: boolean, selected: boolean, time: number) {
    const thruster = this.thrusters[i];
    if (!thruster) return;
    thruster.group.visible = pose !== null;
    if (!pose) return;
    place(thruster.group, pose.point, pose.normal);
    thruster.canister.material = selected ? selectedBodyMaterial : bodyMaterial;
    thruster.flame.visible = burning;
    if (burning) {
      // A quick, irregular flicker, different for each thruster.
      const flicker = 0.75 + 0.25 * Math.sin(time * 53 + i * 1.7) * Math.sin(time * 31 + i);
      thruster.flame.scale.set(1, FLAME_LENGTH * flicker, 1);
    }
  }

  /** Show where a thruster would go, red if it can't; null hides it. */
  showPreview(pose: { point: THREE.Vector3; normal: THREE.Vector3 } | null, blocked = false) {
    this.preview.group.visible = pose !== null;
    if (!pose) return;
    place(this.preview.group, pose.point, pose.normal);
    this.previewMaterial.color.set(blocked ? 0xff4040 : 0xffffff);
  }

  /** The thruster under `raycaster`, or -1. */
  hit(raycaster: THREE.Raycaster) {
    const groups = this.thrusters.map((thruster) => thruster.group);
    const [hit] = raycaster.intersectObjects(groups.filter((group) => group.visible), true);
    if (!hit) return -1;
    let object: THREE.Object3D | null = hit.object;
    while (object && !groups.includes(object as THREE.Group)) object = object.parent;
    return object ? groups.indexOf(object as THREE.Group) : -1;
  }
}

function place(group: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3) {
  group.position.copy(point);
  group.quaternion.setFromUnitVectors(UP, normal.clone().normalize());
}
