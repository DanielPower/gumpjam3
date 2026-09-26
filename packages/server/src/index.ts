import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import Box3D from "box3d.js";
import { createApp } from "./app";
import { openScoreStore } from "./db";
import { loadLevels } from "./levels";

const port = Number(process.env.PORT ?? 3000);
const levelsDir = process.env.LEVELS_DIR ?? fileURLToPath(new URL("../../shared/levels/", import.meta.url));
const databasePath = process.env.DATABASE_PATH ?? "data/scores.db";
// Comma-separated list of allowed origins, or "*" (the default) for any.
const corsEnv = process.env.CORS_ORIGIN?.trim();
const corsOrigin = !corsEnv || corsEnv === "*" ? "*" : corsEnv.split(",").map((origin) => origin.trim());

const b3 = await Box3D();
const levels = loadLevels(levelsDir);
const scores = openScoreStore(databasePath);
const app = createApp({ b3, levels, scores, corsOrigin });

const server = serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`Listening on :${port} with levels: ${[...levels.keys()].join(", ")}`);
});

const shutdown = () => {
  server.close(() => {
    scores.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
