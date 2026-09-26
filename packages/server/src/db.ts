import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Placement } from "@stairs/shared/simulation";

export type ScoreEntry = { rank: number; name: string; score: number; createdAt: string };

export type ScoreStore = {
  add(entry: { level: string; name: string; score: number; damage: number[]; placements: Placement[] }): {
    id: number;
    rank: number;
  };
  top(level: string, limit: number): ScoreEntry[];
  close(): void;
};

/** Open (creating if needed) the score database. Pass ":memory:" for tests. */
export function openScoreStore(path: string): ScoreStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      damage TEXT NOT NULL,
      placements TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS scores_by_level ON scores (level, score DESC, id);
  `);

  const insert = db.prepare(
    "INSERT INTO scores (level, name, score, damage, placements) VALUES (?, ?, ?, ?, ?)",
  );
  // Ties share a rank.
  const rankOf = db.prepare("SELECT COUNT(*) + 1 AS rank FROM scores WHERE level = ? AND score > ?");
  const top = db.prepare(`
    SELECT name, score, created_at AS createdAt,
           RANK() OVER (ORDER BY score DESC) AS rank
    FROM scores WHERE level = ?
    ORDER BY score DESC, id
    LIMIT ?
  `);

  return {
    add({ level, name, score, damage, placements }) {
      const { lastInsertRowid } = insert.run(level, name, score, JSON.stringify(damage), JSON.stringify(placements));
      const { rank } = rankOf.get(level, score) as { rank: number };
      return { id: Number(lastInsertRowid), rank };
    },
    top: (level, limit) => top.all(level, limit) as ScoreEntry[],
    close: () => db.close(),
  };
}
