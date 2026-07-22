/**
 * QueryAgent —— 问数引擎,运行在统一函数调用运行时上。
 *
 * 契约与旧 SuperAgent.execute 完全一致:execute(agentContext, stream_callback) → { success }。
 * chat.js 按 engine flag 在二者间二选一,其余(业务解析/数据源/agentContext/持久化)零改。
 *
 * 文件读写、代码执行、SQL 执行、中间表和出图都以工具形式收编进来(见 query_tool_adapter.js)。
 * 编排靠 LLM 自主 function-calling + system prompt 策略,
 * 多跳通过工具结果回灌的中间表名驱动,不再用 SuperAgent 的 orchestration 状态机。
 */
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ModelConfigResolver } from "../core/llm.js";
import { BaseAgent } from "../core/base_agent.js";
import { AnalysisSession } from "../core/analysis_session.js";
import { AgentSettings } from "../tools/agent_settings.js";
import { createPromptSkillHookRegistry } from "../skills/hooks/prompt_skill_hooks.js";
import { buildQueryTools } from "./query_tool_adapter.js";
import { inspectQueryWorkspace } from "./query_workspace_tools.js";
import { probeCapabilities } from "./capabilities.js";
import { withAgentToolLifecycles } from "../trace/trace_context.js";
import { appendMessages, loadTranscript, trimToBudget } from "./sessionStore.js";
import {
  assistantMessageTraceText,
  buildPiModel,
  createPiStreamFn,
  DEFAULT_QUERY_MAX_MODEL_TURNS,
  DEFAULT_QUERY_MODEL_TIMEOUT_MS,
  ensurePiProviders,
  normalizePiUsageForTrace,
  positiveInt,
} from "./pi_runtime.js";

function extractParts(content) {
  let text = "";
  let thinking = "";
  for (const part of content || []) {
    if (!part) continue;
    if (part.type === "text") text += part.text || "";
    else if (part.type === "thinking") thinking += part.thinking || part.text || "";
  }
  return { text, thinking };
}

const shortArgs = (args) => {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return "";
  }
};

const TRACE_TEXT_MAX = Math.max(0, Number(process.env.YIW_TRACE_TEXT_MAX || 0));
const QUERY_AGENT_TYPE = "query_agent";
const QUERY_WRITE_TOOLS = new Set(["write", "edit", "bash"]);

const traceJson = (value, max = TRACE_TEXT_MAX) => {
  if (value == null || value === "") return "";
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    const limit = Math.max(0, Number(max || 0));
    return limit > 0 && s.length > limit ? `${s.slice(0, limit).trimEnd()}...` : s;
  } catch {
    const s = String(value);
    const limit = Math.max(0, Number(max || 0));
    return limit > 0 && s.length > limit ? `${s.slice(0, limit).trimEnd()}...` : s;
  }
};

function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const c = result.content;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (!p) return "";
        if (p.type === "text") return p.text || "";
        if (p.text) return p.text;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// 不在对话流里显示 running/done 进度块的工具(它们各自推自己的块:计划/提问)
const SILENT_TOOLS = new Set(["update_plan", "ask_user"]);

// 兜底 prompt:正常走 agent_configs.zh.json 的 query_agent.system_prompt(见 execute);仅配置加载失败时用此。
const FALLBACK_PROMPT =
  "你是数据分析师和代码执行 Agent,帮助用户读取项目文件、编写代码、处理数据并查询数据库。" +
  "多步任务先用 update_plan。先核对本轮数据源清单，使用 read/grep/ls/find 查找 Schema 或 Markdown；需要处理数据时可用 write/edit/bash 编写并运行代码；数据库查询使用 execute_sql。需要图表时调 format_result，最终直接输出答案。";

const MODEL_TIMEOUT_RE = /\btimeout\b|timed out|time out|请求超时|模型超时|超时\s*\(?\s*\d*\s*ms|aborted due to timeout/i;
const MODEL_TURN_LIMIT_RE = /模型轮数超过上限|max(?:imum)? model turns?|turn limit/i;

function lastAssistantMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

export function terminalNaturalAnswer(messages = []) {
  const message = lastAssistantMessage(messages);
  if (!message || String(message.stopReason || '') !== 'stop') return '';
  return extractParts(message.content).text.trim();
}

export function buildQueryFailureDetails({
  stopReason = "",
  errorMessage = "",
  modelTurns = 0,
  timeoutMs = 0,
  aborted = false,
} = {}) {
  const reason = String(stopReason || (aborted ? "aborted" : "unknown"));
  const rawError = String(errorMessage || "").trim();
  let errorCode = "query_no_final_answer";
  let message = "QueryAgent 未生成最终答案。";

  if (aborted || reason === "aborted") {
    errorCode = "query_cancelled";
    message = "QueryAgent 查询已取消。";
  } else if (MODEL_TIMEOUT_RE.test(rawError)) {
    errorCode = "model_timeout";
    message = `QueryAgent 模型请求超时${Number(timeoutMs) > 0 ? `(${Number(timeoutMs)}ms)` : ""}。`;
  } else if (MODEL_TURN_LIMIT_RE.test(rawError)) {
    errorCode = "model_turn_limit";
    message = "QueryAgent 模型轮数达到上限。";
  } else if (reason === "error" || rawError) {
    errorCode = "model_error";
    message = rawError ? `QueryAgent 模型调用失败:${rawError}` : "QueryAgent 模型调用失败。";
  }

  return {
    error_code: errorCode,
    stop_reason: reason,
    model_turns: Math.max(0, Number(modelTurns) || 0),
    ...(Number(timeoutMs) > 0 ? { model_timeout_ms: Number(timeoutMs) } : {}),
    ...(rawError ? { model_error: rawError } : {}),
    message,
  };
}

export const QUERY_PLANNING_GUARDRAILS = `
### 在线问答规则

- 离线准备与在线问答分开：Schema、Markdown 和数据源清单是离线准备的事实产物，在线问答不自动重建或刷新它们。处理问题所需的代码、脚本和输出文件可以写入项目工作区。
- 先核对本轮数据源与文档清单。内容仍在准备、已经失败或文件缺失时，依据清单说明真实状态，不要假装内容完整。
- 不凭记忆猜表、字段、关系或文档内容。优先使用 read/grep/ls/find 搜索并读取真实文件；复杂处理可以用 write/edit 编写代码并用 bash 执行；数据库问题必须通过 execute_sql 真实执行。
- write、edit 和 bash 沿用工作区的审批设置。收到拒绝后停止该操作并换用已有证据或向用户说明，不要绕过审批。
- SQL 失败时根据真实错误继续查 Schema 并修改，不能原样重试。空结果在核对条件后可以作为真实答案。
- 多数据源任务先分别查询各来源，再使用 session_intermediate 关联。前序结果要保留后续关联需要的稳定键和用户最终需要的字段。
- 文档回答保留文件路径和行号；混合问题同时保留文档证据和 SQL 结果。
- 工具只负责产生证据，不负责结束任务。确认现有证据已经回答问题后，停止调用工具并直接输出最终答案；pi-agent 会按原生 stop 语义结束。
- 不使用题型关键词或固定案例代替语义判断。口径确实无法从问题、项目规则和数据中确定时再调用 ask_user。
`.trim();

export function summarizeQueryEvidence(toolHistory = []) {
  const rows = Array.isArray(toolHistory) ? toolHistory : [];
  const successful = rows.filter((item) => item?.success !== false);
  const failed = rows.filter((item) => item?.success === false);
  return {
    successful_tools: [...new Set(successful.map((item) => String(item?.tool || '')).filter(Boolean))],
    failed_tools: [...new Set(failed.map((item) => String(item?.tool || '')).filter(Boolean))],
    sql_queries: successful.filter((item) => item?.tool === 'execute_sql').length,
    file_reads: successful.filter((item) => ['read', 'grep', 'ls', 'find'].includes(item?.tool)).length,
    file_writes: successful.filter((item) => ['write', 'edit'].includes(item?.tool)).length,
    shell_commands: successful.filter((item) => item?.tool === 'bash').length,
    total_tool_calls: rows.length,
  };
}

export function createQueryToolHookRegistry({ agentContext, workspaceRoot, streamCallback } = {}) {
  const approval = ["ask", "auto", "full"].includes(agentContext?.approval)
    ? agentContext.approval
    : "ask";
  return createPromptSkillHookRegistry({
    cwd: workspaceRoot,
    getActiveSkill: () => null,
    metaTools: new Set(),
    approval,
    writeTools: QUERY_WRITE_TOOLS,
    confirmToolNames: new Set(),
    isExternalTool: () => false,
    streamCallback,
    awaitDecision: agentContext?.awaitDecision,
    shortArgs,
  });
}

function buildRuntimeUserMessage(userMessage, { taskPlanSection = "", intermediateSection = "" } = {}) {
  const blocks = [
    userMessage,
    taskPlanSection,
    intermediateSection,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return blocks.join("\n\n");
}

function stripRuntimeSectionsForTranscript(message) {
  if (message?.role !== "user" || typeof message.content !== "string") return message;
  const markers = ["\n\n## 任务计划", "\n\n## 中间结果", "\n\n## 项目文件工作区"];
  const cuts = markers.map((marker) => message.content.indexOf(marker)).filter((idx) => idx >= 0);
  if (!cuts.length) return message;
  return { ...message, content: message.content.slice(0, Math.min(...cuts)).trimEnd() };
}

function stripRuntimeSectionMessages(messages) {
  return Array.isArray(messages) ? messages.map(stripRuntimeSectionsForTranscript) : [];
}

export class QueryAgent extends BaseAgent {
  constructor(opts = {}) {
    super({ name: "QueryAgent", description: "问数编排 Agent" });
    this.opts = opts; // { dbctx, bds, businessId, capabilities }
  }

  // 按 project 能力门控注册问数工具(去 BaseAgent:用 probeCapabilities 替代 SuperAgent.probe_capabilities)
  static async from_business_context(
    dbctx,
    bds = null,
    businessId = null,
    maxIterations = 50,
    maxEmpty = 3,
    executionOptions = {},
  ) {
    const capabilities = await probeCapabilities(bds, businessId, dbctx);
    return new QueryAgent({
      dbctx,
      bds,
      businessId,
      capabilities,
      maxIterations,
      maxEmpty,
      ...(executionOptions && typeof executionOptions === "object" ? executionOptions : {}),
    });
  }

  async execute(agentContext, stream_callback) {
    ensurePiProviders();
    const q = agentContext?.input_data?.user_message || "";
    const projectId = agentContext?.project_id || null;
    const bds = this.opts?.bds || agentContext?.input_data?.data_sources_info?.business_data_sources || null;
    const businessId = this.opts?.businessId || agentContext?.input_data?.business_id || null;
    const capabilities = this.opts?.capabilities || null;
    const transcriptMode = this.opts?.transcriptMode === "embedded" ? "embedded" : "root";
    const outputMode = this.opts?.outputMode === "tool_result" ? "tool_result" : "direct";
    const embedded = transcriptMode === "embedded";
    const emitAssistantText = outputMode !== "tool_result";
    const externalSignal = this.opts?.signal || agentContext?.signal || null;
    const runtimeSettings = agentContext?.settings || agentContext?.input_data?.settings || {};
    const timeoutMs = positiveInt(
      runtimeSettings.timeoutMs ?? runtimeSettings.queryTimeoutMs ?? process.env.YIW_QUERY_MODEL_TIMEOUT_MS,
      DEFAULT_QUERY_MODEL_TIMEOUT_MS,
    );
    const maxModelTurns = positiveInt(
      runtimeSettings.maxQueryTurns ?? runtimeSettings.maxModelTurns ?? process.env.YIW_QUERY_MAX_MODEL_TURNS,
      DEFAULT_QUERY_MAX_MODEL_TURNS,
    );

    let cfg;
    try {
      cfg = await ModelConfigResolver.resolve({ project_id: projectId, category: "PRIMARY" });
    } catch (e) {
      if (emitAssistantText) {
        await stream_callback(`⚠️ 未配置可用大模型:${e?.message || e}\n请在「项目设置 → 模型配置」配置后再试。`, {
          content_id: randomUUID(),
          content_type: "markdown",
          title: "提示",
        });
      }
      return { success: false, error: "no model configured" };
    }

    const model = buildPiModel(cfg);
    const apiKey = cfg.api_key;
    const sessionId = agentContext?.session_id || agentContext?.input_data?.session_id || null;

    // 会话级状态 + 注册中间数据源(每会话一个 DuckDB 中间库,注入 agentContext 供算子读取)
    const session = new AnalysisSession({ sessionId, agentContext });
    session.registerIntermediate(bds);
    let workspace = null;
    try {
      workspace = await inspectQueryWorkspace({ projectId, bds, session });
    } catch (e) {
      console.error("[query_agent prepareWorkspace]", e?.message || e);
    }
    if (agentContext) {
      agentContext.data = agentContext.data || {};
      agentContext.data._finalize_plan = () => session.completeOpenTasks();
    }

    // 加载问数 system prompt(agent_configs.zh.json 的 query_agent;走 AgentSettings 与 SuperAgent 同源,
    // 业务自定义 rules 可经此覆盖)。动态中间结果/任务计划放入本轮 user runtime context,不污染 system prefix。
    const profiles = agentContext?.input_data?.selected_data_profiles || "";
    const queryForPrompt = agentContext?.input_data?.enhanced_user_query || q;
    let systemPrompt = FALLBACK_PROMPT;
    let userMessage = q;
    try {
      const pcfg = await AgentSettings.getAgentConfig(projectId, QUERY_AGENT_TYPE, {
        businessId,
        systemVars: {},
        userVars: {
          question: queryForPrompt,
          data_profiles: profiles ? `## 可用数据\n${profiles}` : "",
          current_date: AgentSettings.getDateContext(),
          intermediate_name: session.intermediateName || `intermediate_${sessionId || "session"}`,
        },
      });
      if (pcfg?.system_prompt) systemPrompt = pcfg.system_prompt;
      if (pcfg?.user_prompt) userMessage = pcfg.user_prompt;
    } catch (e) {
      console.error("[query_agent loadConfig]", e?.message || e);
    }

    // 把「中间结果 / 任务计划」放进本轮 user runtime context,保持 system prompt 稳定以利于 prefix cache。
    let intermediateSection = "";
    try {
      intermediateSection = await session.renderIntermediateSection();
    } catch (e) {
      console.error("[query_agent renderIntermediate]", e?.message || e);
    }
    systemPrompt = systemPrompt
      .split("{intermediate_section}").join("")
      .split("{task_plan_section}").join("");
    systemPrompt = `${systemPrompt}\n\n${QUERY_PLANNING_GUARDRAILS}`;
    userMessage = buildRuntimeUserMessage(userMessage, {
      taskPlanSection: session.renderTaskPlan(),
      intermediateSection,
    });
    if (workspace?.root) {
      const workspaceSection = [
        '## 项目文件工作区',
        `工作目录：${workspace.root}`,
        '以下清单由系统只读检查得到，不是用户问题，也不需要写回文件。',
        workspace.sourceCatalog || '',
        workspace.documentCatalog || '',
      ].filter(Boolean).join('\n\n');
      userMessage += `\n\n${workspaceSection}`;
    }

    // update_plan:LLM 公布/更新计划 → 落 session(权威进度)+ 推前端右栏
    const planTool = {
      name: "update_plan",
      description:
        "公布或更新多步问数计划。每步含 title、source_kind(raw|intermediate|web_search|空)、source_name、status(todo|doing|done)。规划与推进时调用,已完成步骤保持 done;成功完成后框架会兜底关闭未完成步骤。",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            title: Type.String({ description: "子问题标题(业务语言)" }),
            source_kind: Type.Optional(Type.String({ description: "raw | intermediate | web_search | 空" })),
            source_name: Type.Optional(Type.String({ description: "raw 时逐字复制可用数据源名" })),
            status: Type.String({ description: "todo | doing | done" }),
          }),
        ),
      }),
      execute: async (_id, params) => {
        const steps = Array.isArray(params?.steps) ? params.steps : [];
        await session.setTaskPlan(steps); // 内存 + 持久化 analysis_plan_steps(E4)
        await stream_callback(JSON.stringify(steps), { content_id: "plan", content_type: "plan" });
        return { content: [{ type: "text", text: "计划已更新" }] };
      },
    };

    const queryTools = buildQueryTools({
      agentContext,
      session,
      bds,
      workspace,
      capabilities,
      streamCallback: stream_callback,
    });
    const tools = withAgentToolLifecycles([planTool, ...queryTools], { trace_agent: QUERY_AGENT_TYPE });
    const toolHooks = createQueryToolHookRegistry({
      agentContext,
      workspaceRoot: workspace?.root,
      streamCallback: stream_callback,
    });
    // 嵌入模式属于父 Agent 的一次工具调用,不能单独读写父会话转写。
    const resumeRequested = !embedded && Boolean(agentContext?.resume?.continueFromTranscript);
    let historyMessages = [];
    if (resumeRequested) {
      const transcript = loadTranscript(sessionId);
      historyMessages = Array.isArray(transcript) ? trimToBudget(transcript) : [];
    }
    const continueFromTranscript = resumeRequested && historyMessages.length > 0;
    let persistedCount = continueFromTranscript ? historyMessages.length : 0;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        messages: continueFromTranscript ? historyMessages : [],
      },
      toolExecution: "sequential", // 落表确定性必须串行
      streamFn: createPiStreamFn({
        apiKey,
        extraConfig: cfg.extra_config,
        timeoutMs,
        maxModelTurns,
        turnLimitMessage: (limit) => `问数模型轮数超过上限(${limit}),已停止以避免无限工具循环。`,
      }),
      beforeToolCall: async (context, signal) => toolHooks.beforeToolCall(context, signal),
      afterToolCall: async (context, signal) => toolHooks.afterToolCall(context, signal),
    });

    // 根 Agent 与嵌入子 Agent 分开登记,停止父任务时两者都会被 abort。
    const registerAgent = embedded ? agentContext?.onChildAgent : agentContext?.onAgent;
    const unregisterAgent = embedded ? agentContext?.offChildAgent : agentContext?.offAgent;
    if (typeof registerAgent === "function") registerAgent(agent);
    const onExternalAbort = () => agent.abort();
    if (externalSignal?.aborted) {
      if (typeof unregisterAgent === "function") unregisterAgent(agent);
      return { success: false, aborted: true, error: "aborted" };
    }
    externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });

    const flush = () => {
      if (embedded || !sessionId) return;
      try {
        const all = agent.state?.messages || [];
        if (all.length > persistedCount) {
          appendMessages(sessionId, stripRuntimeSectionMessages(all.slice(persistedCount)));
          persistedCount = all.length;
        }
      } catch (e) {
        console.error("[query_agent flush]", e?.message || e);
      }
    };

    // 事件 → stream_callback。文本/思考流式;工具调用推 running/done 进度块(算子各自推表格/图表块)。
    let curTextId = randomUUID();
    let curThinkId = randomUUID();
    let lastText = "";
    let lastThink = "";
    let finalVisibleText = "";
    let finalVisibleTextId = null;
    let lastUsage = null;
    let lastModel = model.id;
    let modelTurns = 0;
    let lastStopReason = "";
    let lastModelError = "";
    const argsMap = {};

    const unsub = agent.subscribe(async (event) => {
      try {
        switch (event.type) {
          case "turn_start":
            modelTurns += 1;
            curTextId = randomUUID();
            curThinkId = randomUUID();
            lastText = "";
            lastThink = "";
            lastUsage = null;
            lastModel = model.id;
            break;
          case "turn_end":
            {
              const message = event.message || {};
              lastStopReason = String(message.stopReason || lastStopReason || "");
              lastModelError = String(message.errorMessage || lastModelError || "");
              const usage = normalizePiUsageForTrace(message.usage) || lastUsage;
              const { text } = extractParts(message.content);
              if (text && text !== finalVisibleText) {
                finalVisibleText = text;
                finalVisibleTextId = curTextId;
              }
              const visibleText = text || lastText;
              const traceText = visibleText || assistantMessageTraceText(message) || lastThink || "LLM turn";
              if (usage && emitAssistantText) {
                await stream_callback(traceText, {
                  content_id: curTextId,
                  content_type: "markdown",
                  title: visibleText ? undefined : "LLM 工具决策",
                  display: Boolean(visibleText),
                  msg_category: visibleText ? "" : "llm_trace",
                  usage,
                  model: message.responseModel || message.model || lastModel || model.id,
                });
              }
            }
            flush();
            break;
          case "message_update": {
            const partial = event.assistantMessageEvent?.partial;
            const { text, thinking } = extractParts(partial?.content);
            const usage = normalizePiUsageForTrace(partial?.usage);
            if (usage) lastUsage = usage;
            lastModel = partial?.responseModel || partial?.model || lastModel || model.id;
            if (thinking && thinking !== lastThink) {
              lastThink = thinking;
              await stream_callback(thinking, { content_id: curThinkId, content_type: "thinking", title: "思考" });
            }
            if (text && text !== lastText) {
              lastText = text;
              finalVisibleText = text;
              finalVisibleTextId = curTextId;
              if (emitAssistantText) {
                await stream_callback(text, {
                  content_id: curTextId,
                  content_type: "markdown",
                  usage: lastUsage,
                  model: lastModel,
                });
              }
            }
            break;
          }
          case "tool_execution_start": {
            argsMap[event.toolCallId] = event.args;
            if (SILENT_TOOLS.has(event.toolName)) break;
            await stream_callback(`${event.toolName} ${shortArgs(event.args)}`, {
              content_id: event.toolCallId,
              content_type: "tool",
              title: "running",
              tool_name: event.toolName,
              trace_input: traceJson(event.args),
            });
            break;
          }
          case "tool_execution_end": {
            if (SILENT_TOOLS.has(event.toolName)) break;
            const args = argsMap[event.toolCallId] || {};
            await stream_callback(`${event.toolName} ${shortArgs(argsMap[event.toolCallId] || {})}`, {
              content_id: event.toolCallId,
              content_type: "tool",
              title: event.isError ? "error" : "done",
              tool_name: event.toolName,
              trace_input: traceJson(args),
              trace_output: traceJson(resultText(event.result)),
            });
            break;
          }
        }
      } catch (e) {
        console.error("[query_agent event]", e?.message || e);
      }
    });

    try {
      if (continueFromTranscript) await agent.continue();
      else await agent.prompt(userMessage);
      if (agentContext?.data?._suspended_by_ask_user) {
        return {
          success: true,
          suspended: true,
          status: "needs_input",
          answer: "",
          stop_reason: lastStopReason || "tool_use",
          model_turns: modelTurns,
        };
      }
      const terminalMessage = lastAssistantMessage(agent.state?.messages || []);
      const terminalAnswer = terminalNaturalAnswer(agent.state?.messages || []);
      if (terminalAnswer) {
        if (agentContext?.data) agentContext.data._completed_by_natural_answer = true;
        if (emitAssistantText) {
          await stream_callback(terminalAnswer, {
            content_id: finalVisibleTextId || randomUUID(),
            content_type: "markdown",
            title: "回答",
            display: true,
            msg_category: "final_answer",
            usage: lastUsage,
            model: lastModel,
          });
        }
        return {
          success: true,
          status: "completed",
          completed_by: "native_stop",
          natural_answer: true,
          answer: terminalAnswer,
          evidence: summarizeQueryEvidence(agentContext?.data?.tool_history),
          provider: model.provider,
          model: lastModel,
          stop_reason: lastStopReason || "stop",
          model_turns: modelTurns,
        };
      }
      const failure = buildQueryFailureDetails({
        stopReason: lastStopReason || terminalMessage?.stopReason || "",
        errorMessage: lastModelError || terminalMessage?.errorMessage || agent.state?.errorMessage || "",
        modelTurns,
        timeoutMs,
        aborted: Boolean(externalSignal?.aborted),
      });
      const message = failure.message;
      if (emitAssistantText) {
        await stream_callback(`⚠️ ${message}`, {
          content_id: randomUUID(),
          content_type: "markdown",
          title: "错误",
        });
      }
      return {
        success: false,
        status: "failed",
        error: message,
        error_emitted: true,
        ...failure,
        provider: model.provider,
        model: lastModel,
      };
    } catch (e) {
      console.error("[query_agent prompt]", e?.stack || e?.message || e);
      const failure = buildQueryFailureDetails({
        stopReason: externalSignal?.aborted ? "aborted" : lastStopReason || "error",
        errorMessage: e?.message || lastModelError || agent.state?.errorMessage || String(e),
        modelTurns,
        timeoutMs,
        aborted: Boolean(externalSignal?.aborted),
      });
      if (emitAssistantText) {
        await stream_callback(`⚠️ ${failure.message}`, {
          content_id: randomUUID(),
          content_type: "markdown",
          title: "错误",
        });
      }
      return {
        success: false,
        status: "failed",
        error: failure.message,
        error_emitted: true,
        ...failure,
        provider: model.provider,
        model: lastModel,
      };
    } finally {
      unsub();
      flush();
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
      if (typeof unregisterAgent === "function") unregisterAgent(agent);
    }
  }
}

export default QueryAgent;
