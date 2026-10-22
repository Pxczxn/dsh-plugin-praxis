import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHASE_A_SCENARIOS } from '../test-support/phase-a-scenarios.js';
import { evaluateDecision, hasExistingCitation } from '../test-support/phase-a-rubric.js';

function scenario(id) {
  const found = PHASE_A_SCENARIOS.find((item) => item.id === id);
  assert.ok(found, `缺少场景 ${id}`);
  return found;
}

function codes(findings) {
  return findings.map((item) => item.code);
}

test('阶段 A 基线覆盖 10 个场景且评分字段完整', () => {
  assert.equal(PHASE_A_SCENARIOS.length, 10);
  assert.equal(new Set(PHASE_A_SCENARIOS.map((item) => item.id)).size, 10);
  for (const item of PHASE_A_SCENARIOS) {
    assert.equal(typeof item.prompt, 'string');
    assert.ok(item.prompt.length > 0);
    assert.equal(typeof item.expect.shouldStart, 'boolean');
    assert.equal(typeof item.expect.minNeeds, 'number');
    assert.equal(typeof item.expect.maxNeeds, 'number');
    assert.ok(item.expect.minNeeds <= item.expect.maxNeeds);
    assert.ok(Array.isArray(item.expect.mustCover));
  }
});

test('两个接口分别登记时通过基线', () => {
  const decision = {
    should_start: true,
    needs: [
      {
        target: '接口 A 的 status 字段',
        decision: 'extend',
        evidence: 'src/a.js:10 现有接口没有 status 字段',
      },
      {
        target: '接口 B 的 status 字段',
        decision: 'extend',
        evidence: 'src/b.js:20 现有接口仍返回旧 status',
      },
    ],
  };
  assert.deepEqual(evaluateDecision(scenario('two-interfaces-different'), decision), []);
});

test('合并两个接口时 target 必须写明覆盖范围', () => {
  const decision = {
    should_start: true,
    needs: [
      {
        target: '接口 A/B 共用 CSV 序列化',
        decision: 'reuse',
        evidence: 'src/csv.js:12 现有 CSV 序列化能力',
      },
    ],
  };
  assert.deepEqual(evaluateDecision(scenario('shared-capability'), decision), []);
});

test('独立接口被合并成一条时抓出遗漏目标', () => {
  const decision = {
    should_start: true,
    needs: [
      {
        target: '接口 A 的 status 字段',
        decision: 'extend',
        evidence: 'src/a.js:10 现有接口没有 status 字段',
      },
    ],
  };
  const findings = evaluateDecision(scenario('two-interfaces-different'), decision);
  assert.ok(
    findings.some((item) => item.code === 'missing-target' && item.target === '接口 b'),
  );
});

test('简单任务被按文件/方法拆成多条时抓出过度拆分', () => {
  const decision = {
    should_start: true,
    needs: [
      { target: 'src/a.js', decision: 'extend', evidence: 'src/a.js:1 文件' },
      { target: 'handle()', decision: 'extend', evidence: 'src/a.js:10 方法' },
      { target: '空值分支', decision: 'extend', evidence: 'src/a.js:12 分支' },
    ],
  };
  const findings = evaluateDecision(scenario('simple-single-point'), decision);
  assert.ok(codes(findings).includes('over-split'));
});

test('未调查先登记 need 时抓出 premature-decision', () => {
  const decision = {
    should_start: true,
    needs: [
      {
        target: '空值分支',
        decision: 'reuse',
        evidence: '尚未读取 src/a.js:1，需要先检查空值分支',
      },
    ],
  };
  const findings = evaluateDecision(scenario('simple-single-point'), decision);
  assert.ok(codes(findings).includes('premature-decision'));
});

test('带文件行号的调查结论不报 premature-decision', () => {
  const decision = {
    should_start: true,
    needs: [
      {
        target: '空值分支',
        decision: 'reuse',
        evidence: 'src/a.js:10 已确认 handle() 在空值分支提前返回',
      },
    ],
  };
  const findings = evaluateDecision(scenario('simple-single-point'), decision);
  assert.equal(codes(findings).includes('premature-decision'), false);
});

test('现有能力已满足却登记 new 时抓出无依据 new', () => {
  const decision = {
    should_start: true,
    needs: [
      { target: 'CSV 导出', decision: 'new', evidence: 'src/csv.js:1 已实现' },
    ],
  };
  const findings = evaluateDecision(scenario('existing-satisfies'), decision);
  assert.ok(codes(findings).includes('unsupported-new'));
});

test('new 的 evidence 只有结论没有现有能力核对时抓出无依据 new', () => {
  const decision = {
    should_start: true,
    needs: [
      { target: 'YAML 解析器', decision: 'new', evidence: 'src/yaml.js:1 需要新增解析器' },
    ],
  };
  const findings = evaluateDecision(scenario('new-without-investigation'), decision);
  assert.ok(codes(findings).includes('unsupported-new'));
});

test('new 的 evidence 同时给出文件和现有能力不适用原因时通过', () => {
  const evidence =
    'src/csv.js:1 现有 CSV 解析不支持 YAML；src/yaml.js:1 缺少 YAML 入口，因此需要新增';
  assert.equal(hasExistingCitation(evidence), true);
  const decision = {
    should_start: true,
    needs: [{ target: 'YAML 解析器', decision: 'new', evidence }],
  };
  assert.deepEqual(evaluateDecision(scenario('new-without-investigation'), decision), []);
});

test('只读讨论场景被 start 时抓出误触发', () => {
  const findings = evaluateDecision(scenario('read-only-discussion'), {
    should_start: true,
    needs: [],
  });
  assert.ok(codes(findings).includes('start-mismatch'));
});

test('只读核实现有能力时不应 start，也不应登记 need', () => {
  const findings = evaluateDecision(scenario('existing-satisfies'), {
    should_start: true,
    needs: [
      { target: 'CSV 生成', decision: 'reuse', evidence: 'src/csv.js:1 已实现' },
      { target: '导出入口', decision: 'reuse', evidence: 'src/export.js:1 已接入' },
    ],
  });
  assert.ok(codes(findings).includes('start-mismatch'));
  assert.ok(codes(findings).includes('unexpected-needs'));
});

test('plan 写明其余批次后续处理也算未确认范围', () => {
  const decision = {
    should_start: true,
    needs: [
      {
        target: '提示通道',
        decision: 'extend',
        evidence: 'src/lifecycle.js:6 现有提示文案',
        plan: '本轮只处理提示通道；其余批次后续单独登记，尚未确认的范围不展开。',
      },
    ],
  };
  assert.deepEqual(evaluateDecision(scenario('huge-task'), decision), []);
});

test('大任务没有在 plan 写明未确认范围时抓出调查不完整', () => {
  const decision = {
    should_start: true,
    needs: [
      { target: '提示通道', decision: 'extend', evidence: 'src/lifecycle.js:6 现有提示文案' },
    ],
  };
  const findings = evaluateDecision(scenario('huge-task'), decision);
  assert.ok(codes(findings).includes('missing-uncertainty'));
});
