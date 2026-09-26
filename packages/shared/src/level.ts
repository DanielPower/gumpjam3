import * as THREE from "three";
import type { RunLimits } from "./run";
import { TIME_STEP, type Inventory } from "./simulation";
import { mapBrushGeometry, parseTrenchBroomMap, type TrenchBroomMap } from "./trenchbroom-map";

const DEFAULT_INVENTORY: Inventory = { force: 2, box: 1, mine: 0 };
const DEFAULT_QUIET_SECONDS = 3;
/** Hard limit on a run, so a loop that keeps dealing damage can't go forever. */
const MAX_RUN_SECONDS = 60;

export type Level = {
  map: TrenchBroomMap;
  inventory: Inventory;
  /** When runs end. Every client and the server use the same limits. */
  runLimits: RunLimits;
  /** How many placements of any kind the level allows in total. */
  maxPlacements: number;
  /** World-space bounds of the level geometry. */
  bounds: THREE.Box3;
};

/**
 * Parse a level. Settings come from worldspawn keys, e.g. "inventory_force" "3",
 * "inventory_box" "1", "inventory_mine" "2", "run_quiet_seconds" "3".
 */
export function loadLevel(source: string): Level {
  const map = parseTrenchBroomMap(source);
  const worldspawn = map.entities.find((e) => e.properties.classname === "worldspawn")?.properties ?? {};

  const inventory = { ...DEFAULT_INVENTORY };
  for (const kind of Object.keys(inventory) as (keyof Inventory)[]) {
    const value = Number(worldspawn[`inventory_${kind}`]);
    if (Number.isInteger(value) && value >= 0) inventory[kind] = value;
  }

  let quietSeconds = Number(worldspawn.run_quiet_seconds ?? DEFAULT_QUIET_SECONDS);
  if (!(quietSeconds > 0 && quietSeconds <= MAX_RUN_SECONDS)) quietSeconds = DEFAULT_QUIET_SECONDS;
  const runLimits: RunLimits = {
    quietSteps: Math.round(quietSeconds / TIME_STEP),
    maxSteps: Math.round(MAX_RUN_SECONDS / TIME_STEP),
  };

  const bounds = new THREE.Box3();
  for (const brush of mapBrushGeometry(map)) for (const vertex of brush.vertices) bounds.expandByPoint(vertex);

  const maxPlacements = Object.values(inventory).reduce((sum, n) => sum + n, 0);
  return { map, inventory, runLimits, maxPlacements, bounds };
}
