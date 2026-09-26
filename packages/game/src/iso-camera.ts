import * as THREE from "three";

/** Isometric elevation: equal angles to all three axes (35.26°). Never changes. */
const PITCH = Math.asin(1 / Math.sqrt(3));
/**
 * Convert a map compass angle (degrees, as for an entity's "angle": 0 faces map
 * +X, 90 faces map +Y) that the camera should face into this camera's yaw.
 */
export function yawFacingMapAngle(degrees: number) {
  const a = THREE.MathUtils.degToRad(degrees);
  // Map (cos a, sin a) is world (cos a, 0, -sin a); the camera sits opposite.
  return Math.atan2(-Math.cos(a), Math.sin(a));
}
/** Facing map angle 45°: looking up level 1's stairs from their lower side. */
const DEFAULT_YAW = yawFacingMapAngle(45);
/** Radians of rotation per pixel dragged horizontally. */
const ROTATE_SPEED = 0.006;
/** How far back the camera sits. Orthographic, so this only affects clipping. */
const DISTANCE = 40;
/** World height visible at zoom 1, in metres. */
const VIEW_HEIGHT = 8;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_PER_WHEEL_PIXEL = 0.0015;
const GLIDE_SECONDS = 0.3;
const ROTATE_BUTTON = 0;
const PAN_BUTTON = 2;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Finds the scene point along a ray, for choosing what to rotate around. */
export type SurfacePicker = (ray: THREE.Ray) => THREE.Vector3 | null;

/**
 * Isometric orthographic camera for the edit phase, rotating only around the
 * vertical axis.
 * - Mouse: left-drag to rotate, right-drag to pan, scroll to zoom towards the cursor.
 * - Touch: drag to pan; with two fingers, move to pan, pinch to zoom, and
 *   twist to rotate.
 * Panning moves the camera in its view plane by exactly the world distance
 * under the pointer, so what you grab stays under the cursor (or fingers) at
 * any zoom level. A twist pivots between the fingers, so the scene turns
 * under them.
 *
 * Mouse rotation pivots on whatever was grabbed: the scene turns around the
 * vertical line through the point under the cursor, so that point stays put.
 * Grabbing empty space (the sky) pivots instead on the point at the centre of
 * the view at a remembered height, the height of the last thing grabbed or
 * centred on, so repeated rotations there turn around the same spot.
 */
export class IsometricCamera {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, DISTANCE * 4);
  /** Only handles input while enabled. */
  enabled = true;

  private readonly domElement: HTMLElement;
  private readonly pickSurface: SurfacePicker;
  private yaw: number;
  /** The camera looks back along this, from the view towards the camera. */
  readonly direction = new THREE.Vector3();
  private drag: { mode: "pan" | "rotate"; button: number; x: number; y: number; pivot: THREE.Vector3 } | null = null;
  /** Fingers on the screen, for two-finger pan, pinch zoom and twist. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { x: number; y: number; distance: number; angle: number } | null = null;
  /** A twist turns around the vertical line through the point between the fingers, at this height. */
  private twistHeight = 0;
  /** Rotation pivots on the point at the centre of the view at this height. */
  private pivotHeight: number;
  private glide: { from: THREE.Vector3; to: THREE.Vector3; elapsed: number } | null = null;

  constructor(
    domElement: HTMLElement,
    focus: THREE.Vector3,
    pickSurface: SurfacePicker,
    { yaw = DEFAULT_YAW, viewHeight = VIEW_HEIGHT }: { yaw?: number; viewHeight?: number } = {},
  ) {
    this.domElement = domElement;
    this.yaw = yaw;
    this.camera.zoom = THREE.MathUtils.clamp(VIEW_HEIGHT / viewHeight, MIN_ZOOM, MAX_ZOOM);
    this.pickSurface = pickSurface;
    this.pivotHeight = focus.y;
    this.updateDirection();
    this.lookFrom(focus);
    this.resize();

    domElement.addEventListener("contextmenu", (event) => event.preventDefault());
    domElement.addEventListener("pointerdown", (event) => {
      if (!this.enabled) return;
      if (event.pointerType === "touch") {
        this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.touches.size === 2) {
          // A second finger turns a one-finger pan into pan, pinch and twist.
          this.drag = null;
          this.pinch = this.twoFingers();
          this.twistHeight = (this.pickSurface(this.rayAt(this.pinch.x, this.pinch.y)) ?? this.focus).y;
          return;
        }
      }
      if (this.drag || this.pinch) return;
      // One finger pans, since it can't right-drag and rotating is a twist.
      const mode =
        event.pointerType === "touch" || event.button === PAN_BUTTON ? "pan" : event.button === ROTATE_BUTTON ? "rotate" : null;
      if (!mode) return;
      this.glide = null;
      let pivot = this.focus;
      if (mode === "rotate") {
        const grabbed = this.pickSurface(this.rayAt(event.clientX, event.clientY));
        if (grabbed) this.pivotHeight = grabbed.y;
        pivot = grabbed ?? this.pivot();
      }
      this.drag = { mode, button: event.button, x: event.clientX, y: event.clientY, pivot };
      domElement.setPointerCapture(event.pointerId);
    });
    domElement.addEventListener("pointermove", (event) => {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch && this.touches.size >= 2) {
        const now = this.twoFingers();
        this.pan(now.x - this.pinch.x, now.y - this.pinch.y);
        if (this.pinch.distance > 0) this.zoomAt(now.x, now.y, now.distance / this.pinch.distance);
        // Wrapped to ±π, so crossing the angle's seam doesn't spin the view.
        const twist = Math.atan2(Math.sin(now.angle - this.pinch.angle), Math.cos(now.angle - this.pinch.angle));
        this.twistAt(now.x, now.y, twist);
        this.pinch = now;
        return;
      }
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      if (this.drag.mode === "pan") this.pan(dx, dy);
      else this.rotate(dx, this.drag.pivot);
    });
    const endDrag = (event: PointerEvent) => {
      this.touches.delete(event.pointerId);
      if (this.touches.size < 2 && this.pinch) {
        this.pinch = null;
        this.repivot();
      }
      if (!this.drag) return;
      if (event.type === "pointerup" && event.button !== this.drag.button) return;
      if (this.drag.mode === "pan") this.repivot();
      this.drag = null;
      if (domElement.hasPointerCapture(event.pointerId)) domElement.releasePointerCapture(event.pointerId);
    };
    domElement.addEventListener("pointerup", endDrag);
    domElement.addEventListener("pointercancel", endDrag);
    domElement.addEventListener(
      "wheel",
      (event) => {
        if (!this.enabled) return;
        event.preventDefault();
        this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * ZOOM_PER_WHEEL_PIXEL));
      },
      { passive: false },
    );
  }

  /** Where the first two fingers are centred, how far apart they are, and the angle between them. */
  private twoFingers() {
    const [a, b] = [...this.touches.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  /** The ray through the camera at a screen point. */
  private rayAt(clientX: number, clientY: number) {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster.ray;
  }

  /** The point at the centre of the view, DISTANCE in front of the camera. */
  get focus() {
    return this.camera.position.clone().addScaledVector(this.direction, -DISTANCE);
  }

  /** World height visible at the current zoom, in metres. */
  get viewHeight() {
    return VIEW_HEIGHT / this.camera.zoom;
  }

  /** The point rotation turns around: at the centre of the view, at the pivot height. */
  private pivot() {
    const ray = this.rayAt(...this.centreOnScreen());
    return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.pivotHeight), new THREE.Vector3()) ?? this.focus;
  }

  private centreOnScreen(): [number, number] {
    const rect = this.domElement.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  }

  /** Pivot at the height of whatever is now at the centre of the view, if anything. */
  private repivot() {
    const centre = this.pickSurface(this.rayAt(...this.centreOnScreen()));
    if (centre) this.pivotHeight = centre.y;
  }

  /** The scene point at the centre of the view, or the focus if there's nothing there. */
  viewCenter() {
    this.camera.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    return this.pickSurface(ray.ray) ?? this.focus;
  }

  /**
   * Jump to a view centred on `focus`, facing the same way horizontally as
   * `direction` (the tilt stays isometric) and showing about `viewHeight`
   * metres, within the zoom limits.
   */
  setView(focus: THREE.Vector3, direction: THREE.Vector3, viewHeight: number) {
    this.drag = null;
    this.glide = null;
    this.yaw = Math.atan2(direction.x, direction.z);
    this.updateDirection();
    this.camera.zoom = THREE.MathUtils.clamp(VIEW_HEIGHT / viewHeight, MIN_ZOOM, MAX_ZOOM);
    this.camera.updateProjectionMatrix();
    this.lookFrom(focus);
    this.pivotHeight = focus.y;
  }

  /** Glide so `point` is at the centre of the view. */
  centerOn(point: THREE.Vector3) {
    this.pivotHeight = point.y;
    this.glide = {
      from: this.camera.position.clone(),
      to: point.clone().addScaledVector(this.direction, DISTANCE),
      elapsed: 0,
    };
  }

  /** Match the viewport's aspect ratio; call on window resize. */
  resize() {
    const aspect = this.domElement.clientWidth / Math.max(1, this.domElement.clientHeight) || 1;
    const half = VIEW_HEIGHT / 2;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    if (!this.glide) return;
    this.glide.elapsed += dt;
    const k = easeInOut(Math.min(this.glide.elapsed / GLIDE_SECONDS, 1));
    this.camera.position.lerpVectors(this.glide.from, this.glide.to, k);
    if (k >= 1) this.glide = null;
  }

  /** World metres per screen pixel at the current zoom. */
  get metresPerPixel() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / Math.max(1, this.domElement.clientHeight);
  }

  private updateDirection() {
    const flat = Math.cos(PITCH);
    this.direction.set(flat * Math.sin(this.yaw), Math.sin(PITCH), flat * Math.cos(this.yaw));
  }

  /** Put the camera DISTANCE back from `target` along the view direction. */
  private lookFrom(target: THREE.Vector3) {
    this.camera.position.copy(target).addScaledVector(this.direction, DISTANCE);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }

  private rotate(dx: number, pivot: THREE.Vector3) {
    this.turnAround(pivot, -dx * ROTATE_SPEED);
  }

  /** Turn by `angle` (radians) around the vertical line through `pivot`, which stays where it is on screen. */
  private turnAround(pivot: THREE.Vector3, angle: number) {
    this.yaw += angle;
    this.updateDirection();
    const offset = this.camera.position.clone().sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    this.camera.position.copy(pivot).add(offset);
    this.camera.lookAt(this.camera.position.clone().sub(this.direction));
    this.camera.updateMatrixWorld();
  }

  /**
   * Turn the view by `angle` (radians, clockwise on screen) around the
   * vertical line through what's under (clientX, clientY), so it stays put.
   */
  private twistAt(clientX: number, clientY: number, angle: number) {
    if (angle === 0) return;
    const pivot = this.rayAt(clientX, clientY).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.twistHeight), new THREE.Vector3());
    if (pivot) this.turnAround(pivot, angle);
  }

  private pan(dx: number, dy: number) {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const scale = this.metresPerPixel;
    this.camera.position.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    this.camera.updateMatrixWorld();
  }

  /** Zoom by `factor`, keeping the world point under (clientX, clientY) fixed. */
  private zoomAt(clientX: number, clientY: number, factor: number) {
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector3(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
      0,
    );
    const before = ndc.clone().unproject(this.camera);
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.camera.updateProjectionMatrix();
    const after = ndc.clone().unproject(this.camera);
    this.camera.position.add(before.sub(after));
    this.camera.updateMatrixWorld();
  }
}
