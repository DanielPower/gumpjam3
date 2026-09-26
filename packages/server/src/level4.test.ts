import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import { levelSolids } from "@stairs/shared/level-entities";
import { simulateRun } from "@stairs/shared/run";
import { createSimulation, type Placement } from "@stairs/shared/simulation";
import { PlacementError, validatePlacements } from "@stairs/shared/validation";
import { loadLevels, type ServerLevel } from "./levels";

let b3: Box3DModule;
let level: ServerLevel;
before(async () => {
  b3 = await Box3D();
  level = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url))).get("level4")!;
});

const force = (bone: number, vector: [number, number, number]): Placement => ({
  kind: "force",
  target: { kind: "ragdoll", bone },
  localPoint: [0, 0, 0],
  vector,
});
const bait = (id: number, x: number, z: number): Placement => ({
  kind: "bait",
  id,
  position: [x, 0.08, z],
});

test("Rat Race offers bait and leaves an open landing for its two charging rats", () => {
  assert.deepEqual(level.inventory, { force: 2, box: 0, mine: 0, bait: 2, rope: 0 });
  const solids = levelSolids(level.map);
  assert.equal(solids.movers.filter((mover) => mover.motion.kind === "rat").length, 2);
  assert.equal(solids.movers.filter((mover) => mover.motion.kind === "rotate").length, 1);
});

test("bait assigns a unique rat, previews its route, and is eaten on arrival", () => {
  const placements = [
    force(3, [-1.44, 0, -0.3]),
    force(5, [-1.36, 0, -0.3]),
    bait(1, 1, 0),
    bait(2, -8, 3),
  ];
  assert.doesNotThrow(() => validatePlacements(b3, level, placements));
  const simulation = createSimulation(b3, level.map, placements);
  const routes = simulation.ratRoutes();
  assert.equal(routes.length, 2);
  assert.deepEqual(new Set(routes.map((route) => route.baitId)), new Set([1, 2]));
  assert.equal(new Set(routes.map((route) => route.moverIndex)).size, 2);

  const first = routes.find((route) => route.baitId === 1)!;
  assert.deepEqual(first.bait, [1, 0.08, 0]);
  simulation.applyForces();
  for (let step = 0; step < level.runLimits.maxSteps && !simulation.baitConsumed(1); step++) simulation.step();
  assert.equal(simulation.baitConsumed(1), true);
  const ratPosition = b3.b3Body_GetPosition([0, 0, 0], simulation.movers[first.moverIndex]);
  assert.ok(Math.hypot(ratPosition[0] - first.bait[0], ratPosition[2] - first.bait[2]) < 0.25);
  for (let step = 0; step < 60; step++) simulation.step();
  const returnedHome = b3.b3Body_GetPosition([0, 0, 0], simulation.movers[first.moverIndex]);
  assert.ok(Math.hypot(returnedHome[0] - first.start[0], returnedHome[2] - first.start[2]) < 0.01);
  simulation.destroy();
});

test("a baited rat waits at home until the ragdoll approaches", () => {
  const simulation = createSimulation(b3, level.map, [bait(1, 0, 0)]);
  const [route] = simulation.ratRoutes();
  for (let step = 0; step < 180; step++) simulation.step();
  const position = b3.b3Body_GetPosition([0, 0, 0], simulation.movers[route.moverIndex]);
  assert.equal(simulation.baitConsumed(1), false);
  assert.ok(Math.hypot(position[0] - route.start[0], position[2] - route.start[2]) < 0.01);
  simulation.destroy();
});

test("a proximity-triggered rat makes one deliberate, valuable strike", () => {
  const stairRoute = [force(3, [-1.4, 0.3, -0.3]), force(5, [-1.35, 0.3, -0.3])];
  const withoutBait = simulateRun(b3, level.map, stairRoute, level.runLimits);
  const baitedRoute = [...stairRoute, bait(1, 2, 0)];
  const withBait = simulateRun(b3, level.map, baitedRoute, level.runLimits);
  assert.deepEqual(simulateRun(b3, level.map, baitedRoute, level.runLimits), withBait);
  assert.ok(withoutBait.score > 2_500, `stairs scored ${withoutBait.score}`);
  assert.ok(withBait.score > withoutBait.score * 5, `${withBait.score} vs ${withoutBait.score}`);
  assert.ok(withBait.score < 50_000, `single rat pass ran away to ${withBait.score}`);
});

test("bait obeys inventory, floor, and overlap validation", () => {
  assert.throws(
    () => validatePlacements(b3, level, [bait(1, 1, 0), bait(2, -2, 2), bait(3, -5, -2)]),
    (error: unknown) => error instanceof PlacementError && /allows 2 bait/.test(error.message),
  );
  assert.throws(
    () => validatePlacements(b3, level, [bait(1, 1, 0), bait(2, 1.2, 0)]),
    (error: unknown) => error instanceof PlacementError && /overlap/.test(error.message),
  );
  assert.throws(
    () => validatePlacements(b3, level, [{ kind: "bait", id: 1, position: [1, 2, 0] }]),
    (error: unknown) => error instanceof PlacementError && /sewer floor/.test(error.message),
  );
});
