import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import type { Level } from "@stairs/shared/level";
import { simulateRun, startRun } from "@stairs/shared/run";
import { createSimulation, type Placement } from "@stairs/shared/simulation";
import { loadLevels } from "./levels";

const push: Placement = {
  kind: "force",
  target: { kind: "ragdoll", bone: 3 },
  localPoint: [0, 0, 0],
  vector: [-1.2, 0.3, 0],
};

let b3: Box3DModule;
let level: Level;
before(async () => {
  b3 = await Box3D();
  level = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url))).get("level1")!;
});

test("the level ends runs after 3 s without damage, and at 60 s at most", () => {
  assert.deepEqual(level.runLimits, { quietSteps: 180, maxSteps: 3600 });
});

test("a run ends once it has gone quietSteps without damage", () => {
  const simulation = createSimulation(b3, level.map, [push]);
  const run = startRun(simulation, level.runLimits);
  let lastDamageStep = 0;
  while (!run.finished) {
    if (run.step().some((hit) => hit.damage > 0)) lastDamageStep = run.stepsTaken;
  }
  simulation.destroy();
  assert.ok(lastDamageStep > 0);
  assert.equal(run.stepsTaken - lastDamageStep, level.runLimits.quietSteps);
  assert.deepEqual(run.step(), [], "a finished run doesn't step");
});

test("a run stops at maxSteps even if damage never lets up", () => {
  const result = simulateRun(b3, level.map, [push], { quietSteps: Number.MAX_SAFE_INTEGER, maxSteps: 30 });
  assert.equal(result.steps, 30);
});

test("a run that keeps taking damage lasts longer", () => {
  const quiet = simulateRun(b3, level.map, [], level.runLimits);
  const pushed = simulateRun(b3, level.map, [push], level.runLimits);
  assert.ok(pushed.steps > quiet.steps, `${pushed.steps} steps vs ${quiet.steps}`);
});
