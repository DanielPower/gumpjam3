import type { Box3DModule } from "box3d.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import {
  MAX_NAME_LENGTH,
  type ApiError,
  type LeaderboardResponse,
  type SubmitScoreResponse,
} from "@stairs/shared/api";
import { simulateRun } from "@stairs/shared/run";
import { TIME_STEP } from "@stairs/shared/simulation";
import { parsePlacements, PlacementError, validatePlacements } from "@stairs/shared/validation";
import type { ScoreStore } from "./db";
import type { ServerLevel } from "./levels";

const DEFAULT_LEADERBOARD_SIZE = 10;
const MAX_LEADERBOARD_SIZE = 100;
const MAX_BODY_BYTES = 32 * 1024;

export type AppOptions = {
  b3: Box3DModule;
  levels: Map<string, ServerLevel>;
  scores: ScoreStore;
  /** Allowed CORS origins; "*" allows any. */
  corsOrigin?: string | string[];
};

/** Collapse whitespace and drop control characters; null if nothing is left. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function createApp({ b3, levels, scores, corsOrigin = "*" }: AppOptions) {
  const app = new Hono();
  app.use("*", cors({ origin: corsOrigin }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/levels", (c) =>
    c.json({
      levels: [...levels].map(([id, level]) => ({
        id,
        inventory: level.inventory,
        quietSeconds: level.runLimits.quietSteps * TIME_STEP,
        maxSeconds: level.runLimits.maxSteps * TIME_STEP,
      })),
    }),
  );

  app.get("/levels/:level/scores", (c) => {
    const levelId = c.req.param("level");
    if (!levels.has(levelId)) return c.json<ApiError>({ error: "Unknown level" }, 404);
    const requested = Number(c.req.query("limit") ?? DEFAULT_LEADERBOARD_SIZE);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_LEADERBOARD_SIZE)
      : DEFAULT_LEADERBOARD_SIZE;
    return c.json<LeaderboardResponse>({ scores: scores.top(levelId, limit) });
  });

  // Clients send only their setup; the score comes from re-running it here.
  app.post("/levels/:level/scores", bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
    const levelId = c.req.param("level");
    const level = levels.get(levelId);
    if (!level) return c.json<ApiError>({ error: "Unknown level" }, 404);

    const body: unknown = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return c.json<ApiError>({ error: "Expected a JSON object" }, 400);
    const { name: rawName, placements: rawPlacements, claimedScore } = body as Record<string, unknown>;

    const name = cleanName(rawName);
    if (!name) return c.json<ApiError>({ error: `name must be 1-${MAX_NAME_LENGTH} characters` }, 400);

    const { maxPlacements } = level;
    let placements;
    try {
      placements = parsePlacements(rawPlacements, maxPlacements);
      validatePlacements(b3, level, placements);
    } catch (error) {
      if (error instanceof PlacementError) return c.json<ApiError>({ error: error.message }, 400);
      throw error;
    }

    const { damage, score } = simulateRun(b3, level.map, placements, level.runLimits);
    if (typeof claimedScore === "number" && claimedScore !== score) {
      // The simulation should be deterministic, so this points at a client
      // with a different engine build, or a tampered client.
      console.warn(`Score mismatch on ${levelId}: client claimed ${claimedScore}, server got ${score}`);
    }

    const { id, rank } = scores.add({ level: levelId, name, score, damage, placements, rules: level.rules });
    return c.json<SubmitScoreResponse>({ id, score, rank, damage }, 201);
  });

  return app;
}
