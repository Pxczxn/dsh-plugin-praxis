// postToolUseFailure：失败的调用也要落观察，否则它既可能被当成成功证据，
// 也无法解释为什么后续需要重跑。失败观察永远不能充当 passed 证据。
import { callIdOf, observe, parseJsonish, safe } from './lib.mjs';

safe(async (input) => {
  if (!input?.tool_name) return {};
  await observe(input, {
    tool: input.tool_name,
    args: parseJsonish(input.tool_input),
    result: {
      isError: true,
      value: {
        error: String(input.error_message ?? ''),
        failure_type: String(input.failure_type ?? ''),
      },
    },
    callId: callIdOf(input),
  });
  return {};
});
