import { runWorkflowSkill } from "../../../engine/skills/workflow_skill_runner.js";
import { array, object, text } from "./common.js";
import { buildTraceIndex, traceGetSpan, traceTools } from "./trace_evidence.js";

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_ACTIONS = 3;

function clip(value, max = 2400) {
  const textValue = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  if (textValue.length <= max) return textValue;
  return `${textValue.slice(0, max)}\n...[truncated ${textValue.length - max} chars]`;
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeActionName(value) {
  const raw = compact(value).replace(/^trace[.:]/i, "").toLowerCase();
  const aliases = {
    getspan: "get_span",
    span: "get_span",
    get: "get_span",
    child: "children",
    get_children: "children",
    get_parent: "parent",
    get_siblings: "siblings",
    find: "search",
    payload_page: "payload",
    read_payload: "payload",
  };
  return aliases[raw] || raw;
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, { min, max, fallback }) {
  return Math.max(min, Math.min(max, safeNumber(value, fallback)));
}

function summarizeSpan(span) {
  if (!span) return null;
  return {
    span_id: span.span_id,
    parent_span_id: span.parent_span_id || "",
    kind: span.kind,
    name: span.name,
    status: span.status,
    duration_ms: span.duration_ms,
    input_preview: clip(span.input || "", 900),
    output_preview: clip(span.output || "", 900),
    logs_preview: array(span.logs).slice(0, 4).map((item) => clip(item, 500)),
    attrs: object(span.attrs),
  };
}

function summarizeResult(result) {
  if (Array.isArray(result)) return result.slice(0, 8).map(summarizeSpan).filter(Boolean);
  if (result && typeof result === "object" && ("span_id" in result || "kind" in result || "name" in result)) {
    return summarizeSpan(result);
  }
  return result;
}

export function normalizeTraceActions(payload, maxActions = DEFAULT_MAX_ACTIONS) {
  const src = object(payload);
  const raw =
    src.next_trace_actions ||
    src.nextTraceActions ||
    src.trace_actions ||
    src.traceActions ||
    src.actions ||
    src.next_trace_action ||
    src.nextTraceAction;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows
    .map((item) => {
      const action = object(item);
      const type = normalizeActionName(action.type || action.action || action.tool || action.name);
      return {
        type,
        span_id: text(action.span_id || action.spanId),
        query: text(action.query),
        kind: text(action.kind),
        status: text(action.status),
        field: text(action.field || "input") || "input",
        offset: safeNumber(action.offset, 0),
        limit: safeNumber(action.limit, 1600),
        reason: text(action.reason),
      };
    })
    .filter((action) => action.type)
    .slice(0, Math.max(1, Math.min(DEFAULT_MAX_ACTIONS, Number(maxActions || DEFAULT_MAX_ACTIONS))));
}

export function executeTraceAction(traceSnapshot, action) {
  const type = normalizeActionName(action?.type);
  const safeAction = { ...action, type };
  let result;
  if (type === "overview") {
    result = traceTools.overview(traceSnapshot);
  } else if (type === "get_span") {
    result = traceTools.get_span(traceSnapshot, action.span_id);
  } else if (type === "children") {
    result = traceTools.children(traceSnapshot, action.span_id);
  } else if (type === "parent") {
    result = traceTools.parent(traceSnapshot, action.span_id);
  } else if (type === "siblings") {
    result = traceTools.siblings(traceSnapshot, action.span_id);
  } else if (type === "search") {
    result = traceTools.search(traceSnapshot, {
      query: action.query,
      kind: action.kind,
      status: action.status,
      limit: clampNumber(action.limit, { min: 1, max: 8, fallback: 8 }),
    });
  } else if (type === "payload") {
    result = traceTools.payload(traceSnapshot, {
      span_id: action.span_id,
      field: action.field,
      offset: clampNumber(action.offset, { min: 0, max: 200000, fallback: 0 }),
      limit: clampNumber(action.limit, { min: 1, max: 3000, fallback: 1600 }),
    });
  } else {
    return {
      ok: false,
      action: safeAction,
      observation: `不支持的 Trace 动作: ${type || "unknown"}`,
      result: null,
    };
  }
  const summarized = summarizeResult(result);
  return {
    ok: Boolean(Array.isArray(result) ? result.length : result),
    action: safeAction,
    observation: `${type}${action.span_id ? ` ${action.span_id}` : ""}${action.query ? ` query=${action.query}` : ""}`,
    result: summarized,
  };
}

function isFinalDiagnosis(payload) {
  const src = object(payload);
  if (src.final === true || src.status === "final") return true;
  if (src.failure_stage || src.failureStage) return true;
  if (src.root_cause || src.rootCause) return true;
  return false;
}

function diagnosisSpanReferences(payload) {
  const src = object(payload);
  const first = object(src.first_divergence || src.firstDivergence);
  return [...new Set([
    text(first.span_id || first.spanId),
    ...array(src.evidence_path || src.evidencePath).map((item) => {
      const row = object(item);
      return text(row.span_id || row.spanId);
    }),
  ].filter(Boolean))];
}

function canonicalTraceSpanId(traceSnapshot, value) {
  const requested = text(value);
  if (!requested || traceGetSpan(traceSnapshot, requested)) return requested;
  const spans = buildTraceIndex(traceSnapshot).spans;

  // yiTrace 的完整 ID 可能很长，模型有时只复制稳定的尾部。只有唯一命中时才补全，
  // 避免用模糊字符串把诊断绑定到错误 Span。
  if (requested.length >= 12) {
    const suffixMatches = spans.filter((span) => span.span_id.endsWith(`:${requested}`));
    if (suffixMatches.length === 1) return suffixMatches[0].span_id;
  }

  // 模型也会把同名工具写成 execute_sql_1。序号严格按 Trace 顺序、从 1 开始，
  // 且工具名必须逐字相同，不能用问题内容猜 Span。
  const ordinal = requested.match(/^(.*)_(\d+)$/);
  if (ordinal) {
    const name = ordinal[1];
    const index = Number(ordinal[2]) - 1;
    const matches = spans.filter((span) => span.name === name).sort((a, b) => a.order - b.order);
    if (index >= 0 && index < matches.length) return matches[index].span_id;
  }
  return requested;
}

function canonicalizeDiagnosisSpanReferences(payload, traceSnapshot) {
  const src = object(payload);
  const first = object(src.first_divergence || src.firstDivergence);
  const evidence = array(src.evidence_path || src.evidencePath);
  return {
    ...src,
    ...(Object.keys(first).length ? {
      first_divergence: {
        ...first,
        span_id: canonicalTraceSpanId(traceSnapshot, first.span_id || first.spanId),
      },
    } : {}),
    ...(evidence.length ? {
      evidence_path: evidence.map((item) => {
        const row = object(item);
        return {
          ...row,
          span_id: canonicalTraceSpanId(traceSnapshot, row.span_id || row.spanId),
        };
      }),
    } : {}),
  };
}

function observedSpanIds(baseInput, observations) {
  const ids = new Set(
    array(object(object(baseInput).trace_evidence_pack || object(baseInput).traceEvidencePack).evidence_spans)
      .map((span) => text(object(span).span_id || object(span).spanId))
      .filter(Boolean),
  );
  const add = (value) => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    const row = object(value);
    const spanId = text(row.span_id || row.spanId);
    if (spanId) ids.add(spanId);
  };
  for (const observation of observations) add(object(observation).result);
  return ids;
}

function invalidDiagnosisSpanReferences(payload, traceSnapshot) {
  return diagnosisSpanReferences(payload).filter((spanId) => !traceGetSpan(traceSnapshot, spanId));
}

function repairInvalidSpanReferences(traceSnapshot, invalidSpanIds, round) {
  const repairs = invalidSpanIds.map((spanId) => executeTraceAction(traceSnapshot, {
    type: "search",
    query: spanId,
    limit: 8,
    reason: "模型把名称当成 span_id，搜索真实 Span 候选",
  }));
  return [
    {
      ok: false,
      action: { type: "validate_span_ids", invalid_span_ids: invalidSpanIds },
      observation: `第 ${round} 轮诊断引用了无效 span_id: ${invalidSpanIds.join(", ")}。必须从搜索结果的 span_id 字段中重新选择。`,
      result: null,
    },
    ...repairs,
  ];
}

function debuggerInput(baseInput, { round, maxRounds, observations, lastActionResults }) {
  return {
    ...baseInput,
    trace_debugger: {
      round,
      max_rounds: maxRounds,
      allowed_actions: [
        "overview",
        "get_span",
        "children",
        "parent",
        "siblings",
        "search",
        "payload",
      ],
      instruction: [
        "如果当前证据不足，只输出 next_trace_actions，请说明 reason。",
        "如果证据足够，按 Gold Solve 步骤和 Trace 顺序输出第一次分歧，以及 failure_stage、summary、evidence、evidence_path、recommended_actions。",
        "first_divergence 必须包含 gold_step_id、span_id 和 summary；span_id 必须已经观察到。",
        "每条 evidence_path 必须引用 span_id；不能引用未观察到的 span。",
        "span_id 是 Trace 返回的真实标识（例如 call_xxx），不是工具名、Agent 名或阶段名。只能逐字复制 observations/result/span_id 或 trace_evidence_pack.evidence_spans/span_id。",
      ].join("\n"),
      observations,
      last_action_results: lastActionResults,
    },
  };
}

export async function runTraceDebugger(ctx, {
  projectId,
  skillName,
  task,
  baseInput,
  traceSnapshot,
  responseContract = "",
  callSite,
  temperature = 0.1,
  maxTokens = 6000,
  modelId = null,
  inputMaxChars = 36000,
  maxRounds = DEFAULT_MAX_ROUNDS,
  maxActionsPerRound = DEFAULT_MAX_ACTIONS,
  runStep = runWorkflowSkill,
} = {}) {
  const observations = [];
  let lastActionResults = [];
  let lastResult = null;

  for (let round = 1; round <= Math.max(1, Number(maxRounds || DEFAULT_MAX_ROUNDS)); round += 1) {
    const result = await runStep(ctx, {
      projectId,
      skillName,
      task,
      input: debuggerInput(baseInput, { round, maxRounds, observations, lastActionResults }),
      responseContract: [
        responseContract,
        "如果需要继续下钻，可以只输出 {\"next_trace_actions\":[{\"type\":\"get_span|children|parent|siblings|search|payload|overview\",\"span_id\":\"\",\"query\":\"\",\"reason\":\"\"}]}。",
      ].filter(Boolean).join("\n"),
      callSite,
      temperature,
      maxTokens,
      modelId,
      inputMaxChars,
    });
    const data = canonicalizeDiagnosisSpanReferences(object(result?.data || result), traceSnapshot);
    lastResult = { skill: result?.skill, data };
    const actions = normalizeTraceActions(data, maxActionsPerRound);

    if (isFinalDiagnosis(data)) {
      const references = diagnosisSpanReferences(data);
      const invalidReferences = invalidDiagnosisSpanReferences(data, traceSnapshot);
      const observed = observedSpanIds(baseInput, observations);
      const unobservedReferences = references.filter((spanId) => !observed.has(spanId));
      if (references.length && !invalidReferences.length && !unobservedReferences.length) {
        return {
          skill: result?.skill,
          data: {
            ...data,
            trace_debugger: {
              rounds: round,
              observations,
            },
          },
        };
      }
      lastActionResults = repairInvalidSpanReferences(
        traceSnapshot,
        invalidReferences.length
          ? invalidReferences
          : unobservedReferences.length
            ? unobservedReferences
            : [text(data.failure_stage || data.failureStage || "tool")],
        round,
      );
      observations.push(...lastActionResults.map((item) => ({
        round,
        action: item.action,
        ok: item.ok,
        observation: item.observation,
        result: item.result,
      })));
      continue;
    }

    if (!actions.length) {
      return {
        skill: result?.skill,
        data: {
          ...data,
          trace_debugger: {
            rounds: round,
            observations,
          },
        },
      };
    }

    lastActionResults = actions.map((action) => executeTraceAction(traceSnapshot, action));
    observations.push(...lastActionResults.map((item) => ({
      round,
      action: item.action,
      ok: item.ok,
      observation: item.observation,
      result: item.result,
    })));
  }

  return {
    skill: lastResult?.skill,
    data: {
      ...(lastResult?.data || {}),
      trace_gaps: [
        ...array(lastResult?.data?.trace_gaps || lastResult?.data?.traceGaps).map(String),
        "TraceDebugger 达到下钻轮数上限，诊断可能不完整。",
      ],
      warnings: [
        ...array(lastResult?.data?.warnings).map(String),
        "TraceDebugger 达到下钻轮数上限。",
      ],
      trace_debugger: {
        rounds: Math.max(1, Number(maxRounds || DEFAULT_MAX_ROUNDS)),
        observations,
      },
    },
  };
}
