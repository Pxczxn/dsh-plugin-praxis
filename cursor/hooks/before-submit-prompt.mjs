// beforeSubmitPrompt：用户每次发消息时刷新活跃会话指针（会话本身不阻断）。
import { safe, touch } from './lib.mjs';

safe(async (input) => {
  touch(input);
  return { continue: true };
}, { continue: true });
