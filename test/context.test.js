import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contextOf, resetProjectCache, resolveService } from '../src/context.js';

// Cordis 宿主只允许访问 inject 里声明过的服务。插件只 inject ['tools']，
// 因此 ctx.sessions 的 getter 会抛错，必须由 contextOf 自己降级到 ctx.get。
function cordisCtx(overrides = {}) {
  return {
    tools: { register() {} },
    get(name) {
      if (name === 'sessions') return { get: () => ({ header: { cwd: '/repo/demo' } }) };
      return undefined;
    },
    get sessions() {
      throw new Error('cannot get property "sessions" without inject');
    },
    ...overrides,
  };
}

test('contextOf 在未 inject sessions 的宿主下不抛错，并退回 ctx.get 解析会话', () => {
  const out = contextOf({ agent: { id: 'session-1' } }, cordisCtx());
  assert.equal(out.sessionId, 'session-1');
  assert.equal(out.agentId, 'session-1');
  assert.equal(out.cwd, '/repo/demo');
});

test('contextOf 在所有会话来源都不可用时返回空标识而不是抛错', () => {
  const ctx = {
    tools: { register() {} },
    get() {
      throw new Error('service not available');
    },
    get sessions() {
      throw new Error('cannot get property "sessions" without inject');
    },
  };
  const out = contextOf({ agent: { id: 'session-1' } }, ctx);
  assert.deepEqual(out, { sessionId: 'session-1', agentId: 'session-1', cwd: null, projectKey: null });
});

test('contextOf 缺少 ctx 时仍返回形状完整的空上下文', () => {
  const out = contextOf(undefined, undefined);
  assert.deepEqual(out, { sessionId: null, agentId: null, cwd: null, projectKey: null });
});

test('会话身份只来自宿主 exec，不接受调用参数里的伪造值', () => {
  const out = contextOf({ agent: { id: 'real-session' }, arguments: { sessionId: 'forged' } }, cordisCtx());
  assert.equal(out.sessionId, 'real-session');
});

test('ctx.sessions 可用时优先使用属性而不是 ctx.get', () => {
  const ctx = {
    tools: { register() {} },
    sessions: { get: () => ({ header: { cwd: '/from-property' } }) },
    get() {
      throw new Error('ctx.get should not be consulted when the property exists');
    },
  };
  assert.equal(contextOf({ agent: { id: 'session-1' } }, ctx).cwd, '/from-property');
});

test('resolveService 在属性访问被宿主拒绝时退回 ctx.get', () => {
  const service = { section() {} };
  const ctx = {
    get(name) {
      return name === 'systemPrompt' ? service : undefined;
    },
    get systemPrompt() {
      throw new Error('cannot get property "systemPrompt" without inject');
    },
  };
  assert.equal(resolveService(ctx, 'systemPrompt'), service);
});

test('resolveService 属性可用时优先用属性，都不存在时返回 null 且不抛错', () => {
  const direct = { section() {} };
  assert.equal(
    resolveService(
      {
        systemPrompt: direct,
        get() {
          throw new Error('ctx.get should not be consulted when the property exists');
        },
      },
      'systemPrompt',
    ),
    direct,
  );
  assert.equal(
    resolveService(
      {
        get() {
          throw new Error('service not available');
        },
        get logger() {
          throw new Error('cannot get property "logger" without inject');
        },
      },
      'logger',
    ),
    null,
  );
  assert.equal(resolveService(undefined, 'sessions'), null);
});

test('子代理会话的 cwd 是父会话复制来的，不能据此把子任务记到父项目名下', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-child-'));
  try {
    // 把目录做成真正的 git 仓库：父会话在这里能得到正确的 projectKey，
    // 子会话即使 header.cwd 指向同一个仓库，也必须拒绝推断。
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore', windowsHide: true });
    resetProjectCache();

    const childHeader = {
      cwd: dir,
      // 宿主 childSessionMeta 的真实字段（见 ~/.dsh/sessions 下子会话记录）。
      parentSession: 'session-parent',
      origin: 'subagent',
      delegationDepth: 1,
    };
    const childCtx = {
      tools: { register() {} },
      get(name) {
        return name === 'sessions' ? { get: () => ({ header: childHeader }) } : undefined;
      },
    };
    const child = contextOf({ agent: { id: 'session-child' } }, childCtx);
    assert.equal(child.cwd, null, '继承来的工作目录不是子会话自己的证据');
    assert.equal(child.projectKey, null, '子代理可能在别的工作区执行，不能冒用父项目');

    // 同一目录上的父会话仍然照常解析项目。
    const parentCtx = {
      tools: { register() {} },
      get(name) {
        return name === 'sessions' ? { get: () => ({ header: { cwd: dir } }) } : undefined;
      },
    };
    const parent = contextOf({ agent: { id: 'session-parent' } }, parentCtx);
    assert.equal(parent.cwd, dir);
    assert.ok(parent.projectKey, '父会话的项目归属不能被一起废掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
    resetProjectCache();
  }
});

test('resetProjectCache 后仍能安全解析，且 cwd 缺失时不猜测 projectKey', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-context-'));
  try {
    resetProjectCache();
    const ctx = {
      tools: { register() {} },
      get(name) {
        return name === 'sessions' ? { get: () => ({ header: { cwd: dir } }) } : undefined;
      },
    };
    const out = contextOf({ agent: { id: 'session-1' } }, ctx);
    assert.equal(out.cwd, dir);
    // 临时目录通常不是仓库；这里只要求「不抛错且不是 undefined 兜底字符串」。
    assert.ok(out.projectKey === null || typeof out.projectKey === 'string');
    assert.notEqual(out.projectKey, 'unspecified');
  } finally {
    await rm(dir, { recursive: true, force: true });
    resetProjectCache();
  }
});
