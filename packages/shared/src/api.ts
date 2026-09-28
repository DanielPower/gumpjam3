import type { Placement } from "./simulation";

/** Types for the leaderboard server's HTTP API. */

export const MAX_NAME_LENGTH = 24;

export type LeaderboardEntry = { id: number; rank: number; name: string; score: number; createdAt: string };

/** GET /levels/:level/scores */
export type LeaderboardResponse = { scores: LeaderboardEntry[] };

/** POST /levels/:level/scores. The server re-runs `placements` to get the score. */
export type SubmitScoreRequest = {
  name: string;
  placements: Placement[];
  claimedScore?: number;
  /** Sandbox runs have unlimited inventory and can never enter the leaderboard. */
  sandbox?: boolean;
};

export type SubmitScoreResponse = { id: number; score: number; rank: number; damage: number[] };

/** GET /levels/:level/scores/:id: an entry's run, to replay it. */
export type ReplayResponse = { id: number; name: string; score: number; placements: Placement[] };

/** Body of any 4xx response. */
export type ApiError = { error: string };
