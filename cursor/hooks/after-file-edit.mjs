// afterFileEdit：编辑器确认的源码改动。记成 confirmed 观察，让任务 revision 递增、
// 之前的验证失效；MCP 工具（Write/Edit）的 postToolUse 会跳过同一类工具，避免重复。
import { editCallIdOf, observe, safe } from './lib.mjs';

safe(async (input) => {
  if (!input?.file_path) return {};
  await observe(input, {
    tool: 'edit',
    args: {
      file_path: input.file_path,
      edits: Array.isArray(input.edits) ? input.edits.length : 0,
    },
    result: { isError: false },
    callId: editCallIdOf(input),
  });
  return {};
});
