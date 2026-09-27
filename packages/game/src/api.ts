import type {
  ApiError,
  LeaderboardResponse,
  ReplayResponse,
  SubmitScoreRequest,
  SubmitScoreResponse,
} from "@stairs/shared/api";

/**
 * The leaderboard server. Set VITE_API_URL for builds: a URL, or "/" for the
 * server the game itself was loaded from. The dev server defaults to a local
 * server. Null when there's no leaderboard to talk to.
 */
const configuredUrl = import.meta.env.VITE_API_URL?.trim();
const API_URL: string | null = configuredUrl
  ? configuredUrl.replace(/\/+$/, "")
  : import.meta.env.DEV
    ? "http://localhost:3000"
    : null;

export const leaderboardAvailable = API_URL !== null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new Error("Couldn't reach the leaderboard");
  }
  const body = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new Error(message ?? `The leaderboard returned an error (${response.status})`);
  }
  return body as T;
}

const scoresPath = (level: string) => `/levels/${encodeURIComponent(level)}/scores`;

export const fetchReplay = (level: string, id: number) =>
  request<ReplayResponse>(`${scoresPath(level)}/${id}`);

export const fetchLeaderboard = (level: string, limit: number) =>
  request<LeaderboardResponse>(`${scoresPath(level)}?limit=${limit}`);

export const submitScore = (level: string, submission: SubmitScoreRequest) =>
  request<SubmitScoreResponse>(scoresPath(level), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
