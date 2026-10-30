import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GUIDANCE, REMINDER } from '../src/lifecycle.js';
import { TASK_DESCRIPTION, TASK_PARAMETERS } from '../src/tools.js';

test('GUIDANCE 覆盖独立目标、合并覆盖和反对机械拆分', () => {
  assert.match(GUIDANCE, /独立决策目标/);
  assert.match(GUIDANCE, /可合并/);
  assert.match(GUIDANCE, /target 要写明覆盖范围/);
  assert.match(GUIDANCE, /不要为凑数拆分文件或方法/);
});

test('GUIDANCE 覆盖 new 依据、plan 未确认范围和只读不 start', () => {
  assert.match(GUIDANCE, /new 要写清检查过的现有能力及不适用原因/);
  assert.match(GUIDANCE, /未确认范围写进.*plan/);
  assert.match(GUIDANCE, /只读、讨论、规划轮次不用 start/);
});

test('GUIDANCE 明确 need 是调查结论而非待办清单', () => {
  assert.match(GUIDANCE, /need 是调查后的结论/);
  assert.match(GUIDANCE, /不是待调查清单/);
  assert.match(GUIDANCE, /不要先填 reuse\/extend\/new 占位/);
  assert.match(GUIDANCE, /不要为数量或形式完整而登记/);
  assert.match(GUIDANCE, /弱证据只说明还没查完/);
});

test('REMINDER 与 TASK_DESCRIPTION 不鼓励未调查先登记', () => {
  assert.match(REMINDER, /need 不是待调查清单/);
  assert.match(REMINDER, /未查清不要先填 decision 占位/);
  assert.match(REMINDER, /不要为凑数登记/);
  assert.match(TASK_DESCRIPTION, /need 是调查后的结论/);
  assert.match(TASK_DESCRIPTION, /未查清不要先填 decision 占位/);
  assert.match(TASK_DESCRIPTION, /不要为数量或形式完整登记/);
});

test('REMINDER 保留按需触发并明确只读轮次忽略', () => {
  assert.match(REMINDER, /如果本轮要改代码/);
  assert.match(REMINDER, /按独立目标用 need/);
  assert.match(REMINDER, /只读、讨论、规划轮次忽略本条/);
});

test('TASK_DESCRIPTION 说明只读不必调用和 need 粒度规则', () => {
  assert.match(TASK_DESCRIPTION, /只读、讨论、规划不必调用/);
  assert.match(TASK_DESCRIPTION, /独立决策目标分别记录/);
  assert.match(TASK_DESCRIPTION, /new 要说明检查过的现有能力及不适用原因/);
  assert.match(TASK_DESCRIPTION, /needs 的粒度规则同 need/);
});

test('need schema 未增加 covers、active、parent 或稳定 id 字段', () => {
  const needProperties = TASK_PARAMETERS.properties.needs.items.properties;
  assert.deepEqual(Object.keys(needProperties), [
    'target',
    'decision',
    'evidence',
    'plan',
    'observationIds',
  ]);
  assert.equal(needProperties.target.type, 'string');
  assert.equal(needProperties.target.enum, undefined);
  assert.equal(needProperties.covers, undefined);
  assert.equal(needProperties.active, undefined);
  assert.equal(needProperties.parent, undefined);
});
