// stop：一轮结束时只提醒一次未闭环任务（followup_message 会自动续一轮）。
// 已经在 postToolUse 提醒过的同一组缺口不会重复；loop_limit 在 hooks.json 里也是 1。
import { safe, stopNudge } from './lib.mjs';

safe(async (input) => {
  if (input?.status && input.status !== 'completed') return {};
  if (Number(input?.loop_count) > 0) return {};
  const message = await stopNudge(input);
  return message ? { followup_message: message } : {};
});
