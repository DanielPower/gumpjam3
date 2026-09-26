import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LeaderboardEntry } from "@stairs/shared/api";
import type { Placement } from "@stairs/shared/simulation";

export type StoredScore = { id: number; placements: Placement[] };

export type ScoreStore = {
  add(entry: {
    level: string;
    name: string;
    score: number;
    damage: number[];
    placements: Placement[];
    rules: string;
  }): { id: number; rank: number };
  top(level: string, limit: number): LeaderboardEntry[];
  /** Entries on `level` scored under rules other than `rules`. */
  outdated(level: string, rules: string): StoredScore[];
  rescore(id: number, entry: { score: number; damage: number[]; rules: string }): void;
  remove(id: number): void;
  close(): void;
};

/** Open (creating if needed) the score database. Pass ":memory:" for tests. */
export function openScoreStore(path: string): ScoreStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Default (rollback) journal rather than WAL: WAL doesn't work on network
  // filesystems, and production keeps the database on an NFS share.
  db.exec(`
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
  // Added after launch: which rules each score was computed under. Older rows
  // get '' and are re-scored on the next start.
  const columns = db.prepare("PRAGMA table_info(scores)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "rules")) {
    db.exec("ALTER TABLE scores ADD COLUMN rules TEXT NOT NULL DEFAULT ''");
  }

  const insert = db.prepare(
    "INSERT INTO scores (level, name, score, damage, placements, rules) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const outdated = db.prepare("SELECT id, placements FROM scores WHERE level = ? AND rules != ?");
  const update = db.prepare("UPDATE scores SET score = ?, damage = ?, rules = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM scores WHERE id = ?");
  // Ties share a rank.
  const rankOf = db.prepare("SELECT COUNT(*) + 1 AS rank FROM scores WHERE level = ? AND score > ?");
  const top = db.prepare(`
    SELECT id, name, score, created_at AS createdAt,
           RANK() OVER (ORDER BY score DESC) AS rank
    FROM scores WHERE level = ?
    ORDER BY score DESC, id
    LIMIT ?
  `);

  return {
    add({ level, name, score, damage, placements, rules }) {
      const { lastInsertRowid } = insert.run(
        level,
        name,
        score,
        JSON.stringify(damage),
        JSON.stringify(placements),
        rules,
      );
      const { rank } = rankOf.get(level, score) as { rank: number };
      return { id: Number(lastInsertRowid), rank };
    },
    top: (level, limit) => top.all(level, limit) as LeaderboardEntry[],
    outdated: (level, rules) =>
      (outdated.all(level, rules) as { id: number; placements: string }[]).map((row) => ({
        id: row.id,
        placements: JSON.parse(row.placements) as Placement[],
      })),
    rescore(id, { score, damage, rules }) {
      update.run(score, JSON.stringify(damage), rules, id);
    },
    remove(id) {
      remove.run(id);
    },
    close: () => db.close(),
  };
}
