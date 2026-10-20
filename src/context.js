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

function resolveCwd(ctx, sessionId) {
  if (!sessionId) return null;
  const sessions = resolveSessions(ctx);
  if (!sessions || typeof sessions.get !== 'function') return null;
  try {
    const session = sessions.get(sessionId);
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : null;
  } catch {
    return null;
  }
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
  const cwd = resolveCwd(ctx, sessionId);
  return {
    sessionId: sessionId ?? null,
    agentId: sessionId ?? null,
    cwd: cwd ?? null,
    projectKey: cwd ? gitToplevel(cwd) : null,
  };
}

export function resetProjectCache() {
  projectCache.clear();
}
