import * as THREE from "three";
import { MAX_ARROW_LENGTH } from "@stairs/shared/simulation";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { fatLineMaterial, fatLines, setSegment, strip } from "./fat-lines";

const SHAFT_RADIUS = 0.018;
const MAX_HEAD_LENGTH = 0.18;
/** Handles are drawn at a fixed size on screen, whatever the zoom (pixels). */
const HANDLE_PIXELS = 6;
/** Double-arrow handles: their length, and how far from the arrow they sit (pixels). */
const KNOB_PIXELS = 40;
const KNOB_OFFSET_PIXELS = 36;
const STRENGTH_COLOR = 0xffffff;
const TILT_COLOR = 0xff80ab;
/** The heading knob sits on a compass ring this far out from the base (pixels), behind the arrow so the shaft doesn't hide it. */
const COMPASS_PIXELS = 46;
const HEADING_COLOR = 0x4dd0e1;
const GROUND_OFFSET = 0.01;
const X_RAY_OPACITY = 0.3;

// Unit geometry shared by every arrow and scaled per arrow. The shaft spans
// y = 0..1 and the cone ends at y = 0, so the cone sits at the arrow's tip.
const shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0);
const coneGeometry = new THREE.ConeGeometry(1, 1, 20).translate(0, -0.5, 0);
const handleGeometry = new THREE.SphereGeometry(1, 16, 12);
// Flat double arrows along +Y, one unit long, showing which way a handle
// drags. They're turned to face the camera, pointing along the drag as seen.
const KNOB_OUTLINE = [
  [0, 0.5], [0.24, 0.24], [0.08, 0.24], [0.08, -0.24], [0.24, -0.24],
  [0, -0.5], [-0.24, -0.24], [-0.08, -0.24], [-0.08, 0.24], [-0.24, 0.24],
].map(([x, y]) => new THREE.Vector2(x, y));
const knobGeometry = new THREE.ShapeGeometry(new THREE.Shape(KNOB_OUTLINE));
const knobEdge = strip(KNOB_OUTLINE.map((p) => new THREE.Vector3(p.x, p.y, 0)), true);
const knobEdgeMaterial = fatLineMaterial({ color: 0x1a1a1a, opacity: 0.85, width: 2, overlay: true });

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export type ArrowPart = "head" | "tail" | "tilt" | "heading" | "shaft";

/** Weak arrows are yellow, strong ones red. */
export function strengthColor(length: number, target = new THREE.Color()) {
  const t = THREE.MathUtils.clamp(length / MAX_ARROW_LENGTH, 0, 1);
  return target.setHSL(0.15 * (1 - t), 0.95, 0.55);
}

const lineBetween = (material: ReturnType<typeof fatLineMaterial>) =>
  fatLines([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)], material);

function doubleArrow(material: THREE.Material) {
  const group = new THREE.Group();
  const fill = new THREE.Mesh(knobGeometry, material);
  const edge = fatLines(knobEdge, knobEdgeMaterial);
  fill.renderOrder = 2002;
  edge.renderOrder = 2003;
  group.add(fill, edge);
  return group;
}

/**
 * Turn a flat double arrow to face the camera (looking along `view`), with its
 * +Y along `axis` as it appears on screen. Left alone if `axis` points
 * straight at the camera.
 */
function faceCamera(knob: THREE.Object3D, axis: THREE.Vector3, view: THREE.Vector3) {
  const y = axis.clone().addScaledVector(view, -axis.dot(view));
  if (y.lengthSq() < 1e-6) return;
  y.normalize();
  const z = view.clone().negate();
  const x = new THREE.Vector3().crossVectors(y, z);
  knob.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * A solid, lit 3D arrow with depth cues: a faint x-ray copy so it stays visible
 * behind the ragdoll, a dashed drop line from the tip to the ground, and the
 * arrow's shadow projected straight down onto the ground.
 */
export class ForceArrow {
  readonly object3d = new THREE.Group();
  readonly tailHandle: THREE.Mesh;
  /**
   * Selected arrows' handles, each a double arrow showing the one thing it
   * changes: past the tip, along the arrow, for strength; beside the tip,
   * round the arc it tilts on, for tilt; and on a compass ring around the base,
   * round the ring (behind the arrow), for heading.
   */
  readonly strengthKnob: THREE.Group;
  readonly tiltKnob: THREE.Group;
  readonly headingKnob: THREE.Group;

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
  private readonly strengthMaterial = new THREE.MeshBasicMaterial({ color: STRENGTH_COLOR, depthTest: false });
  private readonly strengthStemMaterial = fatLineMaterial({ color: STRENGTH_COLOR, opacity: 0.7, width: 2, overlay: true });
  private readonly strengthStem = lineBetween(this.strengthStemMaterial);
  private readonly knobMaterial = new THREE.MeshBasicMaterial({ color: TILT_COLOR, depthTest: false });
  private readonly stemMaterial = fatLineMaterial({ color: TILT_COLOR, opacity: 0.8, width: 2, overlay: true });
  private readonly tiltStem = lineBetween(this.stemMaterial);
  private readonly headingMaterial = new THREE.MeshBasicMaterial({ color: HEADING_COLOR, depthTest: false });
  private readonly compassMaterial = fatLineMaterial({ color: HEADING_COLOR, opacity: 0.6, width: 2, overlay: true });
  private readonly compass: LineSegments2;
  private readonly origin = new THREE.Vector3();
  /** The arrow's heading, laid flat; kept when it points straight up or down. */
  private readonly heading = new THREE.Vector3(0, 0, 1);
  /** Which way the arrow points, and which way its tip moves as it tilts up. */
  private readonly direction = new THREE.Vector3(0, 1, 0);
  private readonly tiltUp = new THREE.Vector3(0, 1, 0);
  private readonly tip = new THREE.Vector3();
  private metresPerPixel = 0.01;
  /** Which way the camera looks, for turning the handles to face it. */
  private readonly view = new THREE.Vector3(0, 0, -1);
  private readonly dropMaterial = fatLineMaterial({ color: 0xffffff, opacity: 0.6, width: 2, dashed: { dashSize: 0.06, gapSize: 0.04 } });
  private readonly shadowMaterial = fatLineMaterial({ color: 0x000000, opacity: 0.55, width: 3 });
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

    this.tailHandle = new THREE.Mesh(handleGeometry, this.handleMaterial);
    this.tailHandle.renderOrder = 2001;
    this.strengthKnob = doubleArrow(this.strengthMaterial);
    this.tiltKnob = doubleArrow(this.knobMaterial);
    this.headingKnob = doubleArrow(this.headingMaterial);
    this.strengthStem.renderOrder = this.tiltStem.renderOrder = 2001;
    const circle: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) circle.push(new THREE.Vector3(Math.sin((i / 64) * 2 * Math.PI), 0, Math.cos((i / 64) * 2 * Math.PI)));
    this.compass = fatLines(strip(circle, true), this.compassMaterial);
    this.compass.renderOrder = 2000;

    this.object3d.add(
      this.body, this.tailHandle, this.strengthKnob, this.strengthStem, this.tiltKnob, this.tiltStem,
      this.headingKnob, this.compass, this.dropLine, this.shadowLine,
    );
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

    const tip = this.tip.copy(origin).add(vector);
    this.origin.copy(origin);
    const flat = new THREE.Vector3(vector.x, 0, vector.z);
    if (flat.lengthSq() > 1e-8) this.heading.copy(flat.normalize());
    if (length > 1e-8) this.direction.copy(vector).divideScalar(length);
    // Perpendicular to the arrow in its own vertical plane, towards up.
    const pitch = Math.atan2(this.direction.y, Math.hypot(this.direction.x, this.direction.z));
    this.tiltUp.copy(UP).multiplyScalar(Math.cos(pitch)).addScaledVector(this.heading, -Math.sin(pitch));
    this.tailHandle.position.copy(origin);
    this.placeHandles();

    const groundTip = this.groundBelow(tip);
    const groundTail = this.groundBelow(origin);
    this.dropLine.visible = groundTip !== null;
    this.shadowLine.visible = groundTip !== null && groundTail !== null;
    if (groundTip) setSegment(this.dropLine, tip, groundTip);
    if (groundTip && groundTail) setSegment(this.shadowLine, groundTail, groundTip);
    this.object3d.updateMatrixWorld(true);
  }

  /** Keep handles a constant size on screen, facing the camera: call when the view changes. */
  setView(metresPerPixel: number, camera: THREE.Camera) {
    const view = camera.getWorldDirection(new THREE.Vector3());
    if (metresPerPixel === this.metresPerPixel && view.equals(this.view)) return;
    this.metresPerPixel = metresPerPixel;
    this.view.copy(view);
    this.placeHandles();
    this.object3d.updateMatrixWorld(true);
  }

  private placeHandles() {
    const px = this.metresPerPixel;
    this.tailHandle.scale.setScalar(HANDLE_PIXELS * px);
    // The arrowhead itself is in the way, so the strength knob sits a bit further out.
    const knobs: [THREE.Group, LineSegments2 | null, THREE.Vector3, THREE.Vector3, number][] = [
      [this.strengthKnob, this.strengthStem, this.tip, this.direction, KNOB_OFFSET_PIXELS + 6],
      [this.tiltKnob, this.tiltStem, this.tip, this.tiltUp, KNOB_OFFSET_PIXELS],
    ];
    for (const [knob, stem, from, axis, offset] of knobs) {
      knob.scale.setScalar(KNOB_PIXELS * px);
      knob.position.copy(from).addScaledVector(axis, offset * px);
      faceCamera(knob, axis, this.view);
      if (stem) setSegment(stem, from, knob.position.clone().addScaledVector(axis, -0.5 * KNOB_PIXELS * px));
    }
    this.headingKnob.scale.setScalar(KNOB_PIXELS * px);
    this.headingKnob.position.copy(this.origin).addScaledVector(this.heading, -COMPASS_PIXELS * px);
    faceCamera(this.headingKnob, new THREE.Vector3().crossVectors(UP, this.heading), this.view);
    this.compass.position.copy(this.origin);
    this.compass.scale.setScalar(COMPASS_PIXELS * px);
  }

  setState({ selected }: { selected: boolean }) {
    this.tailHandle.visible = selected;
    this.strengthKnob.visible = this.strengthStem.visible = selected;
    this.tiltKnob.visible = this.tiltStem.visible = selected;
    this.headingKnob.visible = this.compass.visible = selected;
    this.material.emissiveIntensity = selected ? 2.5 : 1;
    this.dropMaterial.opacity = selected ? 0.9 : 0.45;
  }

  /**
   * Which part of this arrow `raycaster` hits, preferring handles, then the
   * head. Handles are picked within `pickPixels` of the pointer, so they're easy
   * to grab (and bigger for fingers) at any zoom.
   */
  hitTest(raycaster: THREE.Raycaster, pickPixels: number): { part: ArrowPart; distance: number } | null {
    if (this.tailHandle.visible) {
      const handles: [THREE.Vector3, ArrowPart][] = [
        [this.tiltKnob.position, "tilt"],
        [this.headingKnob.position, "heading"],
        [this.strengthKnob.position, "head"],
        [this.tailHandle.position, "tail"],
      ];
      const reach = pickPixels * this.metresPerPixel;
      for (const [position, part] of handles) {
        if (raycaster.ray.distanceToPoint(position) <= reach) {
          return { part, distance: raycaster.ray.origin.distanceTo(position) };
        }
      }
    }
    const parts: [THREE.Object3D, ArrowPart][] = [
      [this.cone, "head"],
      [this.shaft, "shaft"],
    ];
    for (const [object, part] of parts) {
      const [hit] = raycaster.intersectObject(object, false);
      if (hit) return { part, distance: hit.distance };
    }
    return null;
  }

  dispose() {
    this.object3d.removeFromParent();
    for (const m of [
      this.material, this.xRayMaterial, this.handleMaterial, this.strengthMaterial, this.strengthStemMaterial,
      this.knobMaterial, this.stemMaterial,
      this.headingMaterial, this.compassMaterial, this.dropMaterial, this.shadowMaterial,
    ]) {
      m.dispose();
    }
    this.dropLine.geometry.dispose();
    this.tiltStem.geometry.dispose();
    this.strengthStem.geometry.dispose();
    this.compass.geometry.dispose();
    this.shadowLine.geometry.dispose();
  }

  private groundBelow(point: THREE.Vector3) {
    this.groundRay.set(point, DOWN);
    const [hit] = this.groundRay.intersectObject(this.ground, true);
    return hit ? hit.point.add(new THREE.Vector3(0, GROUND_OFFSET, 0)) : null;
  }
}
