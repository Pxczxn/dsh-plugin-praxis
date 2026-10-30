// 阶段 A 的行为评分器：只复核“决策结构是否违反场景基线”，
// 不把测试通过等同于真实调查充分。真实 A/B 结果仍需人工看证据。

const FILE_LINE = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+:\d+/;
const EXISTING_REASON =
  /(现有|已有|不适用|不支持|缺少|未提供|无法满足|checked|existing|not applicable|unsupported)/i;
const UNCERTAINTY =
  /(未确认|待确认|不确定|待调查|尚未|暂定|待证|后续|分批|其余|unknown|unresolved)/i;
// 这些词表明 evidence 还是“待调查”动作，不是已完成的调查结论。
const PENDING_EVIDENCE =
  /(尚未|还未|未读|未查|未检查|需要先|准备先|待查|待确认|待调查|待核实|看起来|似乎)/i;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function needText(need) {
  return [need?.target, need?.plan, need?.evidence].map(asText).join(' ');
}

export function hasExistingCitation(text) {
  const value = asText(text);
  return FILE_LINE.test(value) && EXISTING_REASON.test(value);
}

export function evaluateDecision(scenario, decision) {
  const expect = scenario.expect;
  const needs = Array.isArray(decision?.needs) ? decision.needs : [];
  const findings = [];

  if (decision?.should_start !== expect.shouldStart) {
    findings.push({
      code: 'start-mismatch',
      message: `should_start=${String(decision?.should_start)}，期望 ${expect.shouldStart}`,
    });
  }
  if (needs.length < expect.minNeeds) {
    findings.push({
      code: 'insufficient-needs',
      message: `need 数量 ${needs.length} 少于下限 ${expect.minNeeds}`,
    });
  }
  if (needs.length > expect.maxNeeds) {
    const code = expect.maxNeeds === 0 ? 'unexpected-needs' : 'over-split';
    findings.push({
      code,
      message: `need 数量 ${needs.length} 超过上限 ${expect.maxNeeds}`,
    });
  }

  const allText = needs.map(needText).join(' ').toLowerCase();
  for (const expectedTarget of expect.mustCover) {
    if (!allText.includes(expectedTarget.toLowerCase())) {
      findings.push({
        code: 'missing-target',
        target: expectedTarget,
        message: `need 文本未覆盖独立目标「${expectedTarget}」`,
      });
    }
  }

  for (const need of needs) {
    if (PENDING_EVIDENCE.test(asText(need?.evidence))) {
      findings.push({
        code: 'premature-decision',
        target: asText(need?.target),
        message: 'evidence 仍是待调查占位，不能当作 need 结论',
      });
    }
  }

  if (expect.mustNotUseNew && needs.some((need) => need?.decision === 'new')) {
    findings.push({
      code: 'unsupported-new',
      message: '现有能力已满足需求，却仍登记了 new',
    });
  }

  if (expect.newEvidenceMustCiteExisting) {
    for (const need of needs.filter((item) => item?.decision === 'new')) {
      if (!hasExistingCitation(need?.evidence)) {
        findings.push({
          code: 'unsupported-new',
          target: asText(need?.target),
          message: 'new 的 evidence 未同时给出文件:行号和现有能力不适用原因',
        });
      }
    }
  }

  if (
    expect.requirePlanUncertainty &&
    !needs.some((need) => UNCERTAINTY.test(asText(need?.plan)))
  ) {
    findings.push({
      code: 'missing-uncertainty',
      message: '大任务没有在 plan 里写明尚未确认的范围',
    });
  }

  return findings;
}
