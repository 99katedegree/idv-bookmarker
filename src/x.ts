import { fetchJson } from "./http.js";

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

  /** ブックマークが空になるまで「一覧取得→削除」を繰り返す。削除件数を返す */
  async deleteAllBookmarks(userId: string): Promise<number> {
    let deleted = 0;
    for (;;) {
      const page = await this.get<Page<Tweet>>(`/users/${userId}/bookmarks`, {
        max_results: "100",
      });
      const tweets = page.data ?? [];
      if (tweets.length === 0) return deleted;
      for (const t of tweets) {
        await fetchJson(`${API}/users/${userId}/bookmarks/${t.id}`, {
          method: "DELETE",
          headers: this.headers(),
        });
        deleted++;
      }
    }
  }

  async addBookmark(userId: string, tweetId: string): Promise<void> {
    await fetchJson(`${API}/users/${userId}/bookmarks`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ tweet_id: tweetId }),
    });
  }

  /**
   * 新しい順にいいねを取得し、lastLikeId に到達したら打ち切る。
   * 返す tweets は特定ハッシュタグを含むもののみ。newestId は今回見た最新のいいねID。
   */
  async fetchNewLikedTweets(
    userId: string,
    lastLikeId: string | null,
  ): Promise<{ tweets: Tweet[]; newestId: string | null }> {
    const tweets: Tweet[] = [];
    let newestId: string | null = null;
    let token: string | undefined;
    outer: for (;;) {
      const params: Record<string, string> = {
        max_results: "100",
        "tweet.fields": "author_id,entities",
      };
      if (token) params.pagination_token = token;
      const page = await this.get<Page<Tweet>>(`/users/${userId}/liked_tweets`, params);
      for (const t of page.data ?? []) {
        if (lastLikeId && BigInt(t.id) <= BigInt(lastLikeId)) break outer;
        newestId ??= t.id;
        if (hasTargetHashtag(t)) tweets.push(t);
      }
      token = page.meta?.next_token;
      if (!token) break;
    }
    return { tweets, newestId };
  }

  /** start/end の範囲で特定ツイートを検索（リポスト除く） */
  async searchTweets(start: Date, end: Date): Promise<Tweet[]> {
    const query = `(${HASHTAGS.map((h) => "#" + h).join(" OR ")}) -is:retweet`;
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

function hasTargetHashtag(t: Tweet): boolean {
  const set = new Set(HASHTAGS.map((h) => h.normalize("NFKC")));
  return (t.entities?.hashtags ?? []).some((h) => set.has(h.tag.normalize("NFKC")));
}
