import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import type { Level } from "@stairs/shared/level";
import { simulateRun } from "@stairs/shared/run";
import { createSimulation, type Placement } from "@stairs/shared/simulation";
import { PlacementError, validatePlacements } from "@stairs/shared/validation";
import { loadLevels } from "./levels";

let b3: Box3DModule;
let level: Level;
before(async () => {
  b3 = await Box3D();
  level = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url))).get("level2")!;
});

const push = (bones: number[], vector: [number, number, number]): Placement[] =>
  bones.map((bone) => ({ kind: "force", target: { kind: "ragdoll", bone }, localPoint: [0, 0, 0], vector }));

test("Rush Hour's merry-go-round and traffic move, and replay identically", () => {
  const positions = () => {
    const sim = createSimulation(b3, level.map, []);
    const p: [number, number, number] = [0, 0, 0];
    const samples: number[] = [];
    for (let step = 0; step < 300; step++) {
      sim.step();
      for (const body of sim.movers) samples.push(...b3.b3Body_GetPosition(p, body), ...b3.b3Body_GetRotation([0, 0, 0, 1], body));
    }
    sim.destroy();
    return samples;
  };
  const first = positions();
  assert.equal(level.inventory.force, 3);
  assert.deepEqual(positions(), first);
  // Samples per step: [position, rotation] for each of the three movers.
  const sample = (step: number, mover: number) => first.slice(step * 21 + mover * 7, step * 21 + mover * 7 + 7);
  // The merry-go-round (first mover) turns in place.
  assert.notDeepEqual(sample(0, 0).slice(3), sample(30, 0).slice(3));
  // The car (second) drives down the street at 14 m/s.
  assert.ok(Math.abs(sample(0, 1)[2] - sample(60, 1)[2] - 14) < 0.1, "the car covers 14 m in a second");
});

test("a box can't be placed overlapping a vehicle", () => {
  const sim = createSimulation(b3, level.map, []);
  const car = b3.b3Body_GetPosition([0, 0, 0], sim.movers[1]);
  sim.destroy();
  assert.throws(
    () => validatePlacements(b3, level, [{ kind: "box", id: 1, position: [car[0], car[1], car[2]] }]),
    PlacementError,
  );
});

test("getting the ragdoll into the traffic beats tumbling down the stairs", () => {
  const stairs = simulateRun(b3, level.map, push([0, 3, 5], [-1.34, 0.4, 0.54].map((n) => n * 0.98) as [number, number, number]), level.runLimits);
  const street = simulateRun(b3, level.map, push([6, 8, 3], [-1.25, 0.75, 0].map((n) => n * 1.029) as [number, number, number]), level.runLimits);
  assert.ok(stairs.score > 1000, `stairs scored ${stairs.score}`);
  assert.ok(street.score > 2 * stairs.score, `street ${street.score} vs stairs ${stairs.score}`);
});
