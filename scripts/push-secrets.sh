#!/usr/bin/env bash
# ローカルの .env の内容をそのまま GitHub Actions の Secrets に登録する。
# 事前に `gh auth login` 済みで、リポジトリに remote が設定されていること。
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo ".env がありません" >&2; exit 1; }

if grep -Eq '^[A-Z_]+=[[:space:]]*$' .env; then
  echo "値が空のキーがあります。.env を確認してください:" >&2
  grep -E '^[A-Z_]+=[[:space:]]*$' .env >&2
  exit 1
fi

gh secret set -f .env
