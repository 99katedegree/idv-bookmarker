const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 429 のときはレスポンスで指定された時間だけ待つ。それ以外の失敗は指数バックオフで数回リトライ。 */
export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429) {
        const waitMs = rateLimitWaitMs(res);
        console.warn(`429: ${Math.ceil(waitMs / 1000)}秒待機 (${attempt}/${MAX_ATTEMPTS})`);
        lastError = new Error(`429 Too Many Requests: ${url}`);
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500) {
        lastError = new Error(`${res.status} ${await res.text()}`);
      } else {
        return res;
      }
    } catch (e) {
      lastError = e;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function rateLimitWaitMs(res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) return Math.max(Number(retryAfter), 1) * 1000;
  const reset = res.headers.get("x-rate-limit-reset"); // epoch秒
  if (reset) return Math.max(Number(reset) * 1000 - Date.now(), 1000) + 1000;
  return 60_000;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithRetry(url, init);
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status} ${body}`);
  return (body ? JSON.parse(body) : {}) as T;
}
