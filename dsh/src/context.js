// 从宿主执行上下文解析会话、Agent 与项目标识。只读，不写任何文件。
import { execFileSync } from 'node:child_process';

const PROJECT_CACHE_MS = 60_000;
const projectCache = new Map();

/**
 * 解析一个可选宿主服务。
 *
 * Cordis 只允许访问 inject 里声明过的服务：插件只 inject 了 tools，直接读
 * `ctx.sessions` / `ctx.systemPrompt` 会抛 "cannot get property ... without inject"。
 * 属性访问必须自己兜异常，再退回 ctx.get（对未声明服务返回 undefined 而不抛）。
 * 拿不到就当没有，调用方降级，不要因此让插件装配失败。
 */
export function resolveService(ctx, name) {
  try {
    const direct = ctx?.[name];
    if (direct) return direct;
  } catch {
    // 未在 inject 声明，宿主拒绝属性访问；继续走 ctx.get
  }
  try {
    return ctx?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function resolveSessions(ctx) {
  return resolveService(ctx, 'sessions');
}

function sessionHeader(ctx, sessionId) {
  if (!sessionId) return null;
  const sessions = resolveSessions(ctx);
  if (!sessions || typeof sessions.get !== 'function') return null;
  try {
    return sessions.get(sessionId)?.header ?? null;
  } catch {
    return null;
  }
}

/**
 * 是否是子代理会话。
 *
 * 宿主创建子会话时把父会话的 cwd 原样抄进 header（子会话记录里同时带
 * `parentSession` / `origin: 'subagent'` / `delegationDepth`，但 cwd 仍是父目录），
 * 而子代理完全可能被派到别的工作区干活。拿这个继承来的 cwd 推 projectKey，
 * 会把子任务记到父项目名下，项目级经验就会跨项目可见。宁可返回 null。
 */
function isChildSession(header) {
  if (!header || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true;
  return Number.isFinite(header.delegationDepth) && header.delegationDepth > 0;
}

function headerCwd(header) {
  const cwd = header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : null;
}

function gitToplevel(cwd) {
  const cached = projectCache.get(cwd);
  if (cached && Date.now() - cached.at < PROJECT_CACHE_MS) return cached.value;
  let value = null;
  if (cwd) {
    try {
      const output = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const text = String(output).trim();
      value = text === '' ? null : text;
    } catch {
      value = null;
    }
  }
  projectCache.set(cwd, { at: Date.now(), value });
  return value;
}

/**
 * 会话身份只来自宿主；模模型无法通过字符串参数冒用。
 * projectKey 仅在有明确工作区/仓库证据时给出，否则 null，不使用 unspecified 兜底。
 */
export function contextOf(exec, ctx) {
  const sessionId = exec?.agent?.id ?? null;
  return { sessionId, agentId: sessionId, ...sessionContext(ctx, sessionId) };
}

/**
 * 会话的工作区与项目键。
 *
 * pre-step 只有 agent.id、没有工具执行上下文，需要单独推导一次；与 contextOf
 * 共用同一份 60 秒缓存，不额外跑 git。
 */
export function sessionContext(ctx, sessionId) {
  const header = sessionHeader(ctx, sessionId);
  const cwd = headerCwd(header);
  if (!cwd) return { cwd: null, projectKey: null };
  // 子会话的 cwd 是父会话复制过来的，既不能当项目归属证据，也不能用来
  // 推断「这条命令在哪个项目里跑」；连 cwd 一起置空，让下游走保守判定。
  if (isChildSession(header)) return { cwd: null, projectKey: null };
  return { cwd, projectKey: gitToplevel(cwd) };
}

export function resetProjectCache() {
  projectCache.clear();
}
