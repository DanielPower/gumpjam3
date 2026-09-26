import type { Box3DModule } from "box3d.js";
import { simulateRun } from "@stairs/shared/run";
import { parsePlacements, PlacementError, validatePlacements } from "@stairs/shared/validation";
import type { ScoreStore } from "./db";
import type { ServerLevel } from "./levels";

/**
 * Re-score entries computed under older rules (a scoring change, or an edited
 * level) by replaying their stored placements, so every score on a leaderboard
 * was computed the same way. Entries that are no longer valid on the level
 * (e.g. it now allows fewer boxes) are removed.
 */
export function rescoreOutdated(b3: Box3DModule, levels: Map<string, ServerLevel>, scores: ScoreStore) {
  let rescored = 0;
  let removed = 0;
  for (const [id, level] of levels) {
    for (const entry of scores.outdated(id, level.rules)) {
      try {
        const placements = parsePlacements(entry.placements, level.maxPlacements);
        validatePlacements(b3, level, placements);
        const { score, damage } = simulateRun(b3, level.map, placements, level.runLimits);
        scores.rescore(entry.id, { score, damage, rules: level.rules });
        rescored++;
      } catch (error) {
        if (!(error instanceof PlacementError)) throw error;
        scores.remove(entry.id);
        removed++;
      }
    }
  }
  return { rescored, removed };
}
