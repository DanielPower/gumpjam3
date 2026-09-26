import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import { startRun } from "@stairs/shared/run";
import { createSimulation, type Placement } from "@stairs/shared/simulation";
import { validatePlacements } from "@stairs/shared/validation";
import { loadLevels, type ServerLevel } from "./levels";

let b3: Box3DModule;
let levels: Map<string, ServerLevel>;
before(async () => {
  b3 = await Box3D();
  levels = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url)));
});

// On The Stairs' top platform (its surface is at y ≈ 12.03), beside the ragdoll.
const SURFACE = 385 / 32;
const box: Placement = { kind: "box", id: 1, position: [11, SURFACE + 0.26, 0] };
const anchor = [13, SURFACE, 0] as [number, number, number];
const tie: Placement = {
  kind: "rope",
  a: { target: { kind: "prop", id: 1 }, localPoint: [0, 0.25, 0] },
  b: { target: { kind: "level" }, localPoint: anchor },
};
const fling: Placement = { kind: "force", target: { kind: "prop", id: 1 }, localPoint: [0, 0, 0], vector: [-1.5, 1, 0] };

/** How far the box's tie point gets from the anchor over a whole run. */
function farthest(placements: Placement[]) {
  const level = levels.get("level1")!;
  const sim = createSimulation(b3, level.map, placements);
  const run = startRun(sim, level.runLimits);
  let farthest = 0;
  while (!run.finished) {
    run.step();
    const [x, y, z] = b3.b3Body_GetWorldPoint([0, 0, 0], sim.props.get(1)!, [0, 0.25, 0]);
    farthest = Math.max(farthest, Math.hypot(x - anchor[0], y - anchor[1], z - anchor[2]));
  }
  sim.destroy();
  return farthest;
}

test("a rope keeps a flung box within its length of where it's tied", () => {
  const length = Math.hypot(11 - anchor[0], 0.5, 0);
  assert.ok(farthest([box, fling]) > 3 * length, "untied, the box flies off");
  const tied = farthest([box, fling, tie]);
  assert.ok(tied < length + 0.1, `tied, it stays within the rope's ${length.toFixed(2)} m (got ${tied.toFixed(2)} m)`);
});

test("ropes tie two different things, within reach, to the level only at its surface", () => {
  const stairs = levels.get("level1")!;
  assert.doesNotThrow(() => validatePlacements(b3, stairs, [box, tie]));
  const rope = (a: object, b: object) => ({ kind: "rope", a, b }) as Placement;
  const onBox = { target: { kind: "prop", id: 1 }, localPoint: [0, 0.25, 0] };
  const rejects: [string, Placement[], RegExp][] = [
    ["tied to itself", [box, rope(onBox, { ...onBox, localPoint: [0, -0.25, 0] })], /two different things/],
    ["tied to thin air", [box, rope(onBox, { target: { kind: "level" }, localPoint: [13, SURFACE + 2, 0] })], /at its surface/],
    ["too long", [box, rope(onBox, { target: { kind: "level" }, localPoint: [20, SURFACE, 0] })], /at most 6 m/],
    ["tied to a missing box", [rope({ ...onBox, target: { kind: "prop", id: 9 } }, tie.b)], /missing box 9/],
    ["tied far from its body", [box, rope({ ...onBox, localPoint: [0, 2, 0] }, tie.b)], /too far from its body/],
  ];
  for (const [what, placements, message] of rejects) {
    assert.throws(() => validatePlacements(b3, stairs, placements), message, what);
  }
  // Levels without ropes in their inventory don't allow any.
  const noRopes = { ...stairs, inventory: { ...stairs.inventory, rope: 0 } };
  assert.throws(() => validatePlacements(b3, noRopes, [box, tie]), /allows 0 rope/);
});
