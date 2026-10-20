import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.js';
import { emptyState } from '../src/store.js';

const ctx = { sessionId: 'session-1', agentId: 'session-1', projectKey: '/repo/demo' };

function setup() {
  const state = emptyState();
  const store = {
    state,
    async load() {
      return state;
    },
    async mutate(fn) {
      const result = await fn(state);
      return result ?? state;
    },
    read() {
      return state;
    },
  };
  return { state, engine: createEngine(store) };
}

const EVIDENCE = 'src/store.js:12 原子写已实现；node --test test/store.test.js 输出 17 passed';

async function saveLesson(engine, overrides = {}) {
  return engine.lesson(ctx, {
    action: 'save',
    scope: 'project',
    projectKey: '/repo/demo',
    trigger: '写入状态文件时进程崩溃会留下半截 JSON',
    lesson: '写状态先写临时文件再 rename，读侧遇到损坏 JSON 要拒绝覆盖而不是重建空状态。',
    evidence: EVIDENCE,
    reusable_because: '任何本地状态文件都会遇到进程中断，这个模式可复用',
    tags: ['storage', 'atomic-write'],
    ...overrides,
  });
}

test('save 需要具体的可复核证据', async () => {
  const { engine } = setup();
  const weak = await saveLesson(engine, { evidence: '测试都过了，应该没问题' });
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'weak-evidence');

  const empty = await saveLesson(engine, { evidence: '' });
  assert.equal(empty.ok, false);
  assert.ok(['missing-field', 'weak-evidence'].includes(empty.code));
});

test('save 项目经验缺少 projectKey 时拒绝', async () => {
  const { engine } = setup();
  const noProject = await engine.lesson(
    { ...ctx, projectKey: null },
    {
      action: 'save',
      scope: 'project',
      trigger: '触发器',
      lesson: '结论',
      evidence: EVIDENCE,
      reusable_because: '会再次遇到',
    },
  );
  assert.equal(noProject.ok, false);
  assert.equal(noProject.code, 'missing-field');
});

test('save 写入经验并可按关键词检索', async () => {
  const { engine } = setup();
  const saved = await saveLesson(engine);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data.lesson.scope, 'project');
  assert.equal(saved.data.lesson.status, 'active');
  assert.deepEqual(saved.data.lesson.tags, ['storage', 'atomic-write']);

  const search = await engine.lesson(ctx, { action: 'search', query: '原子写 状态文件' });
  assert.equal(search.ok, true);
  assert.equal(search.data.count, 1);
  assert.equal(search.data.lessons[0].lesson_id, saved.data.lesson_id);
  assert.match(search.data.note, /线索/);
});

test('完全重复的经验不会创建第二条', async () => {
  const { engine, state } = setup();
  const first = await saveLesson(engine);
  const second = await saveLesson(engine);
  assert.equal(second.ok, true);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.lesson_id, first.data.lesson_id);
  assert.equal(state.lessons.length, 1);
});

test('高度相似的经验必须说明差异', async () => {
  const { engine } = setup();
  await saveLesson(engine);
  const similar = await saveLesson(engine, {
    lesson: '写状态先写临时文件再 rename，读侧遇到损坏 JSON 要拒绝覆盖，不要重建空状态。',
  });
  assert.equal(similar.ok, false);
  assert.equal(similar.code, 'near_duplicate');
  assert.match(similar.hint, /difference_reason/);
});

test('说明差异后可以保存相关经验，并给出相关条目提示', async () => {
  const { engine } = setup();
  await saveLesson(engine);
  const related = await saveLesson(engine, {
    trigger: '状态文件写入中途崩溃',
    lesson: '写状态先写临时文件再 rename，读侧遇到损坏 JSON 要拒绝覆盖而不是重建空状态。',
    difference_reason: '本条聚焦崩溃窗口与回退策略，上一条聚焦原子写实现',
  });
  assert.equal(related.ok, true, JSON.stringify(related));
  assert.ok(Array.isArray(related.data.related));
});

test('search 默认限制条数且不改变使用状态', async () => {
  const { engine, state } = setup();
  const saved = await saveLesson(engine);
  const before = JSON.stringify(state.lessons[0]);

  const search = await engine.lesson(ctx, { action: 'search', query: '原子写', limit: 3 });
  assert.equal(search.ok, true);
  assert.ok(search.data.count <= 3);
  assert.equal(JSON.stringify(state.lessons[0]), before);
  assert.equal(saved.ok, true);
});

test('项目经验只对同项目可见，全局经验任何项目可见', async () => {
  const { engine } = setup();
  await saveLesson(engine);
  await saveLesson(engine, {
    scope: 'global',
    projectKey: undefined,
    trigger: '跨项目都适用的锁竞争处理',
    lesson: '锁文件要带持有者信息，否则崩溃后无法判断是否可回收。',
    evidence: 'src/store.js:40 锁文件写入 pid 与 host；node --test test/store.test.js 输出 17 passed',
  });

  const own = await engine.lesson(ctx, { action: 'search', query: '锁文件 原子写' });
  assert.equal(own.data.count, 2);

  const other = await engine.lesson(
    { ...ctx, projectKey: '/repo/other' },
    { action: 'search', query: '锁文件 原子写' },
  );
  assert.equal(other.data.count, 1);
  assert.equal(other.data.lessons[0].scope, 'global');
});

test('supersedes 替代旧经验后旧条目不再出现在检索里', async () => {
  const { engine } = setup();
  const first = await saveLesson(engine);
  const second = await saveLesson(engine, {
    trigger: '写入崩溃留下半截 JSON',
    lesson: '改为先写临时文件再原子替换，并在读取失败时拒绝覆盖；比旧方案多一步 fsync。',
    difference_reason: '旧结论没有覆盖 fsync，本版补充持久化顺序',
    supersedes: first.data.lesson_id,
  });
  assert.equal(second.ok, true, JSON.stringify(second));

  const search = await engine.lesson(ctx, { action: 'search', query: '原子写 状态文件 崩溃' });
  const ids = search.data.lessons.map((item) => item.lesson_id);
  assert.ok(ids.includes(second.data.lesson_id));
  assert.ok(!ids.includes(first.data.lesson_id));
});

test('update 保留修订原因，拒绝把证据改弱', async () => {
  const { engine } = setup();
  const saved = await saveLesson(engine);
  const lessonId = saved.data.lesson_id;

  const noReason = await engine.lesson(ctx, {
    action: 'update',
    lesson_id: lessonId,
    lesson: '新表述',
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, 'missing-field');

  const weak = await engine.lesson(ctx, {
    action: 'update',
    lesson_id: lessonId,
    reason: '换个说法',
    evidence: '应该没问题',
  });
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'weak-evidence');

  const updated = await engine.lesson(ctx, {
    action: 'update',
    lesson_id: lessonId,
    reason: '补充 rename 失败的回退方案',
    lesson: '写状态先写临时文件，fsync 后 rename；rename 失败回退 copyFile 再删除临时文件。',
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.data.lesson.lesson.includes('copyFile'), true);
});

test('update 与其它经验高度相似时拒绝覆盖', async () => {
  const { engine } = setup();
  const first = await saveLesson(engine);
  const second = await saveLesson(engine, {
    trigger: '状态文件崩溃',
    lesson: '写状态先写临时文件再 rename，读侧遇到损坏 JSON 要拒绝覆盖而不是重建空状态。',
    difference_reason: '与上一条聚焦点不同',
  });
  assert.equal(second.ok, true, JSON.stringify(second));

  const conflict = await engine.lesson(ctx, {
    action: 'update',
    lesson_id: first.data.lesson_id,
    reason: '合并结论',
    lesson: second.data.lesson.lesson,
    trigger: second.data.lesson.trigger,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
});

test('retire 需要原因，退役后不能再 update 或出现在检索里', async () => {
  const { engine } = setup();
  const saved = await saveLesson(engine);
  const lessonId = saved.data.lesson_id;

  const noReason = await engine.lesson(ctx, { action: 'retire', lesson_id: lessonId });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, 'missing-field');

  const retired = await engine.lesson(ctx, {
    action: 'retire',
    lesson_id: lessonId,
    reason: '该模式已被标准库的临时文件 API 取代',
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.data.status, 'retired');

  const search = await engine.lesson(ctx, { action: 'search', query: '原子写' });
  assert.equal(search.data.count, 0);

  const update = await engine.lesson(ctx, {
    action: 'update',
    lesson_id: lessonId,
    reason: '想恢复',
    lesson: '另一段文字',
  });
  assert.equal(update.ok, false);
  assert.equal(update.code, 'invalid-state');
});

test('检索不到时给出明确提示而不是空对象', async () => {
  const { engine } = setup();
  const search = await engine.lesson(ctx, { action: 'search', query: '完全不存在的话题' });
  assert.equal(search.ok, true);
  assert.equal(search.data.count, 0);
  assert.ok(Array.isArray(search.data.lessons));
  assert.ok(search.data.note.length > 0);
});

test('未知经验动作被拒绝', async () => {
  const { engine } = setup();
  const response = await engine.lesson(ctx, { action: 'delete' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'bad-action');
});
