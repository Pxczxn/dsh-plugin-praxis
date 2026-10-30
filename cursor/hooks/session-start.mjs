// sessionStart：登记会话与工作区，供 MCP server 把后续工具调用绑定到同一会话。
import { safe, touch } from './lib.mjs';

safe(async (input) => {
  touch(input);
  return {};
});
