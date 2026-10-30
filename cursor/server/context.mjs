// 把 hook 记录的活跃会话翻译成引擎需要的 ctx：{ sessionId, agentId, projectKey }。
import { activeSession } from './session.mjs';
import { projectKeyOf } from './workspace.mjs';

/** 没有 hook 会话信息时的兜底 id：任务仍可创建，只是无法自动绑定观察。 */
export const FALLBACK_SESSION_ID = 'cursor:local';

export function currentContext() {
  const active = activeSession();
  const workspaceRoot = active?.workspaceRoot ?? process.cwd();
  const sessionId = active?.sessionId ?? FALLBACK_SESSION_ID;
  return {
    sessionId,
    agentId: sessionId,
    projectKey: projectKeyOf(workspaceRoot),
  };
}
