import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const LEVEL_PREFIX = "virtual:level/";

/**
 * Serve TrenchBroom maps from @stairs/shared as `virtual:level/<id>` modules
 * exporting the map text. Importing the .map files directly doesn't work: Vite's
 * dev server treats any request ending in .map as a source map.
 */
function levels(): Plugin {
  return {
    name: "stairs-levels",
    resolveId(id) {
      if (id.startsWith(LEVEL_PREFIX)) return `\0${id}`;
    },
    load(id) {
      if (!id.startsWith(`\0${LEVEL_PREFIX}`)) return;
      const level = id.slice(LEVEL_PREFIX.length + 1);
      if (!/^[\w-]+$/.test(level)) throw new Error(`Invalid level id '${level}'`);
      const path = fileURLToPath(import.meta.resolve(`@stairs/shared/levels/${level}.map`));
      this.addWatchFile(path);
      return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [levels()],
});
