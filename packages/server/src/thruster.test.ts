import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import { createSimulation, THRUSTER_SECONDS, TIME_STEP, type Placement } from "@stairs/shared/simulation";
import { validatePlacements } from "@stairs/shared/validation";
import { loadLevels, type ServerLevel } from "./levels";

let b3: Box3DModule;
let levels: Map<string, ServerLevel>;
before(async () => {
  b3 = await Box3D();
  levels = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url)));
});

// A box on The Stairs' top platform, beside the ragdoll, with a thruster on its underside pushing it up.
const SURFACE = 385 / 32;
const box: Placement = { kind: "box", id: 1, position: [10.5, SURFACE + 0.26, 1] };
const thruster: Placement = { kind: "thruster", target: { kind: "prop", id: 1 }, localPoint: [0, -0.25, 0], localNormal: [0, -1, 0] };

test("a thruster pushes into what it's stuck on, and runs out after a while", () => {
  const sim = createSimulation(b3, levels.get("level1")!.map, [box, thruster]);
  const height = () => b3.b3Body_GetPosition([0, 0, 0], sim.props.get(1)!)[1];
  const burnSteps = Math.round(THRUSTER_SECONDS / TIME_STEP);
  for (let step = 0; step < 60; step++) sim.step();
  assert.ok(sim.thrusterBurning(0));
  assert.ok(height() > SURFACE + 3, `a second in, the box is up at ${height().toFixed(1)} m`);
  for (let step = 60; step < burnSteps; step++) sim.step();
  assert.ok(!sim.thrusterBurning(0), "out of fuel");
  sim.destroy();
});

test("thrusters go on things that exist, within reach, facing a unit normal", () => {
  // The Stairs, as if it offered thrusters (it doesn't, to keep the first level simple).
  const level1 = levels.get("level1")!;
  const stairs = { ...level1, inventory: { ...level1.inventory, thruster: 2 } };
  assert.doesNotThrow(() => validatePlacements(b3, stairs, [box, thruster]));
  const withThruster = (changes: object) => [box, { ...thruster, ...changes } as Placement];
  assert.throws(() => validatePlacements(b3, stairs, withThruster({ target: { kind: "prop", id: 9 } })), /missing box 9/);
  assert.throws(() => validatePlacements(b3, stairs, withThruster({ localPoint: [0, -2, 0] })), /too far from its body/);
  assert.throws(() => validatePlacements(b3, stairs, withThruster({ localNormal: [0, -2, 0] })), /unit vector/);
  assert.throws(() => validatePlacements(b3, level1, [box, thruster]), /allows 0 thruster/);
});
