import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../server/core/store.js';
import { startMcpServer, tempDir, toolPayload, writeSessionFile } from '../test-support/helpers.mjs';

test('MCP：initialize / tools/list / tools/call，并把任务绑定到 hook 会话', async () => {
  const dir = tempDir();
  const workspace = tempDir('praxis-workspace-');
  writeSessionFile(dir, 'conv-mcp', workspace);
  const mcp = startMcpServer({ env: { CURSOR_PRAXIS_DATA_DIR: dir } });

  try {
    mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'praxis-test', version: '0' },
      },
    });
    const init = await mcp.next();
    assert.equal(init.result.serverInfo.name, 'praxis');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);

    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await mcp.next();
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['praxis_task', 'praxis_lesson'],
    );
    assert.equal(list.result.tools[0].inputSchema.type, 'object');

    mcp.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'praxis_task',
        arguments: {
          action: 'start',
          goal: '接入 Cursor 版',
          acceptance: [{ text: 'MCP 工具可调用', kind: 'automated' }],
        },
      },
    });
    const started = await mcp.next();
    assert.equal(started.result.isError, false);
    const payload = toolPayload(started);
    assert.equal(payload.ok, true);
    const taskId = payload.data.task_id;
    assert.ok(taskId);

    mcp.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'praxis_task', arguments: { action: 'status', task_id: taskId } },
    });
    const status = await mcp.next();
    const statusPayload = toolPayload(status);
    assert.equal(statusPayload.data.task.task_id, taskId);
    assert.equal(statusPayload.data.task.projectKey, null);

    const state = await createStore({ dir }).load();
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].sessionId, 'conv-mcp');

    mcp.send({ jsonrpc: '2.0', id: 5, method: 'unknown/method' });
    const missing = await mcp.next();
    assert.equal(missing.error.code, -32601);

    mcp.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'not_a_tool', arguments: {} },
    });
    const unknownTool = await mcp.next();
    assert.equal(unknownTool.error.code, -32602);

    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } finally {
    await mcp.close();
  }
});

test('MCP：参数错误返回 isError，而不是把 server 打挂', async () => {
  const dir = tempDir();
  writeSessionFile(dir, 'conv-bad', tempDir('praxis-workspace-'));
  const mcp = startMcpServer({ env: { CURSOR_PRAXIS_DATA_DIR: dir } });
  try {
    mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'praxis_task', arguments: { action: 'close', task_id: 'missing' } },
    });
    const response = await mcp.next();
    assert.equal(response.result.isError, true);
    const payload = toolPayload(response);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'task-not-found');

    mcp.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const pong = await mcp.next();
    assert.deepEqual(pong.result, {});
  } finally {
    await mcp.close();
  }
});
