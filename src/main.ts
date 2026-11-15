import { createDb, ensureSchema, getState, setState, withRetry } from "./db.js";
import { LIKE_CURSOR_SIZE, refreshAccessToken, XClient } from "./x.js";

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

  const stats = { excludedTotal: 0, searched: 0, excluded: 0, bookmarked: 0, blocked: 0, cost: 0 };
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

    // 2: いいねした特定ツイートの投稿者を除外リストへ
    // last_like_id には、前回までの最新いいねIDをカンマ区切りで最大10件保存する
    const prevLikeIds = (await getState(db, "last_like_id"))?.split(",").filter(Boolean) ?? [];
    const { tweets: liked, seenIds } = await x.fetchNewLikedTweets(me, new Set(prevLikeIds));
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
    if (seenIds.length) {
      const next = [...new Set([...seenIds, ...prevLikeIds])].slice(0, LIKE_CURSOR_SIZE);
      await setState(db, "last_like_id", next.join(","));
    }

    const rows = await withRetry(() => db.execute("SELECT user_id FROM liked_authors"));
    const excludeSet = new Set(rows.rows.map((r) => String(r.user_id)));
    stats.excludedTotal = excludeSet.size;

    // 3: 昨日1日分を検索し、除外リストと自分の投稿を除く
    const { start, end } = yesterdayRangeJst();
    const found = await x.searchTweets(start, end);
    stats.searched = found.length;
    stats.cost += found.length * COST_POST_READ;
    const targets = found.filter(
      (t) =>
        !t.referenced_tweets?.some((r) => r.type === "retweeted") &&
        t.author_id !== me &&
        !(t.author_id && excludeSet.has(t.author_id)),
    );
    stats.excluded = found.length - targets.length;

    // 4: ブックマーク保存（すでにブックマーク済みなら何も起きない）
    const blockedBy = new Set<string>();
    for (const t of targets) {
      const result = await x.addBookmark(me, t.id);
      if (result === "ok") {
        stats.bookmarked++;
        stats.cost += COST_BOOKMARK_WRITE;
        continue;
      }
      // ブロックされている・削除済みの投稿はブックマークしない
      if (result === "blocked") {
        if (t.author_id) blockedBy.add(t.author_id);
      } else {
        stats.excluded++;
      }
    }
    stats.blocked = blockedBy.size;
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(error);
  }

  // 5: 実行結果を記録（エラー時も記録）
  try {
    await withRetry(() =>
      db.execute({
        sql: `INSERT INTO runs (run_at, excluded_total, searched, excluded, bookmarked, blocked, est_cost_usd, error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          jstNow(),
          stats.excludedTotal,
          stats.searched,
          stats.excluded,
          stats.bookmarked,
          stats.blocked,
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
