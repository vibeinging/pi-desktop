import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('query agent completes through pi-agent native stop with a visible answer', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');

  assert.match(src, /finalVisibleText/);
  assert.match(src, /msg_category:\s*"final_answer"/);
  assert.match(src, /_completed_by_natural_answer/);
  assert.match(src, /completed_by:\s*"native_stop"/);
  assert.match(src, /natural_answer:\s*true/);
  assert.doesNotMatch(src, /complete_sql_required|requiresSqlCompletion|QUERY_COMPLETION_CONTRACT/);
});

test('embedded query agent returns its answer to the parent tool without emitting a second final answer', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');
  assert.match(src, /outputMode === "tool_result"/);
  assert.match(src, /const emitAssistantText = outputMode !== "tool_result"/);
  assert.match(src, /answer: terminalAnswer/);
});

test('workspace chat owns the only top-level run completion and message persistence', () => {
  const src = readFileSync('server/src/app/chat/agent_chat.js', 'utf8');
  const catchBlock = src.slice(src.indexOf('} catch (error) {'), src.indexOf('} finally {'));
  assert.match(src, /await runtime\.completeRun\(ok \? "completed" : "failed"\)/);
  assert.match(src, /await persist\(\)/);
  assert.doesNotMatch(src, /queryChat\(/);
  assert.match(catchBlock, /trace\.finish/);
});

test('query service returns natural completion to the managing WorkspaceAgent', () => {
  const src = readFileSync('server/src/engine/skills/services/query_agent_service.js', 'utf8');
  assert.match(src, /status: suspended \? "needs_input"/);
  assert.match(src, /buildManagedQueryToolResult/);
  assert.doesNotMatch(src, /finalAnswer: details\.status === "completed"/);
  assert.doesNotMatch(src, /handoffReceipt:/);
  assert.match(src, /answer: typeof result\?\.answer === "string" \? result\.answer\.trim\(\) : ""/);
  assert.doesNotMatch(src, /answer: String\(result\?\.answer/);
  assert.match(src, /不会替你结束父任务/);
  assert.doesNotMatch(src, /createAgentRuntime|createTraceRecorder|session_messages/);
});

test('workspace promotes generic service handoffs without checking a tool name', () => {
  const src = readFileSync('server/src/engine/agents/workspace_agent.js', 'utf8');
  const handoffBlock = src.slice(src.indexOf('case "tool_handoff"'), src.indexOf('case "message_update"'));
  const turnEndBlock = src.slice(src.indexOf('case "turn_end"'), src.indexOf('case "tool_handoff"'));

  assert.match(handoffBlock, /msg_category: "final_answer"/);
  assert.match(handoffBlock, /handoff_metadata/);
  assert.doesNotMatch(handoffBlock, /flush\(\)/);
  assert.match(turnEndBlock, /flush\(\)/);
  assert.doesNotMatch(handoffBlock, /query_project_data|query_agent/);
});

test('stream adapter preserves generic handoff metadata for eval and trace consumers', () => {
  const src = readFileSync('server/src/engine/stream/agent_content_adapter.js', 'utf8');
  assert.match(src, /"handoff"/);
  assert.match(src, /"handoff_metadata"/);
  assert.match(src, /"service"/);
});

test('query agent runtime prompt separates online query from offline preparation', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');
  assert.match(src, /离线准备与在线问答分开/);
  assert.match(src, /工具只负责产生证据，不负责结束任务/);
  assert.doesNotMatch(src, /QUERY_COMPLETION_CONTRACT|只有 complete_sql/);
});

test('query tool adapter exposes evidence tools without a completion tool', () => {
  const src = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  assert.doesNotMatch(src, /name:\s*["']complete_sql["']|_completed_by_complete_sql/);
  assert.match(src, /tools\.push\(wrapData\("execute_sql"/);
  assert.match(src, /tools\.push\(formatTool,\s*askUserTool\)/);
});

test('sql scan tool result exposes executed SQL for trace and eval', () => {
  const src = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  assert.match(src, /const executed_sql = operator\?\.sql \|\| ""/);
  assert.match(src, /SQL:\\n/);
  assert.match(src, /sqlText/);
});

test('query agent reads schema files directly without model-supplied schema hints', () => {
  const adapterSrc = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  const agentSrc = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');
  const workspaceSrc = readFileSync('server/src/engine/agents/query_workspace_tools.js', 'utf8');
  assert.doesNotMatch(adapterSrc, /schema_hint/);
  assert.match(adapterSrc, /createQueryCodingTools/);
  assert.match(agentSrc, /QUERY_WRITE_TOOLS/);
  assert.doesNotMatch(agentSrc, /bash_readonly/);
  assert.match(agentSrc, /inspectQueryWorkspace/);
  assert.match(agentSrc, /sourceCatalog/);
  assert.doesNotMatch(workspaceSrc, /writeFile|mkdir/);
});

test('sql scan large result preview includes tail and non-zero samples', () => {
  const src = readFileSync('server/src/engine/agents/query_tool_adapter.js', 'utf8');
  assert.match(src, /const VALUE_PREVIEW_MAX_ROWS = 30/);
  assert.match(src, /IGNORED_NUMERIC_SAMPLE_KEYS/);
  assert.match(src, /content_index/);
  assert.match(src, /buildLargeResultSummary/);
  assert.match(src, /样例\(末尾/);
  assert.match(src, /样例\(非零数值行\)/);
});

test('project agent settings expose the active query agent type', () => {
  const settingsSrc = readFileSync('server/src/engine/tools/agent_settings.js', 'utf8');
  const apiSrc = readFileSync('server/src/app/agents/index.js', 'utf8');
  assert.match(settingsSrc, /const QUERY_AGENT_TYPE = 'query_agent'/);
  assert.match(settingsSrc, /agent_type:\s*QUERY_AGENT_TYPE/);
  assert.match(apiSrc, /const QUERY_AGENT_TYPE = "query_agent"/);
});

test('functional eval knowledge is injected into the active query agent', () => {
  const src = readFileSync('eval/lib/driver.mjs', 'utf8');
  assert.match(src, /for \(const agentType of \['query_agent'\]\)/);
  assert.doesNotMatch(src, /\['super_agent',\s*'nl2sql'\]/);
});

test('unattended query eval allows QueryAgent coding tools to execute', () => {
  const src = readFileSync('eval/lib/driver.mjs', 'utf8');
  assert.match(src, /approval:\s*'full'/);
});

test('query eval stream timeout is configurable without changing the model timeout', () => {
  const src = readFileSync('eval/lib/driver.mjs', 'utf8');
  assert.match(src, /process\.env\.YIW_EVAL_STREAM_TIMEOUT_MS/);
  assert.match(src, /const DEFAULT_QUERY_MODEL_TIMEOUT_MS = 120000/);
});

test('query planning rules stay general and evidence based', () => {
  const src = readFileSync('server/src/engine/agents/query_agent.js', 'utf8');
  assert.match(src, /QUERY_PLANNING_GUARDRAILS/);
  assert.match(src, /不凭记忆猜表、字段、关系或文档内容/);
  assert.match(src, /多数据源任务/);
  assert.match(src, /不使用题型关键词或固定案例/);
  assert.ok(src.includes('systemPrompt = `${systemPrompt}\\n\\n${QUERY_PLANNING_GUARDRAILS}`'));
});

test('semantic tools describe document entity coalescing instead of single-row matching', () => {
  const extractSrc = readFileSync('server/src/engine/tools/semantic_extract_subtask.js', 'utf8');
  const filterSrc = readFileSync('server/src/engine/tools/semantic_filter_subtask.js', 'utf8');

  assert.match(extractSrc, /ID 周围的实体名词/);
  assert.match(extractSrc, /按稳定键在 SQL 中 group\/coalesce/);
  assert.match(extractSrc, /record_id/);
  assert.match(extractSrc, /linked_event_id/);
  assert.match(filterSrc, /不要要求单行同时满足所有条件/);
  assert.match(filterSrc, /按稳定键 group\/coalesce/);
});
