import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BUILTIN_PI_SKILLS } from "../agents/pi_skill_registry.js";
import {
  buildDelegatedQueryTask,
  buildManagedChildStreamOptions,
  buildManagedQueryToolResult,
  captureQueryResultView,
  extractAnswerTable,
} from "./services/query_agent_service.js";

const registrySource = () => readFileSync(new URL("./service_skill_registry.js", import.meta.url), "utf8");

test("service registry exposes QueryAgent as one trusted model tool", () => {
  const smartQuery = BUILTIN_PI_SKILLS.find((skill) => skill.name === "smart_query");
  assert.equal(smartQuery.handler, "query_agent");
  assert.equal(smartQuery.tool_name, "query_project_data");
  const source = registrySource();
  assert.match(source, /\["query_agent", createQueryProjectDataTool\]/);
});

test("service registry ignores disabled and non-builtin service skills", () => {
  const source = registrySource();
  assert.match(source, /!skill\?\.builtin/);
  assert.match(source, /!\(skill\.effective_enabled \?\? skill\.is_enabled \?\? true\)/);
});

test("QueryAgent service leaves schema discovery to the project workspace", () => {
  const source = readFileSync(new URL("./services/query_agent_service.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /get_all_profiles/);
  assert.doesNotMatch(source, /loadForeignKeyText/);
  assert.match(source, /selected_data_profiles:\s*""/);
});

test("WorkspaceAgent controls the question delegated to QueryAgent", () => {
  const source = readFileSync(new URL("./services/query_agent_service.js", import.meta.url), "utf8");
  assert.match(source, /const question = String\(params\?\.question \|\| ""\)\.trim\(\)/);
  assert.doesNotMatch(source, /const originalQuestion/);
  assert.doesNotMatch(source, /originalQuestion \|\| delegatedQuestion/);
  assert.match(source, /结合当前轮次、历史上下文和项目状态/);
});

test("WorkspaceAgent can hand off resolved context and answer requirements without service rewrites", () => {
  const task = buildDelegatedQueryTask({
    question: "比较这些客户的续约金额",
    resolved_context: "这些客户指上一轮结果中的 A 和 B",
    answer_requirements: "按金额降序，保留并列",
    source_hints: ["合同库", "销售库"],
    presentation_hint: "小表格",
  });
  assert.match(task, /^比较这些客户的续约金额/);
  assert.match(task, /已确认上下文[\s\S]*A 和 B/);
  assert.match(task, /回答要求[\s\S]*保留并列/);
  assert.match(task, /已知数据源[\s\S]*合同库[\s\S]*销售库/);
  assert.match(task, /展示偏好[\s\S]*小表格/);
});

test("QueryAgent result returns to WorkspaceAgent without a final handoff", () => {
  const result = buildManagedQueryToolResult({
    status: "completed",
    answer: "查询结果",
    sources: ["销售库"],
    artifacts: [],
    evidence: { tool_calls: 2 },
  });
  assert.equal(result.handoff, undefined);
  assert.equal(result.terminate, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    status: "completed",
    answer: "查询结果",
    model_turns: 0,
    sources: ["销售库"],
    artifacts: [],
    evidence: { tool_calls: 2 },
  });
});

test("QueryAgent natural answer keeps a machine-readable table for the managing agent", () => {
  const answer = [
    "查询完成。",
    "",
    "| average_up_votes | average_down_votes |",
    "| ---: | ---: |",
    "| 182.28 | 34.08 |",
  ].join("\n");
  assert.deepEqual(extractAnswerTable(answer), {
    columns: ["average_up_votes", "average_down_votes"],
    rows: [["182.28", "34.08"]],
    row_count: 1,
    truncated: false,
  });

  const modelResult = JSON.parse(buildManagedQueryToolResult({
    status: "completed",
    answer,
    sources: [],
    artifacts: [],
  }).content[0].text);
  assert.deepEqual(modelResult.answer_table, {
    columns: ["average_up_votes", "average_down_votes"],
    rows: [["182.28", "34.08"]],
    row_count: 1,
    truncated: false,
  });
});

test("QueryAgent formatted child output is captured as evidence before it is shown by the parent", () => {
  const view = captureQueryResultView(JSON.stringify({
    display_type: "table",
    fields: [{ name: "answer" }],
    data: [{ answer: 351 }],
    total_row_count: 1,
  }), {
    content_type: "json",
    msg_category: "final_result",
    title: "查询结果",
  });

  assert.deepEqual(view, {
    content_type: "table",
    title: "查询结果",
    columns: ["answer"],
    rows: [{ answer: 351 }],
    row_count: 1,
    truncated: false,
  });
});

test("QueryAgent final display blocks stay visible as child tool results without claiming the parent final answer", () => {
  const options = buildManagedChildStreamOptions({
    content_type: "json",
    msg_category: "final_result",
    savable_to_panel: true,
  }, {
    contentId: "service:call-1:table-1",
    toolCallId: "call-1",
    skillName: "smart_query",
  });

  assert.deepEqual(options, {
    content_type: "json",
    msg_category: "tool_result",
    savable_to_panel: true,
    content_id: "service:call-1:table-1",
    parent_tool_call_id: "call-1",
    service: "query_agent",
    skill_name: "smart_query",
    child_msg_category: "final_result",
    child_final: true,
  });
});
