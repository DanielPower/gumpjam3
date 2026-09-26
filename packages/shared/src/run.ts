import type { Box3DModule } from "box3d.js";
import { BODY_PARTS, damageForHit, scoreOf } from "./damage";
import { createSimulation, type Placement, type RagdollHit, type Simulation } from "./simulation";
import type { TrenchBroomMap } from "./trenchbroom-map";

export type ScoredHit = RagdollHit & { damage: number };

export type Run = {
  /** Damage so far for each ragdoll bone. */
  readonly damage: readonly number[];
  readonly stepsTaken: number;
  readonly totalSteps: number;
  readonly finished: boolean;
  /** Advance one physics step and return the hits it scored. */
  step(): ScoredHit[];
};

/**
 * Start a scored run on a freshly built simulation. The game and the server
 * both score runs through this, one step at a time, so they agree exactly.
 */
export function startRun(simulation: Simulation, totalSteps: number): Run {
  const damage = BODY_PARTS.map(() => 0);
  let stepsTaken = 0;
  simulation.applyForces();

  return {
    damage,
    totalSteps,
    get stepsTaken() {
      return stepsTaken;
    },
    get finished() {
      return stepsTaken >= totalSteps;
    },
    step() {
      if (stepsTaken >= totalSteps) return [];
      simulation.step();
      stepsTaken++;
      return simulation.ragdollHits().map((hit) => {
        const scored = { ...hit, damage: damageForHit(hit.bone, hit.speed) };
        damage[hit.bone] += scored.damage;
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
  totalSteps: number,
) {
  const simulation = createSimulation(b3, map, placements);
  try {
    const run = startRun(simulation, totalSteps);
    while (!run.finished) run.step();
    return { damage: [...run.damage], score: scoreOf(run.damage) };
  } finally {
    simulation.destroy();
  }
}
