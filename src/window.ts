const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;

/** 「1日」の始まり（JST の時）。21 なら、21:00〜翌21:00 を1日とみなす */
export const DAY_START_HOUR_JST = 21;

/**
 * 直近に終わった「1日」の範囲を返す。
 * 区切り（JST の DAY_START_HOUR_JST 時）を過ぎた最新の時刻を終端とし、その24時間前を始端とする。
 * 同じ区切りの間（次の区切りを迎えるまで）は、いつ実行しても同じ範囲になる。
 * 実行の遅れや、翌朝の手動再実行があっても、対象は変わらない。
 */
export function latestDayRange(
  now = new Date(),
  startHour = DAY_START_HOUR_JST,
): { start: Date; end: Date } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  let boundary = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), startHour);
  if (boundary > jst.getTime()) boundary -= 24 * HOUR_MS;
  const end = new Date(boundary - JST_OFFSET_MS);
  return { start: new Date(end.getTime() - 24 * HOUR_MS), end };
}
