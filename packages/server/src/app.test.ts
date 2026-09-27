import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import type { ApiError, LeaderboardResponse, SubmitScoreResponse } from "@stairs/shared/api";
import { simulateRun } from "@stairs/shared/run";
import type { Placement } from "@stairs/shared/simulation";
import { createApp } from "./app";
import { openScoreStore } from "./db";
import { loadLevels } from "./levels";

const levelsDir = fileURLToPath(new URL("../../shared/levels/", import.meta.url));

// A push down the stairs, and a box resting on the top landing.
const push: Placement = {
  kind: "force",
  target: { kind: "ragdoll", bone: 3 },
  localPoint: [0, 0, 0],
  vector: [-1.2, 0.3, 0],
};
const restingBox: Placement = { kind: "box", id: 1, position: [10, 12.25, 1] };

const json = async <T>(res: Response) => (await res.json()) as T;

let b3: Box3DModule;
before(async () => {
  b3 = await Box3D();
});

function setup() {
  const levels = loadLevels(levelsDir);
  const app = createApp({ b3, levels, scores: openScoreStore(":memory:") });
  const submit = (body: unknown, level = "level1") =>
    app.request(`/levels/${level}/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, levels, submit };
}

describe("POST /levels/:level/scores", () => {
  test("scores a setup by re-running it", async () => {
    const { levels, submit } = setup();
    const level = levels.get("level1")!;
    const expected = simulateRun(b3, level.map, [push, restingBox], level.runLimits);
    assert.ok(expected.score > 0);

    const res = await submit({ name: "  Daniel ", placements: [push, restingBox], claimedScore: 1 });
    assert.equal(res.status, 201);
    const body = await json<SubmitScoreResponse>(res);
    assert.equal(body.score, expected.score, "server ignores the claimed score");
    assert.equal(body.rank, 1);
  });

  const rejects: [string, unknown, RegExp][] = [
    ["too many forces", { name: "x", placements: [push, push, push] }, /allows 2 force/],
    ["a force over maximum strength", { name: "x", placements: [{ ...push, vector: [-5, 0, 0] }] }, /too strong/],
    ["a force attached far from its body", { name: "x", placements: [{ ...push, localPoint: [0, 3, 0] }] }, /too far/],
    ["a missing bone", { name: "x", placements: [{ ...push, target: { kind: "ragdoll", bone: 99 } }] }, /no ragdoll bone/],
    ["a force on a missing box", { name: "x", placements: [{ ...push, target: { kind: "prop", id: 7 } }] }, /missing box/],
    ["a box sunk into the stairs", { name: "x", placements: [{ ...restingBox, position: [10, 12, 1] }] }, /overlaps/],
    ["a box outside the level", { name: "x", placements: [{ ...restingBox, position: [500, 12.25, 1] }] }, /outside/],
    [
      "overlapping boxes",
      { name: "x", placements: [restingBox, { ...restingBox, id: 2, position: [10.2, 12.25, 1] }] },
      /overlaps/,
    ],
    ["malformed placements", { name: "x", placements: [{ kind: "force", vector: "fast" }] }, /target must be/],
    ["an empty name", { name: "   ", placements: [push] }, /name/],
  ];
  for (const [what, body, message] of rejects) {
    test(`rejects ${what}`, async () => {
      const res = await setup().submit(body);
      assert.equal(res.status, 400);
      assert.match((await json<ApiError>(res)).error, message);
    });
  }

  test("404s for an unknown level", async () => {
    const res = await setup().submit({ name: "x", placements: [push] }, "nope");
    assert.equal(res.status, 404);
  });
});

describe("GET /levels/:level/scores", () => {
  test("lists the best scores first", async () => {
    const { app, submit } = setup();
    await submit({ name: "gentle", placements: [] });
    await submit({ name: "shove", placements: [push] });
    const res = await app.request("/levels/level1/scores?limit=5");
    const { scores } = await json<LeaderboardResponse>(res);
    assert.deepEqual(
      scores.map((s) => [s.rank, s.name]),
      [[1, "shove"], [2, "gentle"]],
    );
    assert.ok(scores[0].score > scores[1].score);
  });
});

test("the server serves the game to browsers, alongside the API", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const gameDir = mkdtempSync(join(tmpdir(), "stairs-game-"));
  mkdirSync(join(gameDir, "assets"));
  writeFileSync(join(gameDir, "index.html"), "<!doctype html><title>Stairs</title>");
  writeFileSync(join(gameDir, "assets", "index-abc123.js"), "console.log('game')");
  const app = createApp({ b3, levels: loadLevels(levelsDir), scores: openScoreStore(":memory:"), gameDir });

  const page = await app.request("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Stairs<\/title>/);
  assert.equal(page.headers.get("Cache-Control"), "no-cache");

  const script = await app.request("/assets/index-abc123.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("Cache-Control") ?? "", /immutable/);

  // The API still answers, and missing files are still missing.
  assert.equal((await app.request("/levels/level1/scores")).status, 200);
  assert.equal((await app.request("/nope.js")).status, 404);
  assert.equal((await app.request("/../package.json")).status, 404);
});

test("an entry's run can be fetched to replay it", async () => {
  const { app, submit } = setup();
  const placements = [restingBox];
  const submitted = await json<SubmitScoreResponse>(await submit({ name: "Replayer", placements }));

  const res = await app.request(`/levels/level1/scores/${submitted.id}`);
  assert.equal(res.status, 200);
  const replay = await json<{ id: number; name: string; score: number; placements: unknown }>(res);
  assert.deepEqual(replay, { id: submitted.id, name: "Replayer", score: submitted.score, placements });

  // Only entries on that level, and only real ones.
  assert.equal((await app.request(`/levels/level2/scores/${submitted.id}`)).status, 404);
  assert.equal((await app.request("/levels/level1/scores/999")).status, 404);
  assert.equal((await app.request("/levels/level1/scores/abc")).status, 404);
});
