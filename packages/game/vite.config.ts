import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const LEVELS_ID = "virtual:levels";

/**
 * Serve every TrenchBroom map in @stairs/shared/levels as one `virtual:levels`
 * module: an object of level id (file name) to map text. Importing the .map
 * files directly doesn't work: Vite's dev server treats any request ending in
 * .map as a source map.
 */
function levels(): Plugin {
  const dir = fileURLToPath(new URL("./", import.meta.resolve("@stairs/shared/levels/level1.map")));
  return {
    name: "stairs-levels",
    resolveId(id) {
      if (id === LEVELS_ID) return `\0${id}`;
    },
    load(id) {
      if (id !== `\0${LEVELS_ID}`) return;
      const levels: Record<string, string> = {};
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".map")).sort()) {
        this.addWatchFile(join(dir, file));
        levels[file.slice(0, -".map".length)] = readFileSync(join(dir, file), "utf8");
      }
      return `export default ${JSON.stringify(levels)};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [levels()],
});
