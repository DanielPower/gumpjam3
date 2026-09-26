import * as THREE from "three";
import { TIME_STEP, type Inventory } from "./simulation";
import { mapBrushGeometry, parseTrenchBroomMap, type TrenchBroomMap } from "./trenchbroom-map";

const DEFAULT_INVENTORY: Inventory = { force: 2, box: 1 };
const DEFAULT_RUN_SECONDS = 10;
const MAX_RUN_SECONDS = 60;

export type Level = {
  map: TrenchBroomMap;
  inventory: Inventory;
  /** Every run lasts exactly this many physics steps, so scores are comparable. */
  runSteps: number;
  /** World-space bounds of the level geometry. */
  bounds: THREE.Box3;
};

/**
 * Parse a level. Settings come from worldspawn keys, e.g. "inventory_force" "3",
 * "inventory_box" "1", "run_seconds" "10".
 */
export function loadLevel(source: string): Level {
  const map = parseTrenchBroomMap(source);
  const worldspawn = map.entities.find((e) => e.properties.classname === "worldspawn")?.properties ?? {};

  const inventory = { ...DEFAULT_INVENTORY };
  for (const kind of Object.keys(inventory) as (keyof Inventory)[]) {
    const value = Number(worldspawn[`inventory_${kind}`]);
    if (Number.isInteger(value) && value >= 0) inventory[kind] = value;
  }

  let runSeconds = Number(worldspawn.run_seconds ?? DEFAULT_RUN_SECONDS);
  if (!(runSeconds > 0 && runSeconds <= MAX_RUN_SECONDS)) runSeconds = DEFAULT_RUN_SECONDS;

  const bounds = new THREE.Box3();
  for (const brush of mapBrushGeometry(map)) for (const vertex of brush.vertices) bounds.expandByPoint(vertex);

  return { map, inventory, runSteps: Math.round(runSeconds / TIME_STEP), bounds };
}
