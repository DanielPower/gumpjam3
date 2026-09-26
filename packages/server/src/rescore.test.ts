import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import Box3D, { type Box3DModule } from "box3d.js";
import { simulateRun } from "@stairs/shared/run";
import type { Placement } from "@stairs/shared/simulation";
import { openScoreStore } from "./db";
import { loadLevels, type ServerLevel } from "./levels";
import { rescoreOutdated } from "./rescore";

const push: Placement = { kind: "force", target: { kind: "ragdoll", bone: 3 }, localPoint: [0, 0, 0], vector: [-1.2, 0.3, 0] };

let b3: Box3DModule;
let levels: Map<string, ServerLevel>;
before(async () => {
  b3 = await Box3D();
  levels = loadLevels(fileURLToPath(new URL("../../shared/levels/", import.meta.url)));
});

test("entries scored under old rules are re-scored, and invalid ones removed", () => {
  const scores = openScoreStore(":memory:");
  const level = levels.get("level1")!;
  const stale = scores.add({ level: "level1", name: "old", score: 5, damage: [], placements: [push], rules: "1:old" });
  const current = scores.add({ level: "level1", name: "new", score: 7, damage: [], placements: [], rules: level.rules });
  const invalid = scores.add({ level: "level1", name: "cheat", score: 9, damage: [], placements: [push, push, push], rules: "1:old" });

  assert.deepEqual(rescoreOutdated(b3, levels, scores), { rescored: 1, removed: 1 });
  const byName = Object.fromEntries(scores.top("level1", 10).map((e) => [e.name, e]));
  assert.equal(byName.old.score, simulateRun(b3, level.map, [push], level.runLimits).score);
  assert.equal(byName.new.score, 7, "entries under the current rules are left alone");
  assert.equal(byName.cheat, undefined);
  assert.ok(stale.id && current.id && invalid.id);
  assert.deepEqual(rescoreOutdated(b3, levels, scores), { rescored: 0, removed: 0 }, "nothing left to do");
});

test("a database from before rules were tracked is migrated and re-scored", () => {
  const dir = mkdtempSync(join(tmpdir(), "stairs-"));
  try {
    const path = join(dir, "scores.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE scores (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, name TEXT NOT NULL,
      score INTEGER NOT NULL, damage TEXT NOT NULL, placements TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
    old.prepare("INSERT INTO scores (level, name, score, damage, placements) VALUES (?, ?, ?, ?, ?)")
      .run("level1", "launch day", 2139, "[]", JSON.stringify([push]));
    old.close();

    const scores = openScoreStore(path);
    assert.deepEqual(rescoreOutdated(b3, levels, scores), { rescored: 1, removed: 0 });
    const level = levels.get("level1")!;
    assert.equal(scores.top("level1", 1)[0].score, simulateRun(b3, level.map, [push], level.runLimits).score);
    scores.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
