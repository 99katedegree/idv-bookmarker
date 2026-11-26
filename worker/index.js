// Cron Trigger から呼ばれ、GitHub Actions の workflow_dispatch を1回送るだけの Worker。
export default {
  async scheduled(_controller, env, _ctx) {
    const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "idv-bookmarker-dispatcher",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    // 成功時は 204。失敗したら例外にして、Workers のログ／メトリクスに失敗として残す
    if (res.status !== 204) {
      throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
    }
    console.log("dispatched");
  },
};
