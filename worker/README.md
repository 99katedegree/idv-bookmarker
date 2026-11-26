# workers-idv-bookmarker

Cloudflare Workers の Cron Trigger から、GitHub Actions の `daily.yml` を `workflow_dispatch` で起動する Worker。

## デプロイ

```sh
cd worker
wrangler login
wrangler secret put GITHUB_TOKEN   # Fine-grained PAT（このリポジトリのみ、Actions: Read and write）
wrangler deploy
```

- 実行時刻は `wrangler.toml` の `crons`（UTC）で変更する。
- ログは `wrangler tail` で確認する。
