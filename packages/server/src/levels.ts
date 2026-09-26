import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadLevel, type Level } from "@stairs/shared/level";

/** Load every `<id>.map` in `dir`, keyed by id. */
export function loadLevels(dir: string): Map<string, Level> {
  const levels = new Map<string, Level>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".map")) continue;
    levels.set(basename(file, ".map"), loadLevel(readFileSync(join(dir, file), "utf8")));
  }
  if (levels.size === 0) throw new Error(`No levels found in ${dir}`);
  return levels;
}
