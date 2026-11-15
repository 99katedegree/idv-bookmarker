import { createDb, ensureSchema, getState, setState, withRetry } from "./db.js";
import { refreshAccessToken, XClient } from "./x.js";

// 推定料金（USD/件）。X API の従量課金単価に合わせて調整すること。
const COST_POST_READ = 0.005;
const COST_BOOKMARK_WRITE = 0.005;
const COST_USER_READ = 0.01;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstNow(): string {
  return new Date(Date.now() + JST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** 昨日1日分（JST 0:00〜24:00）を UTC の Date で返す。時刻で固定なので実行遅延の影響を受けない */
function yesterdayRangeJst(now = new Date()): { start: Date; end: Date } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const todayJst0 = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return {
    start: new Date(todayJst0 - 24 * 3600 * 1000 - JST_OFFSET_MS),
    end: new Date(todayJst0 - JST_OFFSET_MS),
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

async function main() {
  const db = createDb();
  await ensureSchema(db);

  const stats = { deleted: 0, excludedTotal: 0, searched: 0, excluded: 0, bookmarked: 0, cost: 0 };
  let error: string | null = null;

  try {
    // 0: トークン更新（新しいリフレッシュトークンをすぐ保存）
    const refreshToken = await getState(db, "refresh_token");
    if (!refreshToken)
      throw new Error("state.refresh_token がありません。npm run setup を実行してください");
    const tokens = await refreshAccessToken(
      env("X_CLIENT_ID"),
      env("X_CLIENT_SECRET"),
      refreshToken,
    );
    await setState(db, "refresh_token", tokens.refresh_token);

    const x = new XClient(tokens.access_token);
    const me = await x.me();
    stats.cost += COST_USER_READ;

    // 1: このツールが保存したブックマークを削除（一覧取得は行わず、DBに記録したIDで削除）
    const prev = await withRetry(() => db.execute("SELECT tweet_id FROM bookmarked_tweets"));
    for (const r of prev.rows) {
      await x.deleteBookmark(me, String(r.tweet_id));
      stats.deleted++;
    }
    await withRetry(() => db.execute("DELETE FROM bookmarked_tweets"));

    // 2: いいねした特定ツイートの投稿者を除外リストへ
    const lastLikeId = await getState(db, "last_like_id");
    const { tweets: liked, newestId } = await x.fetchNewLikedTweets(me, lastLikeId);
    stats.cost += liked.length * COST_POST_READ; // 近似（取得全件ではなく対象のみ）
    const addedAt = jstNow();
    const authors = [...new Set(liked.map((t) => t.author_id).filter((a): a is string => !!a))];
    if (authors.length) {
      await withRetry(() =>
        db.batch(
          authors.map((id) => ({
            sql: "INSERT OR IGNORE INTO liked_authors (user_id, added_at) VALUES (?, ?)",
            args: [id, addedAt],
          })),
          "write",
        ),
      );
    }
    if (newestId) await setState(db, "last_like_id", newestId);

    const rows = await withRetry(() =>
      db.execute("SELECT user_id FROM liked_authors ORDER BY added_at DESC, rowid DESC"),
    );
    const excludeSet = new Set(rows.rows.map((r) => String(r.user_id)));
    stats.excludedTotal = excludeSet.size;

    // 3: 昨日1日分を検索し、除外リストと自分の投稿を除く
    const { start, end } = yesterdayRangeJst();
    // 除外リスト（新しい順）を検索クエリ側でも除く。入りきらない分と自分の投稿は下で取り除く
    const found = await x.searchTweets(start, end, [...excludeSet]);
    stats.searched = found.length;
    stats.cost += found.length * COST_POST_READ;
    const targets = found.filter(
      (t) =>
        !t.referenced_tweets?.some((r) => r.type === "retweeted") &&
        t.author_id !== me &&
        !(t.author_id && excludeSet.has(t.author_id)),
    );
    stats.excluded = found.length - targets.length;

    // 4: ブックマーク保存
    // 先にDBへ記録してから追加する（途中で失敗しても、翌日404扱いで安全に削除できる）
    const bookmarkedAt = jstNow();
    if (targets.length) {
      await withRetry(() =>
        db.batch(
          targets.map((t) => ({
            sql: "INSERT OR IGNORE INTO bookmarked_tweets (tweet_id, bookmarked_at) VALUES (?, ?)",
            args: [t.id, bookmarkedAt],
          })),
          "write",
        ),
      );
    }
    for (const t of targets) {
      if (await x.addBookmark(me, t.id)) {
        stats.bookmarked++;
        stats.cost += COST_BOOKMARK_WRITE;
      } else {
        // ブロックされている・削除済みなど。記録から外して、除外件数に含める
        stats.excluded++;
        await withRetry(() =>
          db.execute({ sql: "DELETE FROM bookmarked_tweets WHERE tweet_id = ?", args: [t.id] }),
        );
        console.warn(`スキップ: ${t.id}`);
      }
    }
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(error);
  }

  // 5: 実行結果を記録（エラー時も記録）
  try {
    await withRetry(() =>
      db.execute({
        sql: `INSERT INTO runs (run_at, deleted, excluded_total, searched, excluded, bookmarked, est_cost_usd, error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          jstNow(),
          stats.deleted,
          stats.excludedTotal,
          stats.searched,
          stats.excluded,
          stats.bookmarked,
          stats.cost,
          error,
        ],
      }),
    );
  } catch (e) {
    console.error("runs への記録に失敗:", e);
  }

  console.log(JSON.stringify({ ...stats, error }, null, 2));
  if (error) process.exitCode = 1;
}

main();
