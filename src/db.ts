import { createClient, type Client } from "@libsql/client";

const MAX_ATTEMPTS = 4;

export function createDb(): Client {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
}

/** Turso へのリクエストを失敗時にリトライする */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

export async function ensureSchema(db: Client): Promise<void> {
  await withRetry(() =>
    db.batch(
      [
        "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)",
        "CREATE TABLE IF NOT EXISTS liked_authors (user_id TEXT PRIMARY KEY, added_at TEXT)",
        `CREATE TABLE IF NOT EXISTS runs (
          run_at TEXT, deleted INTEGER, excluded_total INTEGER, searched INTEGER,
          excluded INTEGER, bookmarked INTEGER, est_cost_usd REAL, error TEXT
        )`,
      ],
      "write",
    ),
  );
}

export async function getState(db: Client, key: string): Promise<string | null> {
  const r = await withRetry(() =>
    db.execute({ sql: "SELECT value FROM state WHERE key = ?", args: [key] }),
  );
  return r.rows.length ? (r.rows[0].value as string | null) : null;
}

export async function setState(db: Client, key: string, value: string): Promise<void> {
  await withRetry(() =>
    db.execute({
      sql: "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [key, value],
    }),
  );
}
