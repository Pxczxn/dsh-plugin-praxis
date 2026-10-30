// sessionEnd：标记会话结束并清掉 active 指针；fire-and-forget。
import { safe, sessionIdOf } from './lib.mjs';
import { endSession } from '../server/session.mjs';

safe(async (input) => {
  const sessionId = sessionIdOf(input);
  if (sessionId) {
    try {
      endSession(sessionId);
    } catch {
      // 清理失败不影响会话结束
    }
  }
  return {};
});
