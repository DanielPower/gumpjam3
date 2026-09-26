import * as THREE from "three";
import type { Box3DModule } from "box3d.js";
import {
  BARREL_HEIGHT,
  BARREL_RADIUS,
  MINE_BLAST,
  type Explosion,
  type MinePlacement,
  type Placement,
  type Simulation,
} from "@stairs/shared/simulation";
import { syncObjectToBody } from "./box3d-three";

const MINE_RADIUS = 0.22;
const MINE_THICKNESS = 0.07;
const EXPLOSION_SECONDS = 0.6;
const UP = new THREE.Vector3(0, 1, 0);

const mineBodyMaterial = new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.6, metalness: 0.4 });
const mineLightMaterial = new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 1.5 });
const selectedMineMaterial = new THREE.MeshStandardMaterial({ color: 0x6a7078, emissive: 0x806030, roughness: 0.6 });
const barrelMaterial = new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.55, metalness: 0.2 });
const bandMaterial = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
const lidMaterial = new THREE.MeshStandardMaterial({ color: 0x2c2c2c, roughness: 0.7 });

const mineGeometry = new THREE.CylinderGeometry(MINE_RADIUS, MINE_RADIUS * 1.1, MINE_THICKNESS, 20);
const mineLightGeometry = new THREE.SphereGeometry(0.05, 12, 8);
const barrelGeometry = new THREE.CylinderGeometry(BARREL_RADIUS, BARREL_RADIUS, BARREL_HEIGHT, 20);
const bandGeometry = new THREE.CylinderGeometry(BARREL_RADIUS * 1.02, BARREL_RADIUS * 1.02, 0.14, 20);
const lidGeometry = new THREE.CylinderGeometry(BARREL_RADIUS * 0.95, BARREL_RADIUS * 0.95, 0.02, 20);

function mineMesh(material: THREE.Material = mineBodyMaterial) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(mineGeometry, material);
  body.position.y = MINE_THICKNESS / 2 - 0.04;
  body.castShadow = body.receiveShadow = true;
  const light = new THREE.Mesh(mineLightGeometry, mineLightMaterial);
  light.position.y = MINE_THICKNESS - 0.03;
  group.add(body, light);
  return group;
}

function barrelMesh() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(barrelGeometry, barrelMaterial);
  for (const y of [-0.22, 0.22]) {
    const band = new THREE.Mesh(bandGeometry, bandMaterial);
    band.position.y = y;
    group.add(band);
  }
  const lid = new THREE.Mesh(lidGeometry, lidMaterial);
  lid.position.y = BARREL_HEIGHT / 2;
  body.castShadow = body.receiveShadow = true;
  group.add(body, lid);
  return group;
}

/** Orient an object so its +Y points along `normal`. */
function place(object: THREE.Object3D, position: THREE.Vector3Tuple, normal: THREE.Vector3Tuple) {
  object.position.set(...position);
  object.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...normal).normalize());
}

type Effect = { group: THREE.Group; fireball: THREE.Mesh; ring: THREE.Mesh; light: THREE.PointLight; radius: number; age: number };

/**
 * Everything visual about explosives: the player's mines, the level's barrels,
 * the mine placement preview, and explosion effects.
 */
export class ExplosivesView {
  private readonly scene: THREE.Scene;
  private readonly b3: Box3DModule;
  private readonly mines = new Map<number, THREE.Group>();
  private barrels: THREE.Group[] = [];
  private readonly effects: Effect[] = [];
  private readonly preview: THREE.Group;
  private readonly previewRadius: THREE.Mesh;
  private readonly previewMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false });

  constructor(scene: THREE.Scene, b3: Box3DModule) {
    this.scene = scene;
    this.b3 = b3;
    this.preview = mineMesh(this.previewMaterial);
    // The blast radius, drawn as a faint sphere so players can plan chains.
    this.previewRadius = new THREE.Mesh(
      new THREE.SphereGeometry(MINE_BLAST.radius, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xff8030, transparent: true, opacity: 0.08, depthWrite: false }),
    );
    this.preview.add(this.previewRadius);
    this.preview.visible = false;
    scene.add(this.preview);
  }

  /** Rebuild mine and barrel meshes for a fresh simulation. */
  rebuild(simulation: Simulation, placements: readonly Placement[]) {
    for (const mesh of this.mines.values()) mesh.removeFromParent();
    this.mines.clear();
    for (const placement of placements) {
      if (placement.kind !== "mine") continue;
      const mesh = mineMesh();
      place(mesh, placement.position, placement.normal);
      mesh.userData.mineId = placement.id;
      this.mines.set(placement.id, mesh);
      this.scene.add(mesh);
    }
    for (const mesh of this.barrels) mesh.removeFromParent();
    this.barrels = simulation.barrels.map(() => {
      const mesh = barrelMesh();
      this.scene.add(mesh);
      return mesh;
    });
    for (const effect of this.effects.splice(0)) effect.group.removeFromParent();
    this.sync(simulation);
  }

  /** Follow the barrels' bodies, and hide anything that has gone off. */
  sync(simulation: Simulation) {
    this.barrels.forEach((mesh, index) => {
      const gone = simulation.detonated({ kind: "barrel", index });
      mesh.visible = !gone;
      if (!gone) syncObjectToBody(this.b3, simulation.barrels[index], mesh);
    });
    for (const [id, mesh] of this.mines) mesh.visible = !simulation.detonated({ kind: "mine", id });
  }

  highlight(mineId: number | null) {
    for (const [id, mesh] of this.mines) {
      (mesh.children[0] as THREE.Mesh).material = id === mineId ? selectedMineMaterial : mineBodyMaterial;
    }
  }

  /** The id of the mine under `raycaster`, if any. */
  hitMine(raycaster: THREE.Raycaster): number | null {
    const [hit] = raycaster.intersectObjects([...this.mines.values()], true);
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object && object.userData.mineId === undefined) object = object.parent;
    return (object?.userData.mineId as number | undefined) ?? null;
  }

  showPreview(mine: Pick<MinePlacement, "position" | "normal"> | null, blocked = false) {
    this.preview.visible = mine !== null;
    if (!mine) return;
    place(this.preview, mine.position, mine.normal);
    this.previewMaterial.color.set(blocked ? 0xff4040 : 0xffffff);
    this.previewRadius.visible = !blocked;
  }

  explode(explosions: readonly Explosion[]) {
    for (const { position, radius } of explosions) {
      const group = new THREE.Group();
      group.position.set(...position);
      const fireball = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0xffb030, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1, 48),
        new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      const light = new THREE.PointLight(0xffa040, 40, radius * 3, 2);
      group.add(fireball, ring, light);
      this.scene.add(group);
      this.effects.push({ group, fireball, ring, light, radius, age: 0 });
    }
  }

  update(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.age += dt;
      const t = Math.min(effect.age / EXPLOSION_SECONDS, 1);
      const fade = 1 - t;
      // The fireball swells fast then fades; the shockwave ring races out to the blast radius.
      effect.fireball.scale.setScalar(effect.radius * 0.45 * Math.sqrt(t) + 0.2);
      (effect.fireball.material as THREE.MeshBasicMaterial).opacity = fade * fade;
      (effect.fireball.material as THREE.MeshBasicMaterial).color.setHSL(0.1 - 0.08 * t, 1, 0.6 - 0.3 * t);
      effect.ring.scale.setScalar(effect.radius * Math.min(1, t * 2.5));
      (effect.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 2);
      effect.light.intensity = 40 * fade * fade;
      if (t >= 1) {
        effect.group.removeFromParent();
        effect.fireball.geometry.dispose();
        effect.ring.geometry.dispose();
        (effect.fireball.material as THREE.Material).dispose();
        (effect.ring.material as THREE.Material).dispose();
        this.effects.splice(i, 1);
      }
    }
  }
}
