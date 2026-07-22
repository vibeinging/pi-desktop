import test from "node:test";
import assert from "node:assert/strict";

import { listAllMcpTools, mcpToolIsReadOnly } from "./mcp_tools.js";

test("动态模块只允许明确标记为只读且非破坏性的 MCP 工具", () => {
  assert.equal(mcpToolIsReadOnly({ annotations: { readOnlyHint: true } }), true);
  assert.equal(mcpToolIsReadOnly({ annotations: { readOnlyHint: true, destructiveHint: true } }), false);
  assert.equal(mcpToolIsReadOnly({ annotations: { readOnlyHint: false } }), false);
  assert.equal(mcpToolIsReadOnly({}), false);
});

test("MCP 工具发现拒绝重复分页游标", async () => {
  const connection = {
    timeoutMs: 1_000,
    client: { listTools: async () => ({ tools: [], nextCursor: "same" }) },
  };
  await assert.rejects(() => listAllMcpTools(connection), /分页游标重复/);
});
