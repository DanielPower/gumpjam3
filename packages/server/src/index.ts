import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import Box3D from "box3d.js";
import { createApp } from "./app";
import { openScoreStore } from "./db";
import { loadLevels } from "./levels";
import { rescoreOutdated } from "./rescore";

const port = Number(process.env.PORT ?? 3000);
const levelsDir = process.env.LEVELS_DIR ?? fileURLToPath(new URL("../../shared/levels/", import.meta.url));
const databasePath = process.env.DATABASE_PATH ?? "data/scores.db";
// A built copy of the game to serve to browsers: GAME_DIR, or the game package's build if there is one.
const builtGame = fileURLToPath(new URL("../../game/dist/", import.meta.url));
const gameDir = process.env.GAME_DIR ?? (existsSync(builtGame) ? builtGame : undefined);
// Comma-separated list of allowed origins, or "*" (the default) for any.
const corsEnv = process.env.CORS_ORIGIN?.trim();
const corsOrigin = !corsEnv || corsEnv === "*" ? "*" : corsEnv.split(",").map((origin) => origin.trim());

const b3 = await Box3D();
const levels = loadLevels(levelsDir);
const scores = openScoreStore(databasePath);
const { rescored, removed } = rescoreOutdated(b3, levels, scores);
if (rescored || removed) console.log(`Re-scored ${rescored} entries under the current rules; removed ${removed} no longer valid`);
const app = createApp({ b3, levels, scores, corsOrigin, gameDir });

const server = serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`Listening on :${port} with levels: ${[...levels.keys()].join(", ")}`);
  console.log(gameDir ? `Serving the game from ${gameDir}` : "Not serving the game (no GAME_DIR, and the game isn't built)");
});

const shutdown = () => {
  server.close(() => {
    scores.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
