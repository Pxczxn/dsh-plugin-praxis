#!/usr/bin/env node
// Praxis 的 Cursor MCP server：把 dsh/src 里的引擎（任务台账 + 错题本）挂到
// stdio JSON-RPC 上。规则全部在 core/engine.js，这里只做协议适配与会话解析。
//
// 传输：一行一个 JSON-RPC 消息（MCP stdio）。stdout 只允许协议消息，日志走 stderr。
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './core/store.js';
import { createEngine } from './core/engine.js';
import {
  LESSON_DESCRIPTION,
  LESSON_NAME,
  LESSON_PARAMETERS,
  TASK_DESCRIPTION,
  TASK_NAME,
  TASK_PARAMETERS,
} from './core/tools.js';
import { currentContext } from './context.mjs';
import { dataDir } from './session.mjs';

export const SERVER_NAME = 'praxis';
export const SERVER_VERSION = '1.1.0-beta.1';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** MCP tools/list 的返回内容。 */
export function toolDefinitions() {
  return [
    { name: TASK_NAME, description: TASK_DESCRIPTION, inputSchema: TASK_PARAMETERS },
    { name: LESSON_NAME, description: LESSON_DESCRIPTION, inputSchema: LESSON_PARAMETERS },
  ];
}

function toolErrorText(error) {
  const code = error?.code ? `[${error.code}] ` : '';
  const hint = error?.hint ? `\n提示：${error.hint}` : '';
  return `${code}${error?.message ?? String(error)}${hint}`;
}

/**
 * 创建一个可测试的协议处理器。handle() 返回要写回 stdout 的响应对象；
 * 通知（没有 id）返回 null。
 */
export function createPraxisServer({ store, engine, context = currentContext } = {}) {
  const theStore = store ?? createStore({ dir: dataDir() });
  const theEngine = engine ?? createEngine(theStore);
  const tools = toolDefinitions();

  async function callTool(name, args) {
    const ctx = await context();
    if (name === TASK_NAME) return theEngine.task(ctx, args ?? {});
    if (name === LESSON_NAME) return theEngine.lesson(ctx, args ?? {});
    return null;
  }

  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (!hasId) return null; // notification（notifications/initialized 等）

    const { id, method } = message;
    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
      if (method === 'tools/call') {
        const name = message.params?.name;
        if (typeof name !== 'string' || !name) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call 缺少工具名' } };
        }
        const args = message.params?.arguments;
        if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call 的 arguments 必须是对象' } };
        }
        const result = await callTool(name, args);
        if (!result) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${name}` } };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: result.ok === false,
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
    } catch (error) {
      if (method === 'tools/call') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: toolErrorText(error) }],
            isError: true,
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error?.message ?? 'Internal error' },
      };
    }
  }

  return { handle, tools, store: theStore, engine: theEngine };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const left = resolve(entry);
  const right = resolve(self);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function main() {
  const server = createPraxisServer();
  const write = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    server
      .handle(message)
      .then((response) => {
        if (response) write(response);
      })
      .catch((error) => {
        process.stderr.write(`[praxis] ${error?.stack ?? error}\n`);
        if (message?.id !== undefined && message?.id !== null) {
          write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: error?.message ?? 'Internal error' },
          });
        }
      });
  });

  // 协议之外的异常不能把 server 带走；Cursor 会重连并重新拉起。
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[praxis] uncaught: ${error?.stack ?? error}\n`);
  });
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`[praxis] unhandled: ${error?.stack ?? error}\n`);
  });
  process.stderr.write(`[praxis] mcp server ready (${SERVER_NAME} ${SERVER_VERSION}, data: ${dataDir()})\n`);
}

if (isMainModule()) main();
