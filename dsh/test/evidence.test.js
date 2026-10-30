import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  PraxisError,
  clip,
  normalize,
  evidenceSignals,
  evidenceStrength,
  evidenceGaps,
  similarity,
  relevance,
  id,
} from '../src/evidence.js';

test('空证据没有强度', () => {
  assert.equal(evidenceStrength(''), 'none');
  assert.equal(evidenceStrength('   \n  '), 'none');
  assert.equal(evidenceStrength(undefined), 'none');
});

test('只提文件名是弱证据，文件加行号才是具体证据', () => {
  assert.equal(evidenceStrength('见 src/store.js 的写入逻辑'), 'weak');
  assert.equal(evidenceStrength('见 src/store.js:120 的写入逻辑'), 'concrete');
  assert.equal(evidenceStrength('src/engine.js:1020-1040 实现了查重'), 'concrete');
});

test('中文行号写法也识别', () => {
  assert.equal(evidenceStrength('第 12 行写了 rename'), 'weak');
  assert.equal(evidenceStrength('文件 src/store.js 第 12 行写了 rename'), 'concrete');
});

test('命令本身是弱证据，命令带输出或结果才具体', () => {
  assert.equal(evidenceStrength('npm test'), 'weak');
  assert.equal(evidenceStrength('npm test 输出 17 passed, 0 failed'), 'concrete');
  assert.equal(evidenceStrength('node --test\nstdout: 48 tests passed'), 'concrete');
  assert.equal(evidenceStrength('node --test\n退出码 0'), 'concrete');
  assert.equal(evidenceStrength('node --test → 113 pass 0 fail'), 'concrete');
});

test('引用要配合可核对结果才算具体', () => {
  assert.equal(evidenceStrength('> state.json is not valid JSON'), 'weak');
  assert.equal(
    evidenceStrength('> re-ran the check: state.json is not valid JSON, exit code 1'),
    'concrete',
  );
});

test('文件与命令同时出现即具体，不必有行号', () => {
  assert.equal(evidenceStrength('src/store.js 由 npm test 覆盖'), 'concrete');
});

test('URL 里的路径不会被当成文件证据，避免把链接当本地定位', () => {
  const signals = evidenceSignals('https://example.com/a/b.js 里说的一样');
  assert.equal(signals.file, false);
  assert.equal(evidenceStrength('https://example.com/a/b.js 里说的一样'), 'weak');
});

test('信号检测是并列事实，便于 tool 输出自检提示', () => {
  const signals = evidenceSignals('node --test\nstdout: 12 passed\n见 src/x.js:8');
  assert.deepEqual(signals, {
    file: true,
    line: true,
    command: true,
    output: true,
    quote: false,
    result: true,
  });
});

test('缺证据时给出可操作提示，具体证据也可以提示缺结果', () => {
  assert.deepEqual(evidenceGaps(''), ['证据为空']);
  const weak = evidenceGaps('我觉得应该没问题');
  assert.ok(weak.length >= 1);
  const concrete = evidenceGaps('src/store.js:12 实现了原子写');
  assert.deepEqual(concrete, ['缺少可核对的结果（tests passed/failed、exit code 等）']);
});

test('clip 截断补齐省略号，不超长', () => {
  assert.equal(clip('abcdefgh', 5), 'abcd…');
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip(null), '');
  assert.equal(clip('a\r\nb').includes('\r'), false);
  assert.equal(clip('x', LIMITS.note).length, 1);
});

test('normalize 去掉标点并折叠空白', () => {
  assert.equal(normalize('写状态, 先写--临时文件!'), '写状态 先写 临时文件');
  assert.equal(normalize('  A  B  '), 'a b');
  assert.equal(normalize(null), '');
});

test('相似度是字符二元组 Jaccard，完全相同为 1、无关为 0', () => {
  assert.equal(similarity('原子写 临时文件', '原子写 临时文件'), 1);
  assert.equal(similarity('原子写', '完全不同的另一句话'), 0);
  const near = similarity(
    '写状态先写临时文件再 rename，读侧遇到损坏 JSON 要拒绝覆盖而不是重建空状态',
    '写状态先写临时文件再 rename，读侧遇到损坏 JSON 要拒绝覆盖而不是重建空态',
  );
  assert.ok(near > 0.85 && near < 1, `期望近似但不相同，实际 ${near}`);
  assert.equal(similarity('原子写 临时文件', '原子写 临时文件'), similarity('原子写 临时文件', '原子写 临时文件'));
});

test('相关性偏好覆盖查询词的结果', () => {
  const onTopic = relevance('原子写 状态文件', '写状态先写临时文件再 rename，避免半截 JSON');
  const offTopic = relevance('原子写 状态文件', '前端按钮点击后提交表单');
  assert.ok(onTopic > offTopic, `${onTopic} 应大于 ${offTopic}`);
  assert.equal(relevance('', '任意文本'), 0);
});

test('id 带前缀且每次不同', () => {
  const a = id('task');
  const b = id('task');
  assert.match(a, /^task-[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
  assert.match(id(), /^[0-9a-f-]{36}$/);
});

test('PraxisError 携带机器可读的错误码与提示', () => {
  const error = new PraxisError('weak-evidence', '证据不足', { hint: '补行号', changed: true });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'PraxisError');
  assert.equal(error.code, 'weak-evidence');
  assert.equal(error.message, '证据不足');
  assert.equal(error.hint, '补行号');
  assert.equal(error.changed, true);

  const plain = new PraxisError('x', 'y');
  assert.equal(plain.hint, null);
  assert.equal(plain.changed, false);
});
