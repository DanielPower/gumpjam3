import type { Box3DModule } from "box3d.js";
import { BODY_PARTS, damageForHit, scoreOf } from "./damage";
import { createSimulation, type Placement, type RagdollHit, type Simulation } from "./simulation";
import type { TrenchBroomMap } from "./trenchbroom-map";

/**
 * Bump whenever anything that affects scores changes (physics, forces, damage,
 * run limits). The server re-scores stored leaderboard entries under the new
 * rules, so scores stay comparable. Level edits are picked up separately.
 */
export const RULES_VERSION = 8;

export type ScoredHit = RagdollHit & { damage: number };

export type RunLimits = {
  /** The run ends after this many steps in a row without taking damage... */
  quietSteps: number;
  /** ...or after this many steps in total, whichever comes first. */
  maxSteps: number;
};

export type Run = {
  /** Damage so far for each ragdoll bone. */
  readonly damage: readonly number[];
  readonly limits: RunLimits;
  readonly stepsTaken: number;
  /** Steps since the ragdoll last took damage (or since the run started). */
  readonly quietSteps: number;
  /** Steps until the run ends if no more damage is taken. */
  readonly stepsRemaining: number;
  readonly finished: boolean;
  /** Advance one physics step and return the hits it scored. */
  step(): ScoredHit[];
};

/**
 * Start a scored run on a freshly built simulation. It keeps going while the
 * ragdoll keeps taking damage. The game and the server both score runs through
 * this, one step at a time, so they agree exactly.
 */
export function startRun(simulation: Simulation, limits: RunLimits): Run {
  const damage = BODY_PARTS.map(() => 0);
  let stepsTaken = 0;
  let quietSteps = 0;
  simulation.applyForces();

  const stepsRemaining = () => Math.max(0, Math.min(limits.quietSteps - quietSteps, limits.maxSteps - stepsTaken));

  return {
    damage,
    limits,
    get stepsTaken() {
      return stepsTaken;
    },
    get quietSteps() {
      return quietSteps;
    },
    get stepsRemaining() {
      return stepsRemaining();
    },
    get finished() {
      return stepsRemaining() === 0;
    },
    step() {
      if (stepsRemaining() === 0) return [];
      simulation.step();
      stepsTaken++;
      quietSteps++;
      return simulation.ragdollHits().map((hit) => {
        const scored = { ...hit, damage: damageForHit(hit.bone, hit.speed) };
        damage[hit.bone] += scored.damage;
        if (scored.damage > 0) quietSteps = 0;
        return scored;
      });
    },
  };
}

/** Run a setup to completion without rendering, as the server does. */
export function simulateRun(
  b3: Box3DModule,
  map: TrenchBroomMap,
  placements: readonly Placement[],
  limits: RunLimits,
) {
  const simulation = createSimulation(b3, map, placements);
  try {
    const run = startRun(simulation, limits);
    while (!run.finished) run.step();
    return { damage: [...run.damage], score: scoreOf(run.damage), steps: run.stepsTaken };
  } finally {
    simulation.destroy();
  }
}
