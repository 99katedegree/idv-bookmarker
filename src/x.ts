import { fetchJson, fetchWithRetry } from "./http.js";

const API = "https://api.x.com/2";

export const HASHTAGS = [
  "第五人格自己紹介カード",
  "第5人格自己紹介カード",
  "第５人格自己紹介カード",
];

export interface Tweet {
  id: string;
  text: string;
  author_id?: string;
  entities?: { hashtags?: { tag: string }[] };
  referenced_tweets?: { type: string; id: string }[];
}

interface Page<T> {
  data?: T[];
  meta?: { next_token?: string; result_count?: number };
}

/** リフレッシュトークンでアクセストークンを取得（新しいリフレッシュトークンも返る） */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string }> {
  return fetchJson(`${API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
}

export class XClient {
  constructor(private token: string) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  private get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    return fetchJson<T>(`${API}${path}${qs ? "?" + qs : ""}`, { headers: this.headers() });
  }

  async me(): Promise<string> {
    return (await this.get<{ data: { id: string } }>("/users/me")).data.id;
  }

  /** ブックマークを追加する。blocked=投稿者にブロックされている(403)、gone=削除済み(404) */
  async addBookmark(userId: string, tweetId: string): Promise<"ok" | "blocked" | "gone"> {
    const res = await fetchWithRetry(`${API}/users/${userId}/bookmarks`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ tweet_id: tweetId }),
    });
    if (res.ok) return "ok";
    if (res.status === 403) return "blocked";
    if (res.status === 404) return "gone";
    throw new Error(`POST bookmark ${tweetId} -> ${res.status} ${await res.text()}`);
  }

  /**
   * いいねした順（新しい順）に取得し、前回の最新いいね（knownIds）のどれかに当たったら打ち切る。
   * いいね一覧はツイートIDの順ではないので、IDの大小ではなく一致で判定する。
   * 返す tweets は特定ハッシュタグを含むもののみ。seenIds は今回見たいいねID（新しい順）。
   */
  async fetchNewLikedTweets(
    userId: string,
    knownIds: Set<string>,
  ): Promise<{ tweets: Tweet[]; seenIds: string[] }> {
    const tweets: Tweet[] = [];
    const seenIds: string[] = [];
    let token: string | undefined;
    outer: for (;;) {
      const params: Record<string, string> = {
        max_results: "100",
        "tweet.fields": "author_id,entities",
      };
      if (token) params.pagination_token = token;
      const page = await this.get<Page<Tweet>>(`/users/${userId}/liked_tweets`, params);
      for (const t of page.data ?? []) {
        if (knownIds.has(t.id)) break outer;
        if (seenIds.length < LIKE_CURSOR_SIZE) seenIds.push(t.id);
        if (hasTargetHashtag(t)) tweets.push(t);
      }
      token = page.meta?.next_token;
      if (!token) break;
    }
    return { tweets, seenIds };
  }

  /** start/end の範囲で特定ツイートを検索（リポスト除く） */
  async searchTweets(start: Date, end: Date): Promise<Tweet[]> {
    const query = buildSearchQuery();
    const out: Tweet[] = [];
    let token: string | undefined;
    do {
      const params: Record<string, string> = {
        query,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        max_results: "100",
        "tweet.fields": "author_id,entities,referenced_tweets",
      };
      if (token) params.next_token = token;
      const page = await this.get<Page<Tweet>>("/tweets/search/recent", params);
      out.push(...(page.data ?? []));
      token = page.meta?.next_token;
    } while (token);
    return out;
  }
}

/** 次回の打ち切り判定に使う、直近のいいねIDの保持数 */
export const LIKE_CURSOR_SIZE = 10;

function buildSearchQuery(): string {
  return `(${HASHTAGS.map((h) => "#" + h).join(" OR ")}) -is:retweet`;
}

function hasTargetHashtag(t: Tweet): boolean {
  const set = new Set(HASHTAGS.map((h) => h.normalize("NFKC")));
  return (t.entities?.hashtags ?? []).some((h) => set.has(h.tag.normalize("NFKC")));
}
