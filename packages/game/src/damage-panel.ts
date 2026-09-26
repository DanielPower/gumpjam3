import * as THREE from "three";
import { BODY_PARTS, scoreOf } from "@stairs/shared/damage";

/** Per-part damage at which the diagram shows full red. */
const PART_DAMAGE_FOR_MAX_HEAT = 400;
/** A single hit this big flashes at full strength. */
const HIT_DAMAGE_FOR_MAX_FLASH = 200;

type Shape =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number };

/**
 * Diagram shape for each ragdoll bone, in ragdoll.ts order. The diagram is a
 * front view, so the ragdoll's left side is drawn on the viewer's right.
 */
const DIAGRAM_SHAPES: Shape[] = [
  { kind: "rect", x: 33, y: 86, w: 34, h: 16 }, // pelvis
  { kind: "rect", x: 36, y: 74, w: 28, h: 12 }, // lower back
  { kind: "rect", x: 35, y: 62, w: 30, h: 12 }, // abdomen
  { kind: "rect", x: 32, y: 38, w: 36, h: 24 }, // chest
  { kind: "rect", x: 45, y: 29, w: 10, h: 9 }, // neck
  { kind: "circle", cx: 50, cy: 17, r: 12 }, // head
  { kind: "rect", x: 51, y: 103, w: 14, h: 43 }, // left thigh
  { kind: "rect", x: 52, y: 148, w: 12, h: 44 }, // left shin
  { kind: "rect", x: 35, y: 103, w: 14, h: 43 }, // right thigh
  { kind: "rect", x: 36, y: 148, w: 12, h: 44 }, // right shin
  { kind: "rect", x: 70, y: 40, w: 10, h: 32 }, // left upper arm
  { kind: "rect", x: 71, y: 74, w: 9, h: 32 }, // left forearm
  { kind: "rect", x: 20, y: 40, w: 10, h: 32 }, // right upper arm
  { kind: "rect", x: 20, y: 74, w: 9, h: 32 }, // right forearm
];

/** Flash colour for a hit: yellow for glancing blows through to red for big ones. */
export function hitFlashColor(damage: number, target = new THREE.Color()) {
  const t = THREE.MathUtils.clamp(damage / HIT_DAMAGE_FOR_MAX_FLASH, 0, 1);
  return target.setHSL(0.14 * (1 - t), 1, 0.5);
}

/** How strongly a hit flashes, from a faint glow up to full. */
export function hitFlashStrength(damage: number) {
  return THREE.MathUtils.clamp(0.35 + damage / HIT_DAMAGE_FOR_MAX_FLASH, 0.35, 1.5);
}

function heatColor(damage: number) {
  if (damage <= 0) return "#555";
  const t = Math.min(1, damage / PART_DAMAGE_FOR_MAX_HEAT);
  return `hsl(${Math.round(55 * (1 - t))}, 90%, ${Math.round(55 - 10 * t)}%)`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The total damage, with a body diagram beside it shaded by where it hurt. */
export class DamagePanel {
  readonly element = document.createElement("div");
  private readonly title = document.createElement("div");
  private readonly total = document.createElement("div");
  private readonly shapes: SVGElement[] = [];
  private readonly shown: number[] = [];

  constructor() {
    this.element.id = "damage";
    this.title.className = "damage-title";
    this.total.className = "damage-total";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 196");
    svg.classList.add("damage-figure");
    DIAGRAM_SHAPES.forEach((shape, bone) => {
      const el = document.createElementNS(SVG_NS, shape.kind);
      for (const [key, value] of Object.entries(shape)) {
        if (key === "kind") continue;
        el.setAttribute(key === "w" ? "width" : key === "h" ? "height" : key, String(value));
      }
      if (shape.kind === "rect") el.setAttribute("rx", "4");
      svg.appendChild(el);
      this.shapes[bone] = el;
    });
    this.element.append(this.title, this.total, svg);
    this.update(BODY_PARTS.map(() => 0), "Damage");
  }

  update(damage: readonly number[], title: string) {
    this.title.textContent = title;
    this.total.textContent = scoreOf(damage).toLocaleString();
    damage.forEach((value, bone) => {
      const rounded = Math.round(value);
      if (this.shown[bone] === rounded) return;
      this.shown[bone] = rounded;
      this.shapes[bone].setAttribute("fill", heatColor(value));
    });
  }

  /** Pulse a part of the diagram when it takes a hit. */
  flash(bone: number) {
    const shape = this.shapes[bone];
    shape.classList.remove("hit");
    // Restart the CSS animation.
    void (shape as unknown as HTMLElement).getBoundingClientRect();
    shape.classList.add("hit");
  }
}
