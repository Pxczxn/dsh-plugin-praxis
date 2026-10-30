// 测试辅助：临时目录、子进程、MCP stdio 客户端。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const SERVER_PATH = fileURLToPath(new URL('../server/index.js', import.meta.url));
export const HOOKS_DIR = fileURLToPath(new URL('../hooks/', import.meta.url));
export const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));

export function tempDir(prefix = 'praxis-cursor-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function hookPath(name) {
  return join(HOOKS_DIR, name);
}

/** 直接写会话指针，避免测试依赖 hook 进程的启动顺序。 */
export function writeSessionFile(dir, sessionId, workspaceRoot) {
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'session.json'),
    `${JSON.stringify(
      {
        version: 1,
        active: { sessionId, workspaceRoot, at: now, event: 'test' },
        sessions: {
          [sessionId]: {
            workspaceRoot,
            startedAt: now,
            lastSeenAt: now,
            endedAt: null,
            lastEvent: 'test',
            hints: {},
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** 运行一次性 node 脚本（hook / 安装脚本），返回 stdout/stderr/退出码。 */
export function runNode(script, { args = [], input = '', env = {}, timeout = 15_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeout}ms: ${script}\n${stderr}`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** 启动 MCP server，按行收发 JSON-RPC。 */
export function startMcpServer({ env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const waiters = [];
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else lines.push(message);
  });

  const next = (timeout = 10_000) =>
    new Promise((resolvePromise, reject) => {
      if (lines.length > 0) {
        resolvePromise(lines.shift());
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for MCP response\n${stderr}`));
      }, timeout);
      waiters.push((message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
    });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  const close = () =>
    new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill();
        resolvePromise();
      }, 2000);
      child.on('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
      try {
        child.stdin.end();
      } catch {
        child.kill();
      }
    });

  return { child, send, next, close, stderr: () => stderr };
}

/** 从 tools/call 响应里取出引擎返回的 JSON。 */
export function toolPayload(response) {
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  return JSON.parse(text);
}
