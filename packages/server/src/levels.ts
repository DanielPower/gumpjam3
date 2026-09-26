import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadLevel, type Level } from "@stairs/shared/level";
import { RULES_VERSION } from "@stairs/shared/run";

export type ServerLevel = Level & {
  /**
   * Identifies the rules a score was computed under: the scoring rules version
   * and this exact map. Scores stored under different rules get re-scored.
   */
  rules: string;
};

/** Load every `<id>.map` in `dir`, keyed by id. */
export function loadLevels(dir: string): Map<string, ServerLevel> {
  const levels = new Map<string, ServerLevel>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".map")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    const mapHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    levels.set(basename(file, ".map"), { ...loadLevel(source), rules: `${RULES_VERSION}:${mapHash}` });
  }
  if (levels.size === 0) throw new Error(`No levels found in ${dir}`);
  return levels;
}
