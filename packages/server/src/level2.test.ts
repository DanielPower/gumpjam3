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
  // The car (second) drives down the street at about its cruising speed, 14 m/s.
  assert.ok(Math.abs(sample(0, 1)[2] - sample(60, 1)[2] - 14) < 0.5, "the car covers about 14 m in a second");
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
  assert.ok(street.score > stairs.score, `street ${street.score} vs stairs ${stairs.score}`);
});

test("a car that hits something lifts off the throttle and slows, instead of ploughing on", () => {
  const speedAfter = (placements: Placement[], steps: number) => {
    const sim = createSimulation(b3, level.map, placements);
    for (let step = 0; step < steps; step++) sim.step();
    const [x, , z] = b3.b3Body_GetLinearVelocity([0, 0, 0], sim.movers[1]);
    sim.destroy();
    return Math.hypot(x, z);
  };
  // A box in the car's lane, a little way ahead of it.
  const start = (() => {
    const sim = createSimulation(b3, level.map, []);
    const p = b3.b3Body_GetPosition([0, 0, 0], sim.movers[1]);
    sim.destroy();
    return p;
  })();
  const box: Placement = { kind: "box", id: 1, position: [start[0], start[1] + 1.5, start[2] - 8] };
  assert.ok(Math.abs(speedAfter([], 180) - 14) < 0.5, "on a clear road it keeps cruising");
  const slowed = speedAfter([box], 180);
  assert.ok(slowed < 12, `after hitting the box it's down to ${slowed.toFixed(1)} m/s`);
});

test("each vehicle drives its road once, ending up in the far tunnel", () => {
  const sim = createSimulation(b3, level.map, []);
  const along = (mover: number) => b3.b3Body_GetPosition([0, 0, 0], sim.movers[mover])[2];
  const start = [along(1), along(2)];
  let [carMost, busLeast] = [Infinity, -Infinity];
  for (let step = 0; step < 15 * 60; step++) {
    sim.step();
    carMost = Math.min(carMost, along(1));
    busLeast = Math.max(busLeast, along(2));
    // Never back where they started.
    assert.ok(step < 60 || (along(1) < start[0] - 5 && along(2) > start[1] + 5), `a vehicle came round again at step ${step}`);
  }
  sim.destroy();
  // The car (heading -z) and bus (heading +z) got into the far tunnels, past the ends of the street's pavements.
  assert.ok(carMost < -18, `the car got to z ${carMost.toFixed(1)}`);
  assert.ok(busLeast > 18, `the bus got to z ${busLeast.toFixed(1)}`);
});

test("the merry-go-round spins in place and winds down, unless a thruster keeps it going", () => {
  // A thruster on the end of one of its arms, pushing it round the way it already spins.
  const thruster: Placement = { kind: "thruster", target: { kind: "mover", index: 0 }, localPoint: [1.9, 1.3, 0.05], localNormal: [0, 0, 1] };
  const spin = (placements: Placement[]) => {
    const sim = createSimulation(b3, level.map, placements);
    const start = b3.b3Body_GetPosition([0, 0, 0], sim.movers[0]);
    const spins: number[] = [];
    for (let step = 0; step <= 360; step++) {
      if (step % 60 === 0) spins.push(b3.b3Body_GetAngularVelocity([0, 0, 0], sim.movers[0])[1]);
      sim.step();
    }
    const end = b3.b3Body_GetPosition([0, 0, 0], sim.movers[0]);
    sim.destroy();
    assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) < 0.01, "it stays pinned");
    return spins;
  };
  const free = spin([]);
  assert.ok(free[6] < 0.6 * free[0], `on its own it slows from ${free[0].toFixed(1)} to ${free[6].toFixed(1)} rad/s`);
  const pushed = spin([thruster]);
  assert.ok(pushed[6] > free[0], `with a thruster it speeds up, to ${pushed[6].toFixed(1)} rad/s`);
  assert.doesNotThrow(() => validatePlacements(b3, level, [thruster]));
  // The street's vehicles are bodies too, but kinematic movers (there are none here) and made-up ones aren't.
  assert.throws(() => validatePlacements(b3, level, [{ ...thruster, target: { kind: "mover", index: 9 } } as Placement]), /no moving body 9/);
  assert.throws(() => validatePlacements(b3, level, [{ ...thruster, localPoint: [9, 0, 0] } as Placement]), /too far from its body/);
});
