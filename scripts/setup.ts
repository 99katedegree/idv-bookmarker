// 初回セットアップ: ローカルで一度だけ OAuth 2.0 (PKCE) 認証を行い、リフレッシュトークンを Turso に保存する。
// 事前に X Developer Portal で Callback URL に http://127.0.0.1:3000/callback を登録しておくこと。
// 実行: .env に値を入れて npm run setup
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createDb, ensureSchema, setState } from "../src/db.js";
import { fetchJson } from "../src/http.js";

const REDIRECT = "http://127.0.0.1:3000/callback";
const SCOPE = "tweet.read users.read like.read bookmark.read bookmark.write offline.access";

const clientId = process.env.X_CLIENT_ID!;
const clientSecret = process.env.X_CLIENT_SECRET!;
if (!clientId || !clientSecret) throw new Error("X_CLIENT_ID / X_CLIENT_SECRET が必要です");

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const authUrl =
  "https://x.com/i/oauth2/authorize?" +
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

console.log("次のURLをブラウザで開いて認可してください:\n\n" + authUrl + "\n");

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url!, "http://127.0.0.1:3000");
    if (u.pathname !== "/callback") return void res.writeHead(404).end();
    if (u.searchParams.get("state") !== state || !u.searchParams.get("code")) {
      res.writeHead(400).end("invalid callback");
      server.close();
      return reject(new Error("state 不一致または code なし"));
    }
    res
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("認可完了。ターミナルに戻ってください。");
    server.close();
    resolve(u.searchParams.get("code")!);
  }).listen(3000, "127.0.0.1");
});

const tokens = await fetchJson<{ refresh_token?: string }>("https://api.x.com/2/oauth2/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: clientId,
  }),
});
if (!tokens.refresh_token)
  throw new Error("refresh_token が返りませんでした (offline.access scope を確認)");

const db = createDb();
await ensureSchema(db);
await setState(db, "refresh_token", tokens.refresh_token);
console.log("リフレッシュトークンを state テーブルに保存しました。");
