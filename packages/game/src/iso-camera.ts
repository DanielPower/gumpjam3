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
 * Isometric orthographic camera for the edit phase: left-drag (or one finger)
 * to rotate around the vertical axis, right-drag (or two fingers) to pan,
 * scroll (or pinch) to zoom towards the cursor.
 * Panning moves the camera in its view plane by exactly the world distance
 * under the pointer, so what you grab stays under the cursor at any zoom level.
 * Rotation pivots on whatever is at the centre of the view.
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
  private drag: { mode: "pan" | "rotate"; x: number; y: number; pivot: THREE.Vector3 } | null = null;
  /** Fingers on the screen, for two-finger pan and pinch zoom. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { x: number; y: number; distance: number } | null = null;
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
    this.updateDirection();
    this.lookFrom(focus);
    this.resize();

    domElement.addEventListener("contextmenu", (event) => event.preventDefault());
    domElement.addEventListener("pointerdown", (event) => {
      if (!this.enabled) return;
      if (event.pointerType === "touch") {
        this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.touches.size === 2) {
          // A second finger turns a one-finger rotate into pan and pinch.
          this.drag = null;
          this.pinch = this.twoFingers();
          return;
        }
      }
      if (this.drag || this.pinch) return;
      const mode = event.button === PAN_BUTTON ? "pan" : event.button === ROTATE_BUTTON ? "rotate" : null;
      if (!mode) return;
      this.glide = null;
      const pivot = mode === "rotate" ? this.viewCenter() : this.focus;
      this.drag = { mode, x: event.clientX, y: event.clientY, pivot };
      domElement.setPointerCapture(event.pointerId);
    });
    domElement.addEventListener("pointermove", (event) => {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch && this.touches.size >= 2) {
        const now = this.twoFingers();
        this.pan(now.x - this.pinch.x, now.y - this.pinch.y);
        if (this.pinch.distance > 0) this.zoomAt(now.x, now.y, now.distance / this.pinch.distance);
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
      if (this.touches.size < 2) this.pinch = null;
      if (!this.drag) return;
      const button = this.drag.mode === "pan" ? PAN_BUTTON : ROTATE_BUTTON;
      if (event.type === "pointerup" && event.button !== button) return;
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

  /** Where the first two fingers are centred, and how far apart they are. */
  private twoFingers() {
    const [a, b] = [...this.touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  /** The point at the centre of the view, DISTANCE in front of the camera. */
  get focus() {
    return this.camera.position.clone().addScaledVector(this.direction, -DISTANCE);
  }

  /** World height visible at the current zoom, in metres. */
  get viewHeight() {
    return VIEW_HEIGHT / this.camera.zoom;
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
  }

  /** Glide so `point` is at the centre of the view. */
  centerOn(point: THREE.Vector3) {
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
    this.yaw -= dx * ROTATE_SPEED;
    this.updateDirection();
    this.lookFrom(pivot);
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
