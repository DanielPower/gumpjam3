import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import { startRun } from "@stairs/shared/run";
import { createSimulation, type Placement } from "@stairs/shared/simulation";
import { PlacementError, validatePlacements } from "@stairs/shared/validation";
import { loadLevels, type ServerLevel } from "./levels";

let b3: Box3DModule;
let levels: Map<string, ServerLevel>;
before(async () => {
  b3 = await Box3D();
  levels = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url)));
});

const push: Placement = { kind: "force", target: { kind: "ragdoll", bone: 0 }, localPoint: [0, 0, 0], vector: [-1.4, 0.5, 0] };
const mine = (id: number, x: number, y: number, z = 0): Placement => ({ kind: "mine", id, position: [x, y + 0.04, z], normal: [0, 1, 0] });
// Mines on the first and third terraces below Blast Quarry's start.
const chain: Placement[] = [push, mine(1, 12.5, 7.5), mine(2, 7.5, 4.5)];

function play(placements: Placement[]) {
  const level = levels.get("level3")!;
  const sim = createSimulation(b3, level.map, placements);
  const run = startRun(sim, level.runLimits);
  const explosions: string[] = [];
  while (!run.finished) {
    run.step();
    for (const e of sim.explosions()) explosions.push(`${e.source.kind}@${run.stepsTaken}`);
  }
  sim.destroy();
  return { score: run.damage.reduce((a, b) => a + b, 0), explosions };
}

test("Blast Quarry's barrels sit still until something sets them off", () => {
  assert.deepEqual(play([]).explosions, []);
});

test("mines chain into barrels, deterministically, and score far more than a push", () => {
  const first = play(chain);
  assert.ok(first.explosions.length >= 5, `chain: ${first.explosions.join(" ")}`);
  assert.ok(first.explosions.some((e) => e.startsWith("barrel")), "barrels join the chain");
  assert.deepEqual(play(chain), first);
  assert.ok(first.score > 3 * play([push]).score);
});

test("mines must sit on a surface, within the level's allowance", () => {
  const quarry = levels.get("level3")!;
  assert.doesNotThrow(() => validatePlacements(b3, quarry, chain));
  const rejects: [string, Placement[], RegExp][] = [
    ["a floating mine", [mine(1, 12.5, 9)], /on a surface/],
    ["a buried mine", [mine(1, 12.5, 6)], /buried/],
    ["stacked mines", [mine(1, 12.5, 7.5), mine(2, 12.6, 7.5)], /on top of each other/],
    ["too many mines", [mine(1, 12.5, 7.5), mine(2, 7.5, 4.5), mine(3, 10, 6), mine(4, 5, 3)], /allows 3 mine/],
    ["a sideways normal that isn't unit length", [{ kind: "mine", id: 1, position: [12.5, 7.54, 0], normal: [0, 2, 0] }], /unit vector/],
  ];
  for (const [what, placements, message] of rejects) {
    assert.throws(() => validatePlacements(b3, quarry, placements), (e: unknown) => e instanceof PlacementError && message.test(e.message), what);
  }
  // Levels without mines in their inventory don't allow any.
  assert.throws(() => validatePlacements(b3, levels.get("level1")!, [mine(1, 9.5, 12)]), /allows 0 mine/);
});

test("forces can push barrels, but only ones that exist", () => {
  const quarry = levels.get("level3")!;
  const barrelPush = (index: number): Placement => ({ kind: "force", target: { kind: "barrel", index }, localPoint: [0, 0, 0], vector: [-1, 0.5, 0] });
  assert.doesNotThrow(() => validatePlacements(b3, quarry, [barrelPush(0)]));
  assert.throws(() => validatePlacements(b3, quarry, [barrelPush(99)]), /no barrel/);
});
