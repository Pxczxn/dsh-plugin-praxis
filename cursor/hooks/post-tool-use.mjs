// postToolUse：把成功的工具调用记成观察（证据来源），并在改动/检查之后提示闭环缺口。
import {
  baseName,
  callIdOf,
  closureHint,
  isFileEditTool,
  observe,
  parseJsonish,
  resultFromToolOutput,
  safe,
} from './lib.mjs';

safe(async (input) => {
  const tool = baseName(input?.tool_name);
  if (!tool) return {};
  // 编辑类工具由 afterFileEdit 记录：那里能拿到真实落盘的改动，且不会重复计数。
  if (isFileEditTool(tool)) return {};

  const recorded = await observe(input, {
    tool: input.tool_name,
    args: parseJsonish(input.tool_input),
    result: resultFromToolOutput(input.tool_output),
    callId: callIdOf(input),
  });
  const hint = await closureHint(recorded);
  return hint ? { additional_context: hint } : {};
});
