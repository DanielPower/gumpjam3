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
const KNOB_OFFSET_PIXELS = 42;
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
// Handles that swing round a pivot are bent slightly round it, curving about a
// centre on their -X side.
const KNOB_BEND_RADIUS = 1.1;

function knobOutline(curved: boolean) {
  const [tip, headBase, head, shaft] = [0.5, 0.24, 0.24, 0.08];
  // A point `along` the arrow and `across` it, bent round the centre if curved.
  const at = (along: number, across: number) => {
    if (!curved) return new THREE.Vector2(across, along);
    const angle = along / KNOB_BEND_RADIUS;
    const radius = KNOB_BEND_RADIUS + across;
    return new THREE.Vector2(radius * Math.cos(angle) - KNOB_BEND_RADIUS, radius * Math.sin(angle));
  };
  const shaftSide = (across: number, from: number, to: number) =>
    Array.from({ length: 9 }, (_, i) => at(from + ((to - from) * i) / 8, across));
  return [
    at(tip, 0), at(headBase, head), ...shaftSide(shaft, headBase, -headBase), at(-headBase, head),
    at(-tip, 0), at(-headBase, -head), ...shaftSide(-shaft, -headBase, headBase), at(headBase, -head),
  ];
}

const knobShapes = [false, true].map((curved) => {
  const outline = knobOutline(curved);
  return {
    geometry: new THREE.ShapeGeometry(new THREE.Shape(outline)),
    edge: strip(outline.map((p) => new THREE.Vector3(p.x, p.y, 0)), true),
  };
});
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

function doubleArrow(material: THREE.Material, curved = false) {
  const { geometry, edge: edgePoints } = knobShapes[curved ? 1 : 0];
  const group = new THREE.Group();
  const fill = new THREE.Mesh(geometry, material);
  const edge = fatLines(edgePoints, knobEdgeMaterial);
  fill.renderOrder = 2002;
  edge.renderOrder = 2003;
  group.add(fill, edge);
  return group;
}

/**
 * Turn a flat double arrow to face the camera (looking along `view`), with its
 * +Y along `axis` as it appears on screen, and a curved one bending round
 * `pivot`. Left alone if `axis` points straight at the camera.
 */
function faceCamera(knob: THREE.Object3D, axis: THREE.Vector3, view: THREE.Vector3, pivot?: THREE.Vector3) {
  const y = axis.clone().addScaledVector(view, -axis.dot(view));
  if (y.lengthSq() < 1e-6) return;
  y.normalize();
  const z = view.clone().negate();
  const x = new THREE.Vector3().crossVectors(y, z);
  // Turn it half round (it's symmetric along Y) so its bend faces the pivot.
  if (pivot && pivot.clone().sub(knob.position).dot(x) > 0) {
    x.negate();
    y.negate();
  }
  knob.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * A solid, lit 3D arrow with depth cues: a faint x-ray copy so it stays visible
 * behind the ragdoll, and a dashed drop line from the tip to the ground.
 */
export class ForceArrow {
  readonly object3d = new THREE.Group();
  readonly tailHandle: THREE.Mesh;
  /**
   * Selected arrows' handles, each a double arrow showing the one thing it
   * changes: past the tip, along the arrow, for strength; across the tip,
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
  private readonly dropLine = lineBetween(this.dropMaterial);
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
    this.tiltKnob = doubleArrow(this.knobMaterial, true);
    this.headingKnob = doubleArrow(this.headingMaterial, true);
    this.strengthStem.renderOrder = 2001;
    const circle: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) circle.push(new THREE.Vector3(Math.sin((i / 64) * 2 * Math.PI), 0, Math.cos((i / 64) * 2 * Math.PI)));
    this.compass = fatLines(strip(circle, true), this.compassMaterial);
    this.compass.renderOrder = 2000;

    this.object3d.add(
      this.body, this.tailHandle, this.strengthKnob, this.strengthStem, this.tiltKnob,
      this.headingKnob, this.compass, this.dropLine,
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
    this.dropLine.visible = groundTip !== null;
    if (groundTip) setSegment(this.dropLine, tip, groundTip);
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
    for (const knob of [this.strengthKnob, this.tiltKnob, this.headingKnob]) knob.scale.setScalar(KNOB_PIXELS * px);
    // Past the tip, clear of the arrowhead, on a stem.
    this.strengthKnob.position.copy(this.tip).addScaledVector(this.direction, KNOB_OFFSET_PIXELS * px);
    faceCamera(this.strengthKnob, this.direction, this.view);
    setSegment(this.strengthStem, this.tip, this.strengthKnob.position.clone().addScaledVector(this.direction, -0.5 * KNOB_PIXELS * px));
    // Across the tip, along the arc it tilts on.
    this.tiltKnob.position.copy(this.tip);
    faceCamera(this.tiltKnob, this.tiltUp, this.view, this.origin);
    this.headingKnob.position.copy(this.origin).addScaledVector(this.heading, -COMPASS_PIXELS * px);
    faceCamera(this.headingKnob, new THREE.Vector3().crossVectors(UP, this.heading), this.view, this.origin);
    this.compass.position.copy(this.origin);
    this.compass.scale.setScalar(COMPASS_PIXELS * px);
  }

  setState({ selected }: { selected: boolean }) {
    this.tailHandle.visible = selected;
    this.strengthKnob.visible = this.strengthStem.visible = selected;
    this.tiltKnob.visible = selected;
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
      this.knobMaterial,
      this.headingMaterial, this.compassMaterial, this.dropMaterial,
    ]) {
      m.dispose();
    }
    this.dropLine.geometry.dispose();
    this.strengthStem.geometry.dispose();
    this.compass.geometry.dispose();
  }

  private groundBelow(point: THREE.Vector3) {
    this.groundRay.set(point, DOWN);
    const [hit] = this.groundRay.intersectObject(this.ground, true);
    return hit ? hit.point.add(new THREE.Vector3(0, GROUND_OFFSET, 0)) : null;
  }
}
