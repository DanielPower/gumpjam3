import * as THREE from "three";
import { MAX_ARROW_LENGTH } from "./force-aim";

const SHAFT_RADIUS = 0.018;
const MAX_HEAD_LENGTH = 0.18;
const HANDLE_RADIUS = 0.045;
const GROUND_OFFSET = 0.01;
const X_RAY_OPACITY = 0.3;

// Unit geometry shared by every arrow and scaled per arrow. The shaft spans
// y = 0..1 and the cone ends at y = 0, so the cone sits at the arrow's tip.
const shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0);
const coneGeometry = new THREE.ConeGeometry(1, 1, 20).translate(0, -0.5, 0);
const handleGeometry = new THREE.SphereGeometry(HANDLE_RADIUS, 16, 12);

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export type ArrowPart = "head" | "tail" | "shaft";

/** Weak arrows are yellow, strong ones red. */
export function strengthColor(length: number, target = new THREE.Color()) {
  const t = THREE.MathUtils.clamp(length / MAX_ARROW_LENGTH, 0, 1);
  return target.setHSL(0.15 * (1 - t), 0.95, 0.55);
}

function lineBetween(material: THREE.LineBasicMaterial) {
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  return line;
}

function setLine(line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3) {
  const position = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  position.setXYZ(0, a.x, a.y, a.z);
  position.setXYZ(1, b.x, b.y, b.z);
  position.needsUpdate = true;
  if (line.material instanceof THREE.LineDashedMaterial) line.computeLineDistances();
}

/**
 * A solid, lit 3D arrow with depth cues: a faint x-ray copy so it stays visible
 * behind the ragdoll, a dashed drop line from the tip to the ground, and the
 * arrow's shadow projected straight down onto the ground.
 */
export class ForceArrow {
  readonly object3d = new THREE.Group();
  readonly headHandle: THREE.Mesh;
  readonly tailHandle: THREE.Mesh;

  private readonly body = new THREE.Group();
  private readonly shaft: THREE.Mesh;
  private readonly cone: THREE.Mesh;
  private readonly material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
  private readonly xRayMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: X_RAY_OPACITY,
    depthTest: false,
    depthWrite: false,
  });
  private readonly handleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  private readonly dropMaterial = new THREE.LineDashedMaterial({
    color: 0xffffff,
    dashSize: 0.06,
    gapSize: 0.04,
    transparent: true,
    opacity: 0.6,
  });
  private readonly shadowMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 });
  private readonly dropLine = lineBetween(this.dropMaterial);
  private readonly shadowLine = lineBetween(this.shadowMaterial);
  private readonly groundRay = new THREE.Raycaster();

  private readonly ground: THREE.Object3D;

  constructor(ground: THREE.Object3D) {
    this.ground = ground;
    this.shaft = new THREE.Mesh(shaftGeometry, this.material);
    this.cone = new THREE.Mesh(coneGeometry, this.material);
    const xRayShaft = new THREE.Mesh(shaftGeometry, this.xRayMaterial);
    const xRayCone = new THREE.Mesh(coneGeometry, this.xRayMaterial);
    xRayShaft.renderOrder = xRayCone.renderOrder = 2000;
    this.shaft.add(xRayShaft);
    this.cone.add(xRayCone);
    this.body.add(this.shaft, this.cone);

    this.headHandle = new THREE.Mesh(handleGeometry, this.handleMaterial);
    this.tailHandle = new THREE.Mesh(handleGeometry, this.handleMaterial);
    this.headHandle.renderOrder = this.tailHandle.renderOrder = 2001;

    this.object3d.add(this.body, this.headHandle, this.tailHandle, this.dropLine, this.shadowLine);
    this.setState({ selected: false });
  }

  set(origin: THREE.Vector3, vector: THREE.Vector3) {
    const length = vector.length();
    const head = Math.min(MAX_HEAD_LENGTH, length * 0.45);
    const headRadius = head * 0.4;

    this.body.position.copy(origin);
    if (length > 0) this.body.quaternion.setFromUnitVectors(UP, vector.clone().divideScalar(length));
    this.shaft.scale.set(SHAFT_RADIUS, Math.max(length - head, 1e-4), SHAFT_RADIUS);
    this.cone.position.y = length;
    this.cone.scale.set(headRadius, Math.max(head, 1e-4), headRadius);

    const color = strengthColor(length);
    this.material.color.copy(color);
    this.material.emissive.copy(color).multiplyScalar(0.25);
    this.xRayMaterial.color.copy(color);

    const tip = origin.clone().add(vector);
    this.tailHandle.position.copy(origin);
    this.headHandle.position.copy(tip);

    const groundTip = this.groundBelow(tip);
    const groundTail = this.groundBelow(origin);
    this.dropLine.visible = groundTip !== null;
    this.shadowLine.visible = groundTip !== null && groundTail !== null;
    if (groundTip) setLine(this.dropLine, tip, groundTip);
    if (groundTip && groundTail) setLine(this.shadowLine, groundTail, groundTip);
    this.object3d.updateMatrixWorld(true);
  }

  setState({ selected }: { selected: boolean }) {
    this.headHandle.visible = this.tailHandle.visible = selected;
    this.material.emissiveIntensity = selected ? 2.5 : 1;
    this.dropMaterial.opacity = selected ? 0.9 : 0.45;
  }

  /** Which part of this arrow `raycaster` hits, preferring handles, then the head. */
  hitTest(raycaster: THREE.Raycaster): { part: ArrowPart; distance: number } | null {
    const parts: [THREE.Object3D, ArrowPart][] = [
      [this.cone, "head"],
      [this.shaft, "shaft"],
    ];
    if (this.headHandle.visible) parts.unshift([this.tailHandle, "tail"], [this.headHandle, "head"]);
    for (const [object, part] of parts) {
      const [hit] = raycaster.intersectObject(object, false);
      if (hit) return { part, distance: hit.distance };
    }
    return null;
  }

  dispose() {
    this.object3d.removeFromParent();
    for (const m of [this.material, this.xRayMaterial, this.handleMaterial, this.dropMaterial, this.shadowMaterial]) {
      m.dispose();
    }
    this.dropLine.geometry.dispose();
    this.shadowLine.geometry.dispose();
  }

  private groundBelow(point: THREE.Vector3) {
    this.groundRay.set(point, DOWN);
    const [hit] = this.groundRay.intersectObject(this.ground, true);
    return hit ? hit.point.add(new THREE.Vector3(0, GROUND_OFFSET, 0)) : null;
  }
}
