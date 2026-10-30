import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { tempDir } from '../test-support/helpers.mjs';

const ENV_KEYS = ['CURSOR_PRAXIS_DATA_DIR', 'PRAXIS_DATA_DIR'];

function withDataDir(dir) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CURSOR_PRAXIS_DATA_DIR = dir;
  return () => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

test('会话指针：touch / active / hint / end', async () => {
  const dir = tempDir();
  const restore = withDataDir(dir);
  try {
    const session = await import('../server/session.mjs');
    assert.equal(session.activeSession(), null);

    const record = session.touchSession({
      sessionId: 'conv-1',
      workspaceRoot: dir,
      event: 'sessionStart',
    });
    assert.equal(record.workspaceRoot, dir);
    assert.ok(existsSync(join(dir, 'session.json')));

    assert.deepEqual(
      { sessionId: session.activeSession().sessionId },
      { sessionId: 'conv-1' },
    );

    session.writeHint('conv-1', 'closure', 'task-1|understand|uncovered');
    assert.equal(session.readHint('conv-1', 'closure'), 'task-1|understand|uncovered');
    assert.equal(session.readHint('conv-2', 'closure'), null);

    session.endSession('conv-1');
    assert.equal(session.activeSession(), null);
    const book = session.readSessionBook();
    assert.equal(book.sessions['conv-1'].endedAt !== null, true);
  } finally {
    restore();
  }
});

test('会话簿有上限，且不淘汰当前活跃会话', async () => {
  const dir = tempDir();
  const restore = withDataDir(dir);
  try {
    const session = await import('../server/session.mjs');
    for (let index = 0; index < session.MAX_SESSIONS + 5; index += 1) {
      session.touchSession({ sessionId: `conv-${index}`, workspaceRoot: dir, event: 'test' });
    }
    const activeId = session.activeSession().sessionId;
    const book = session.readSessionBook();
    const ids = Object.keys(book.sessions);
    assert.ok(ids.length <= session.MAX_SESSIONS + 1);
    assert.ok(ids.includes(activeId));
  } finally {
    restore();
  }
});

test('数据目录优先级：CURSOR_PRAXIS_DATA_DIR > PRAXIS_DATA_DIR > 默认目录', async () => {
  const restore = withDataDir('');
  try {
    const session = await import('../server/session.mjs');
    process.env.PRAXIS_DATA_DIR = 'praxis-shared';
    assert.equal(session.dataDir(), resolve('praxis-shared'));
    process.env.CURSOR_PRAXIS_DATA_DIR = 'praxis-cursor';
    assert.equal(session.dataDir(), resolve('praxis-cursor'));
  } finally {
    restore();
  }
});
