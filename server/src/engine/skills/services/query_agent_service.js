import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { QueryAgent } from "../../agents/query_agent.js";
import { AgentContext } from "../../core/agent_context.js";
import { runAgent } from "../../core/base_agent.js";
import { BusinessDataSources } from "../../datasources/business_data_sources.js";
import { createServiceToolResult } from "../service_skill_contract.js";

const ARTIFACT_TYPES = new Set(["table", "big_table", "chart", "echarts", "vega_lite", "image", "file"]);
const CHILD_FINAL_CATEGORIES = new Set(["final_result", "final_answer", "answer_table"]);
const RESULT_VIEW_MAX_ROWS = 50;

function markdownTableRow(line) {
  const text = String(line || "").trim();
  if (!text.includes("|")) return [];
  const inner = text.startsWith("|") ? text.slice(1) : text;
  const normalized = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return normalized.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function isMarkdownSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(" ", "")));
}

export function extractAnswerTable(answer) {
  const lines = String(answer || "").split(/\r?\n/);
  let selected = null;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const columns = markdownTableRow(lines[index]);
    const separator = markdownTableRow(lines[index + 1]);
    if (!columns.length || columns.length !== separator.length || !isMarkdownSeparator(separator)) continue;
    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownTableRow(lines[rowIndex]);
      if (!row.length) break;
      rows.push(columns.map((_, columnIndex) => row[columnIndex] ?? ""));
    }
    if (rows.length) {
      selected = {
        columns,
        rows: rows.slice(0, RESULT_VIEW_MAX_ROWS),
        row_count: rows.length,
        truncated: rows.length > RESULT_VIEW_MAX_ROWS,
      };
    }
  }
  return selected;
}

function fieldName(field) {
  if (typeof field === "string") return field;
  if (!field || typeof field !== "object") return "";
  return String(field.name || field.key || field.dataIndex || field.field || field.column_name || field.id || "").trim();
}

export function captureQueryResultView(content, options = {}) {
  const category = String(options.msg_category || "").trim();
  if (!CHILD_FINAL_CATEGORIES.has(category)) return null;

  let payload = content;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      const table = extractAnswerTable(payload);
      return table
        ? {
            content_type: "table",
            title: String(options.title || "").trim(),
            columns: table.columns,
            rows: table.rows,
            row_count: table.row_count,
            truncated: table.truncated,
          }
        : null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const rows = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.rows)
      ? payload.rows
      : Array.isArray(payload.table?.data)
        ? payload.table.data
        : [];
  if (!rows.length) return null;

  const declaredColumns = [
    ...(Array.isArray(payload.fields) ? payload.fields : []),
    ...(Array.isArray(payload.columns) ? payload.columns : []),
    ...(Array.isArray(payload.table?.columns) ? payload.table.columns : []),
  ].map(fieldName).filter(Boolean);
  const inferredColumns = rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])
    ? Object.keys(rows[0])
    : [];
  const columns = [...new Set(declaredColumns.length ? declaredColumns : inferredColumns)];
  return {
    content_type: String(payload.display_type || options.content_type || "table"),
    title: String(payload.title || options.title || "").trim(),
    columns,
    rows: rows.slice(0, RESULT_VIEW_MAX_ROWS),
    row_count: Math.max(rows.length, Number(payload.total_row_count || payload.row_count) || 0),
    truncated: Boolean(payload.truncated) || rows.length > RESULT_VIEW_MAX_ROWS,
  };
}

export function buildManagedChildStreamOptions(options = {}, { contentId, toolCallId, skillName } = {}) {
  const childCategory = String(options.msg_category || "").trim();
  const isChildFinal = CHILD_FINAL_CATEGORIES.has(childCategory);
  return {
    ...options,
    content_id: contentId,
    parent_tool_call_id: toolCallId,
    service: "query_agent",
    skill_name: skillName,
    ...(isChildFinal
      ? {
          msg_category: "tool_result",
          child_msg_category: childCategory,
          child_final: true,
        }
      : {}),
  };
}

export function buildQueryServiceModelResult(details = {}) {
  const answerTable = details.answer_table || extractAnswerTable(details.answer);
  return {
    status: details.status,
    answer: details.answer,
    warning: details.warning || undefined,
    error_code: details.error_code || undefined,
    stop_reason: details.stop_reason || undefined,
    model_turns: Math.max(0, Number(details.model_turns) || 0),
    ...(Number(details.model_timeout_ms) > 0 ? { model_timeout_ms: Number(details.model_timeout_ms) } : {}),
    sources: details.sources,
    artifacts: details.artifacts,
    ...(answerTable ? { answer_table: answerTable } : {}),
    ...(Array.isArray(details.result_views) && details.result_views.length ? { result_views: details.result_views } : {}),
    ...(details.capabilities ? { capabilities: details.capabilities } : {}),
    ...(details.provider ? { provider: details.provider } : {}),
    ...(details.model ? { model: details.model } : {}),
    ...(details.evidence ? { evidence: details.evidence } : {}),
  };
}

export function buildManagedQueryToolResult(details = {}) {
  return createServiceToolResult({
    modelResult: buildQueryServiceModelResult(details),
    details,
    // QueryAgent 是 WorkspaceAgent 托管的叶子执行器。查询结果返回父 Agent，
    // 由父 Agent 结合原始会话判断是否继续查询以及如何完成本轮回答。
    terminate: details.status === "needs_input",
  });
}

export function buildDelegatedQueryTask(params = {}) {
  const question = String(params.question || '').trim();
  const resolvedContext = String(params.resolved_context || '').trim();
  const answerRequirements = String(params.answer_requirements || '').trim();
  const presentationHint = String(params.presentation_hint || '').trim();
  const sourceHints = Array.isArray(params.source_hints)
    ? params.source_hints.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return [
    question,
    resolvedContext ? `## 已确认上下文\n${resolvedContext}` : '',
    answerRequirements ? `## 回答要求\n${answerRequirements}` : '',
    sourceHints.length ? `## 已知数据源\n${sourceHints.map((item) => `- ${item}`).join('\n')}` : '',
    presentationHint ? `## 展示偏好\n${presentationHint}` : '',
  ].filter(Boolean).join('\n\n');
}

function compactCapabilities(capabilities = {}) {
  return {
    structured: Boolean(capabilities.has_structured),
    unstructured: Boolean(capabilities.has_unstructured),
    web_search: Boolean(capabilities.has_web_search),
  };
}

function listSourceNames(bds) {
  const names = [];
  for (const source of bds?.data_sources?.values?.() || []) {
    const name = String(source?.datasource_name || source?.name || source?.source_name || "").trim();
    if (name) names.push(name);
  }
  for (const name of bds?.web_search_configs?.keys?.() || []) {
    const text = String(name || "").trim();
    if (text) names.push(text);
  }
  return [...new Set(names)];
}

export function inheritQueryAgentExecutionControls(childContext, parentContext) {
  if (!childContext) return childContext;
  childContext.approval = ["ask", "auto", "full"].includes(parentContext?.approval)
    ? parentContext.approval
    : "ask";
  childContext.awaitDecision = parentContext?.awaitDecision;
  return childContext;
}

async function buildQueryContext({ db, projectId, sessionId, userId, question, parentContext, skill, toolCallId }) {
  const bds = new BusinessDataSources(projectId, projectId);
  await bds.load_sources();
  const queryAgent = await QueryAgent.from_business_context(
    db,
    bds,
    projectId,
    50,
    3,
    { transcriptMode: "embedded", outputMode: "tool_result" },
  );
  const capabilities = queryAgent.opts?.capabilities || {};
  if (!capabilities.has_any) return { bds, capabilities, childContext: null, queryAgent };

  const childContext = new AgentContext({
    task_id: randomUUID(),
    user_id: userId,
    project_id: projectId,
    session_id: sessionId,
    input_data: {
      user_message: question,
      enhanced_user_query: question,
      selected_data_profiles: "",
      project_id: projectId,
      business_id: projectId,
      data_sources_info: { business_data_sources: bds },
      session_context: [],
      session_id: sessionId,
      operators: [],
    },
  });
  childContext.parent_task_id = parentContext?.task_id || null;
  childContext.settings = parentContext?.settings || {};
  inheritQueryAgentExecutionControls(childContext, parentContext);
  childContext.db = db;
  childContext.signal = parentContext?.signal || null;
  childContext.skillDecision = {
    skill_name: skill.name,
    runtime: "service",
    reason: "workspace_agent_tool",
    normalized_message: question,
  };
  childContext.onChildAgent = parentContext?.onChildAgent;
  childContext.offChildAgent = parentContext?.offChildAgent;
  childContext.runtime = {
    ...(parentContext?.runtime || {}),
    async requestUserInput(payload = {}, { requestId, checkpoint = {} } = {}) {
      const outerCheckpoint = {
        ...checkpoint,
        tool: skill.tool_name || "query_project_data",
        inner_tool_call_id: checkpoint.tool_call_id || null,
        tool_call_id: toolCallId,
        service: "query_agent",
        skill: skill.name,
        runtime: "service",
        original_user_message: question,
        enhanced_user_query: question,
      };
      const result = typeof parentContext?.runtime?.requestUserInput === "function"
        ? await parentContext.runtime.requestUserInput(payload, { requestId, checkpoint: outerCheckpoint })
        : payload;
      parentContext.data = parentContext.data || {};
      parentContext.data._suspended_by_ask_user = true;
      parentContext.data._pending_user_input_request_id = requestId || payload.request_id || null;
      return result;
    },
  };
  return { bds, capabilities, childContext, queryAgent };
}

export async function executeQueryAgentService({
  skill,
  toolCallId,
  params,
  signal,
  agentContext,
  streamCallback,
} = {}) {
  const projectId = String(agentContext?.project_id || "").trim();
  const sessionId = String(agentContext?.session_id || agentContext?.input_data?.session_id || "").trim();
  const userId = String(agentContext?.user_id || "").trim();
  // WorkspaceAgent 拥有委派权：它结合当前轮次、历史上下文和项目状态，决定交给 QueryAgent 的任务。
  // 这里不能用当前 user_message 覆盖 params.question；当前消息不一定等于用户的完整真实意图。
  const question = String(params?.question || "").trim();
  const delegatedTask = buildDelegatedQueryTask(params);
  if (!projectId || projectId === "__chat__" || projectId.startsWith("folder:")) {
    return {
      status: "unavailable",
      answer: "",
      warning: "当前不是问数项目，无法查询项目数据。",
      sources: [],
      artifacts: [],
    };
  }
  if (!question) {
    return { status: "failed", answer: "", warning: "查询问题不能为空。", sources: [], artifacts: [] };
  }

  const db = agentContext?.db;
  const artifacts = [];
  const resultViews = new Map();
  const childStream = async (content, options = {}) => {
    const originalId = String(options.content_id || randomUUID());
    const contentId = `service:${toolCallId}:${originalId}`;
    if (ARTIFACT_TYPES.has(options.content_type)) {
      artifacts.push({ id: contentId, type: options.content_type, title: options.title || "" });
    }
    const resultView = captureQueryResultView(content, options);
    if (resultView) resultViews.set(contentId, { id: contentId, ...resultView });
    return streamCallback(content, buildManagedChildStreamOptions(options, {
      contentId,
      toolCallId,
      skillName: skill.name,
    }));
  };

  try {
    const prepared = await buildQueryContext({
      db,
      projectId,
      sessionId,
      userId,
      question: delegatedTask,
      parentContext: agentContext,
      skill,
      toolCallId,
    });
    const sources = listSourceNames(prepared.bds);
    if (!prepared.capabilities?.has_any || !prepared.childContext) {
      return {
        status: "unavailable",
        answer: "",
        warning: "该项目尚未绑定可查询的数据源，请先在项目设置中绑定数据源。",
        sources,
        artifacts,
        capabilities: compactCapabilities(prepared.capabilities),
      };
    }

    prepared.queryAgent.opts.signal = signal || null;
    const result = await runAgent(prepared.queryAgent, prepared.childContext, childStream, { method: "execute" });
    if (signal?.aborted) {
      return {
        status: "cancelled",
        answer: "",
        warning: "查询已取消。",
        error_code: "query_cancelled",
        stop_reason: "aborted",
        model_turns: Math.max(0, Number(result?.model_turns) || 0),
        sources,
        artifacts,
        capabilities: compactCapabilities(prepared.capabilities),
      };
    }
    const suspended = Boolean(result?.suspended || prepared.childContext.data?._suspended_by_ask_user);
    if (!suspended && typeof prepared.childContext.data?._finalize_plan === "function") {
      const finalPlan = await prepared.childContext.data._finalize_plan().catch(() => null);
      if (Array.isArray(finalPlan) && finalPlan.length) {
        await childStream(JSON.stringify(finalPlan), { content_id: "plan", content_type: "plan", display: false });
      }
    }
    return {
      status: suspended ? "needs_input" : result?.success === false ? "failed" : "completed",
      answer: typeof result?.answer === "string" ? result.answer.trim() : "",
      warning: result?.success === false ? String(result.error || result.message || "问数执行失败") : "",
      error_code: result?.error_code || "",
      stop_reason: result?.stop_reason || "",
      model_turns: Math.max(0, Number(result?.model_turns) || 0),
      ...(Number(result?.model_timeout_ms) > 0 ? { model_timeout_ms: Number(result.model_timeout_ms) } : {}),
      ...(result?.model_error ? { model_error: String(result.model_error) } : {}),
      evidence: result?.evidence || undefined,
      sources,
      artifacts,
      result_views: [...resultViews.values()],
      capabilities: compactCapabilities(prepared.capabilities),
      provider: typeof result?.provider === "string" ? result.provider.trim() : "",
      model: String(result?.model || "").trim(),
    };
  } catch (error) {
    return {
      status: signal?.aborted ? "cancelled" : "failed",
      answer: "",
      warning: error?.message || String(error),
      error_code: signal?.aborted ? "query_cancelled" : "query_service_error",
      stop_reason: signal?.aborted ? "aborted" : "error",
      model_turns: 0,
      sources: [],
      artifacts,
      result_views: [...resultViews.values()],
    };
  }
}

export function createQueryProjectDataTool({ skill, agentContext, streamCallback } = {}) {
  const toolName = skill?.tool_name || "query_project_data";
  return {
    name: toolName,
    description:
      "查询当前问数项目已经接入的数据。适用于统计、明细、排序、分组、表结构、字段、SQL、图表和数据源内容问题。" +
      "不要用本地文件工具猜项目数据；不要用于创建项目、导入文件或连接数据库。" +
      "QueryAgent 是你托管的叶子执行器：它返回 answer、answer_table、result_views 等工具证据，但不会替你结束父任务。" +
      "你可以按用户意图整理、汇总或转换展示；任何变化都必须由工具证据支持，不能无依据改数值、单位、列含义或增删记录。未完成时继续调用工具，最后由你回答用户。",
    parameters: Type.Object({
      question: Type.String({ description: "结合当前轮次、历史上下文和项目状态后，委派给 QueryAgent 的本次数据查询任务。" }),
      resolved_context: Type.Optional(Type.String({ description: "已经从历史对话确认的指代、实体和口径；没有则省略。" })),
      answer_requirements: Type.Optional(Type.String({ description: "用户要求的列、格式、排序、并列和说明方式；没有则省略。" })),
      source_hints: Type.Optional(Type.Array(Type.String(), { description: "已经确认可能相关的数据源名称或 source_id；不确定时省略。" })),
      presentation_hint: Type.Optional(Type.String({ description: "可选展示偏好，例如表格、柱状图、折线图。" })),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const details = await executeQueryAgentService({
        skill,
        toolCallId,
        params,
        signal,
        agentContext,
        streamCallback,
      });
      return buildManagedQueryToolResult(details);
    },
  };
}

export default createQueryProjectDataTool;
