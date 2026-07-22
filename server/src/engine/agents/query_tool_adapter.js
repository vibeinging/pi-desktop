/**
 * query_tool_adapter —— 把数据查询工具 + format_result + ask_user 收编为运行时工具。
 *
 * 设计:
 * - QueryAgent 直接使用完整代码工作区工具、execute_sql 和 WebSearchTool，不再启动 SQL/文档子 Agent。
 * - 工具 description 直接取算子实例的 .description(与 SuperAgent 同一 source of truth)。
 * - 数据类算子产出的结果落中间表(r_xxxx),并按「值依赖 ≤20 行 / 表依赖 >20 行」决定回灌给 LLM 的内容:
 *     ≤20 行 → 回全量行(模型可把字面值内联进下游 question);
 *     >20 行 → 只回 {表名, 行数, 列, 前3行样例},引导下游用 source_id=session_intermediate 查询(大结果不进上下文)。
 * - 多跳编排不靠 SuperAgent 的 orchestration 状态机:模型从工具结果看到 r_xxxx 表名 + 「## 中间结果」段,
 *   原生 function-calling 自主发起后续调用；跨源计算通过会话中间表完成。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "../../../vendor/pi/coding-agent/dist/core/tools/index.js";
import { WebSearchTool } from "../tools/web_search_tool.js";
import { FormatResultTool } from "../tools/format_result_tool.js";
import { EmptyResultDiagnoser } from "../tools/empty_result_diagnosis.js";
import { jsonReplacer } from "../utils/serialization.js";
import { createAgentToolFromBaseTool } from "../core/agent_tool_adapter.js";
import { DirectSqlTool } from "./query_workspace_tools.js";

const VALUE_PREVIEW_MAX_ROWS = 30; // ≤ 此行数视为"值依赖",回灌全量供内联;超过视为"表依赖",只回摘要
const MAX_DISPLAY_ROWS = 500; // 前端预览行数上限
const IGNORED_NUMERIC_SAMPLE_KEYS = new Set(["content_index", "chunk_index", "row_index", "_index", "__index", "index", "idx"]);
const rName = () => "r_" + randomBytes(8).toString("hex");
const txt = (s) => ({ content: [{ type: "text", text: String(s ?? "") }] });

export function recordQueryToolHistory(agentContext, entry = {}) {
  if (!agentContext) return null;
  agentContext.data = agentContext.data || {};
  const history = Array.isArray(agentContext.data.tool_history) ? agentContext.data.tool_history : [];
  agentContext.data.tool_history = history;
  const row = {
    tool: entry.tool || entry.name || "",
    success: entry.success !== false,
    params: entry.params || {},
    thought: entry.thought || "",
    result: entry.result || {},
    timestamp: new Date().toISOString(),
  };
  history.push(row);
  return row;
}

function codingToolResultText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts
    .map((part) => part?.type === "text" ? part.text || "" : "")
    .filter(Boolean)
    .join("\n");
  return text.slice(0, 4000);
}

function instrumentCodingTool(tool, agentContext) {
  return {
    ...tool,
    async execute(toolCallId, params = {}, signal, onUpdate) {
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        const success = result?.isError !== true;
        recordQueryToolHistory(agentContext, {
          tool: tool.name,
          success,
          params,
          result: success
            ? { output: codingToolResultText(result) }
            : { error: codingToolResultText(result) || "工具执行失败" },
        });
        return result;
      } catch (error) {
        recordQueryToolHistory(agentContext, {
          tool: tool.name,
          success: false,
          params,
          result: { error: error?.message || String(error) },
        });
        throw error;
      }
    },
  };
}

export function createQueryCodingTools({ workspaceRoot, agentContext } = {}) {
  if (!workspaceRoot) return [];
  return [
    createReadTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createLsTool(workspaceRoot),
    createFindTool(workspaceRoot),
    createWriteTool(workspaceRoot),
    createEditTool(workspaceRoot),
    createBashTool(workspaceRoot),
  ].map((tool) => instrumentCodingTool(tool, agentContext));
}

export function buildAskUserPayload({ request_id, prompt = "", options = [], allow_multiple = false, agentContext = null } = {}) {
  const payload = {
    request_id,
    prompt,
    options,
    allow_multiple: Boolean(allow_multiple),
  };
  return payload;
}

/**
 * 把算子返回的 result 适配成 df-like(empty/columns/length/head/toRecords),对齐 superagent.js _resultToDf。
 */
function resultToDf(resultObj) {
  if (resultObj == null) return null;
  let rows;
  let columns;
  if (typeof resultObj.to_df === "function") {
    const df = resultObj.to_df();
    rows = typeof df?.to_dict === "function" ? df.to_dict() : df?._data ?? df;
    columns = df?.columns;
  } else if (typeof resultObj.to_dict === "function") {
    rows = resultObj.to_dict();
    columns = resultObj.columns;
  } else if (Array.isArray(resultObj.rows)) {
    rows = resultObj.rows;
    columns = resultObj.columns;
  } else {
    return null;
  }
  const records = Array.isArray(rows) ? rows : [...(rows ?? [])];
  let cols;
  if (columns instanceof Set) cols = [...columns];
  else if (Array.isArray(columns)) cols = [...columns];
  else if (records.length > 0) cols = Object.keys(records[0]);
  else cols = [];
  return {
    empty: records.length === 0,
    columns: cols,
    length: records.length,
    head(n) {
      const sliced = records.slice(0, n);
      return { records: () => sliced };
    },
    toRecords() {
      return records;
    },
  };
}

function stringifyRows(rows) {
  try {
    return JSON.stringify(rows || [], jsonReplacer);
  } catch {
    return "[]";
  }
}

function hasNonZeroNumericValue(row) {
  if (!row || typeof row !== "object") return false;
  return Object.entries(row).some(([key, value]) => {
    const normalizedKey = String(key || "").toLowerCase();
    if (IGNORED_NUMERIC_SAMPLE_KEYS.has(normalizedKey) || normalizedKey.endsWith("_index")) return false;
    return typeof value === "number" && Number.isFinite(value) && value !== 0;
  });
}

function buildLargeResultSummary(records, headCount = 3, tailCount = 3, nonZeroCount = 5) {
  const allRows = Array.isArray(records) ? records : [];
  const head = allRows.slice(0, headCount);
  const tail = allRows.length > headCount ? allRows.slice(Math.max(headCount, allRows.length - tailCount)) : [];
  const seen = new Set([...head, ...tail].map((row) => stringifyRows([row])));
  const nonZero = [];
  for (const row of allRows) {
    if (!hasNonZeroNumericValue(row)) continue;
    const key = stringifyRows([row]);
    if (seen.has(key)) continue;
    seen.add(key);
    nonZero.push(row);
    if (nonZero.length >= nonZeroCount) break;
  }
  return { head, tail, nonZero };
}

/**
 * 构建问数工具集(按业务能力门控,与 SuperAgent._register_tools 一致)。
 * @param {object} deps
 * @param {object} deps.agentContext        共享 AgentContext(算子读 data_sources_info / 写 format_context)
 * @param {import('../core/analysis_session.js').AnalysisSession} deps.session
 * @param {object} deps.bds                  BusinessDataSources
 * @param {{root:string}} deps.workspace     当前项目代码工作区
 * @param {object} deps.capabilities         BusinessCapabilities(has_structured/...)
 * @param {Function} deps.streamCallback     (content, opts) => Promise,推前端 SSE
 * @returns {Array<object>} AgentTool[]
 */
export function buildQueryTools({ agentContext, session, bds, workspace, capabilities, streamCallback }) {
  const caps = capabilities || {};

  // 确保算子能从 context 拿到数据源 + 中间源(幂等)
  function ensureDataSources() {
    agentContext.input_data = agentContext.input_data || {};
    const dsi = (agentContext.input_data.data_sources_info = agentContext.input_data.data_sources_info || {});
    if (bds && !dsi.business_data_sources) dsi.business_data_sources = bds;
    if (session.intermediate_ds && !dsi.intermediate_ds) dsi.intermediate_ds = session.intermediate_ds;
  }

  // 落表 + 裁剪:把算子结果落中间表,推前端预览,回灌给 LLM 的精简/全量内容
  async function landAndSlim(toolName, data, params) {
    const sub_query = data["sub-query"] || params.question || params.query || "";
    const df = resultToDf(data.result);

    // 非结构化/无 df 结果:推文档块 + 回文本
    if (!df) {
      if (data.content) {
        await streamCallback(data.content, {
          content_type: data.content_type || "markdown",
          title: data.content_title || "检索结果",
          display: true,
          msg_category: "intermediate_result",
        });
        return txt(String(data.content).slice(0, 4000));
      }
      // grep/align/metric 命中失败等信息类结果:原样回(截断)
      let s;
      try {
        s = JSON.stringify(data, jsonReplacer);
      } catch {
        s = String(data);
      }
      return txt((s || "").slice(0, 4000));
    }

    // 空结果:诊断驱动 + 同查询 loop 护栏。空≠失败——真实空(no_data)一次就报、零重试;假性空带方向调整。
    if (df.empty) {
      let diag = null;
      try {
        diag = await new EmptyResultDiagnoser().diagnose(
          toolName,
          data.operator,
          bds,
          agentContext.project_id,
          agentContext.session_id,
        );
        if (diag?.message) {
          await streamCallback(`[诊断] ${diag.message}`, {
            content_type: "text",
            title: "空结果诊断",
            display: true,
            msg_category: "tool_detail",
          });
        }
      } catch {
        /* 诊断失败不阻断 */
      }
      const dmsg = diag?.message || data.error || "查询未返回任何数据";
      const { repeated } = session.noteEmptyResult(sub_query);
      if (repeated) {
        // 同一 sub_query 反复空:防原地打转
        return txt(
          `[空结果·重复] 子问题「${sub_query}」再次为空。${dmsg}\n` +
            `停止重试同一查询:要么换完全不同的思路/数据源,要么这就是真实的空——直接告诉用户"无符合条件的数据 / 为 0"。`,
        );
      }
      if (diag?.diagnosis_type === "no_data") {
        // 真实空:查询正确但无匹配,一次就报、零重试
        return txt(
          `[空结果·真实] 子问题「${sub_query}」查询正确但无匹配数据。${dmsg}\n` +
            `若这就是答案,直接告诉用户"没有符合条件的数据 / 为 0",不要重试。`,
        );
      }
      // 假性空(条件过严 / 实体没对齐 / 未匹配):带方向调整,最多一两次
      return txt(
        `[空结果·可调整] 子问题「${sub_query}」为空。诊断:${dmsg}\n` +
          `考虑:① 放宽过滤条件;② 检查筛选字段和值是否与 Schema 一致;③ 仍空则按真实空处理并告知"无数据"。最多调整一两次,不要反复重试同一查询。`,
      );
    }

    // 有数据:落中间表
    const result_name = rName();
    const operator = data.operator;
    const executed_sql = operator?.sql || "";
    const sqlText = executed_sql ? `\nSQL:\n${executed_sql}` : "";
    const intermediate_table = `${session.intermediateName}.${result_name}`;
    try {
      await session.intermediate_ds.add(df, result_name, `子问题「${sub_query}」的查询结果`, sub_query, executed_sql);
    } catch (e) {
      return txt(`[失败] 查询成功但结果落地失败: ${e?.message || e}。请重试或换一种查法。`);
    }

    const total_rows = df.length;
    const truncated = total_rows > MAX_DISPLAY_ROWS;
    const display_records = truncated ? df.head(MAX_DISPLAY_ROWS).records() : df.toRecords();
    const cols = [...df.columns];

    // 真进展:清 fail-fast / 空护栏(对齐 SuperAgent._advance_task 清 churn);记步骤产出 + E3 会话级中间表薄索引
    session.resetChurn();
    const value_preview = total_rows <= VALUE_PREVIEW_MAX_ROWS ? df.toRecords() : null;
    session.recordStepOutput(sub_query, {
      sub_query,
      intermediate_table,
      row_count: total_rows,
      columns: cols,
      value_preview,
      source_name: operator?.source_name || "",
    });
    await session.recordIntermediateTable({
      tableName: result_name,
      duckdbPath: session.intermediate_ds?.duckdb_path ?? null,
      description: `子问题「${sub_query}」的查询结果`,
      rowCount: total_rows,
      columnCount: cols.length,
      columns: cols,
      schemaPreview: df.head(3).records(),
      subQuery: sub_query,
      sqlQuery: executed_sql,
    });

    // 维护 format_context(供 format_result 出图);替换同 sub_query 的旧记录
    const fc = (agentContext.data.format_context = agentContext.data.format_context || {
      original_question: agentContext.input_data?.enhanced_user_query || "",
      sub_tasks: [],
    });
    fc.sub_tasks = (fc.sub_tasks || []).filter((it) => it.sub_question !== sub_query);
    fc.sub_tasks.push({
      task_id: "",
      sub_question: sub_query,
      columns: cols,
      row_count: total_rows,
      truncated,
      sample: display_records.slice(0, 10),
      data: display_records,
      source_type: toolName === "web_search_operator"
          ? "web_search"
          : "database_connection",
      datasource_name: operator?.source_name || "",
      intermediate_table,
      output_alias: "",
    });

    // 推前端中间结果预览(table,支持分页)
    await streamCallback(
      { data: display_records },
      {
        content_type: "table",
        title: `中间结果：${sub_query}（共 ${total_rows} 行）`,
        display: true,
        msg_category: "intermediate_result",
        intermediate_table,
      },
    );

    // 回灌给 LLM:值依赖 vs 表依赖
    if (total_rows <= VALUE_PREVIEW_MAX_ROWS) {
      const rowsStr = stringifyRows(df.toRecords());
      return txt(
        `已查询并存入中间表 ${intermediate_table}（${total_rows} 行）。\n列: ${cols.join(", ")}\n` +
          `数据(可直接把其中字面值内联进下游 question):\n${rowsStr}${sqlText}`,
      );
    }
    const summary = buildLargeResultSummary(df.toRecords());
    const sampleStr = stringifyRows(summary.head);
    const tailText = summary.tail.length ? `\n样例(末尾${summary.tail.length}行): ${stringifyRows(summary.tail)}` : "";
    const nonZeroText = summary.nonZero.length ? `\n样例(非零数值行): ${stringifyRows(summary.nonZero)}` : "";
    return txt(
      `已查询并存入中间表 ${intermediate_table}（${total_rows} 行,大结果未内联）。\n列: ${cols.join(", ")}\n` +
        `样例(前3行): ${sampleStr}${tailText}${nonZeroText}\n` +
        `下游 JOIN/聚合请调 execute_sql，source_id="session_intermediate"，并在 SQL 中引用表 ${result_name}。${sqlText}`,
    );
  }

  // 数据类算子统一执行:注入运行上下文 → BaseTool adapter → landAndSlim
  function buildDataOperatorKwargs(toolName, params, signal) {
    ensureDataSources();
    const safeParams = { ...(params || {}) };
    delete safeParams.stream_callback;
    delete safeParams.signal;
    const kwargs = { ...safeParams, stream_callback: streamCallback };
    if (signal) kwargs.signal = signal;
    return kwargs;
  }

  async function mapDataOperatorResult(toolName, result, params) {
    if (!result || result.success === false) {
      const reason = result?.error || result?.message || "执行失败";
      recordQueryToolHistory(agentContext, {
        tool: toolName,
        success: false,
        params,
        result: { error: reason },
      });
      const { failFast, totalReplans } = session.bumpFailFast(`${toolName}:${reason}`);
      if (failFast) {
        return txt(
          `[失败·已多次] ${toolName}: ${reason}\n同类错误反复出现(累计 ${totalReplans} 次)。停止死磕:换完全不同的工具/数据源/思路,或用已有信息直接回答。`,
        );
      }
      return txt(`[失败] ${toolName}: ${reason}\n请换一种查法(检查数据源名/字段/条件),不要原样重试。`);
    }
    recordQueryToolHistory(agentContext, {
      tool: toolName,
      success: true,
      params,
      result: {
        params,
        message: result.message || "",
        "sub-query": result.data?.["sub-query"] || params.question || params.query || "",
      },
    });
    return await landAndSlim(toolName, result.data || {}, params);
  }

  function mapDataOperatorError(toolName, error, params) {
    recordQueryToolHistory(agentContext, {
      tool: toolName,
      success: false,
      params,
      result: { error: error?.message || String(error) },
    });
    const reason = `${toolName} 执行异常: ${error?.message || error}`;
    const { failFast } = session.bumpFailFast(reason);
    return txt(
      failFast
        ? `[错误·已多次] ${reason}\n反复异常,停止重试该工具,换思路或用已有信息直接回答。`
        : `[错误] ${reason}`,
    );
  }

  const wrapData = (name, instance, parameters) => createAgentToolFromBaseTool({
    name,
    tool: instance,
    parameters,
    agentContext,
    buildKwargs: ({ params, signal }) => buildDataOperatorKwargs(name, params || {}, signal),
    mapResult: ({ result, params }) => mapDataOperatorResult(name, result, params || {}),
    mapError: ({ error, params }) => mapDataOperatorError(name, error, params || {}),
  });
  // ── 参数 schema(由各算子 execute 读取的 kwargs 反推;描述引导模型) ──
  const databaseSourceIds = (workspace?.sources || [])
    .filter((source) => source.type === "database")
    .map((source) => source.source_id)
    .join(", ");
  const ExecuteSqlParams = Type.Object({
    source_id: Type.Optional(Type.String({ description: `本轮数据源清单中的数据库 source_id；多个数据库时必填。当前可用：${databaseSourceIds || "没有可用数据库"}` })),
    sql: Type.String({ description: "一条只读 SELECT 或 WITH SQL" }),
    question: Type.String({ description: "这条 SQL 要回答的子问题，用于标记中间结果" }),
  });
  const WebSearchParams = Type.Object({
    query: Type.String({ description: "网络搜索关键词" }),
    max_results: Type.Optional(Type.Number()),
  });
  const FormatResultParams = Type.Object({
    question: Type.String({ description: "用户原始问题" }),
    intermediate_tables: Type.Optional(
      Type.Array(Type.String(), { description: '要展示的中间表名列表(如 ["r_628f"]);追问纯展示已有结果时必须传。' }),
    ),
  });
  const AskUserParams = Type.Object({
    prompt: Type.String({ description: "向用户澄清的问题" }),
    options: Type.Optional(Type.Array(Type.String(), { description: "chip 选项" })),
    allow_multiple: Type.Optional(Type.Boolean()),
  });

  // ── format_result(非终结:出图后继续 reasoning,之后直接输出文字结论) ──
  const formatResultTool = new FormatResultTool();
  const formatTool = createAgentToolFromBaseTool({
    name: "format_result",
    tool: formatResultTool,
    parameters: FormatResultParams,
    agentContext,
    buildKwargs: ({ params, signal }) => {
      ensureDataSources();
      const kwargs = { stream_callback: streamCallback, ...(params || {}) };
      if (signal) kwargs.signal = signal;
      return kwargs;
    },
    mapError: ({ error }) => txt(`[错误] format_result 执行异常: ${error?.message || error}`),
    mapResult: ({ result }) => {
      if (!result || result.success === false) {
        return txt(`[失败] format_result: ${result?.error || result?.message || "出图失败"}`);
      }
      // 追问场景按需重建的 format_context 回写父 context
      if (result.data?.rebuilt_format_context) {
        agentContext.data.format_context = result.data.rebuilt_format_context;
      }
      return txt("已生成可视化展示块(图表/大表)。请继续:若已可回答,直接输出文字结论。");
    },
  });

  // ── ask_user(消歧/确认:推控制面 action + suspend run;用户选择通过 resume handle 回来) ──
  const askUserTool = {
    name: "ask_user",
    description:
      "出现歧义(实体/口径/维度多义)且无法自行判定时调用:给出 prompt + options(chip 选项)。" +
      "调用后本轮结束等待用户选择;能从上下文确定时不要滥用。",
    parameters: AskUserParams,
    execute: async (_id, params) => {
      const request_id = `q_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const options = (params?.options || [])
        .map((o) => (o && typeof o === "object" ? { label: o.label || o.value || "" } : { label: String(o) }))
        .filter((o) => o.label);
      const basePayload = buildAskUserPayload({
        request_id,
        prompt: params?.prompt || "",
        options,
        allow_multiple: Boolean(params?.allow_multiple),
        agentContext,
      });
      const payload = agentContext?.runtime?.requestUserInput
        ? await agentContext.runtime.requestUserInput(basePayload, {
          requestId: request_id,
          checkpoint: {
            tool: "ask_user",
            tool_call_id: _id,
            params,
            task_id: agentContext?.task_id || null,
            skill: agentContext?.skillDecision?.skill_name || null,
            runtime: agentContext?.skillDecision?.runtime || null,
            project_id: agentContext?.project_id || agentContext?.input_data?.project_id || null,
            session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
            original_user_message: agentContext?.input_data?.user_message || "",
            enhanced_user_query: agentContext?.input_data?.enhanced_user_query || "",
          },
        })
        : basePayload;
      recordQueryToolHistory(agentContext, {
        tool: "ask_user",
        success: true,
        params,
        result: payload,
      });
      if (agentContext?.data) {
        agentContext.data._suspended_by_ask_user = true;
        agentContext.data._pending_user_input_request_id = request_id;
      }
      await streamCallback(
        JSON.stringify(payload),
        {
          content_type: "user_input",
          title: "需要您确认",
          recall: true,
          display: true,
          msg_category: "question",
          request_id,
        },
      );
      return { content: [{ type: "text", text: "已向用户提问,等待选择。" }], terminate: true };
    },
  };

  // ── 按能力门控装配：代码工作区、SQL、Web、通用工具 ──
  const tools = [];
  if ((caps.has_structured || caps.has_unstructured) && workspace?.root) {
    tools.push(...createQueryCodingTools({ workspaceRoot: workspace.root, agentContext }));
  }
  if (caps.has_structured) {
    tools.push(wrapData("execute_sql", new DirectSqlTool({ bds, session }), ExecuteSqlParams));
  }
  if (caps.has_web_search) tools.push(wrapData("web_search_operator", new WebSearchTool(), WebSearchParams));
  tools.push(formatTool, askUserTool);
  // QueryAgent 在装配完整工具集后统一添加 trace 生命周期；这里不重复包装，避免同一工具生成两条 span。
  return tools;
}

export default buildQueryTools;
