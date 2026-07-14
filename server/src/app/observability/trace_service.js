import { ApiError } from "../../errors.js";
import { readYiTraceRun, yiTraceDataDir } from "./providers/yitrace/provider.js";

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function messageText(value) {
  const items = parseJson(value, []);
  return (Array.isArray(items) ? items : [])
    .map((item) => item?.type === "text" ? String(item.content || item.text || "") : "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function statusText(value) {
  if (value == null || value === "" || value === 0 || value === "0" || value === "ok" || value === "completed") return "ok";
  return "error";
}

function logMessages(span, detail) {
  const events = [
    ...(Array.isArray(span?.logEvents) ? span.logEvents : []),
    ...(Array.isArray(detail?.logEvents) ? detail.logEvents : []),
  ];
  return [...new Set(events.flatMap((event) => Array.isArray(event?.messages) ? event.messages.map(String) : []))];
}

function normalizeTrace(raw, run) {
  const trace = raw?.trace;
  if (!trace) return null;
  const details = new Map();
  for (const detail of raw.details || []) {
    for (const key of [detail.externalSpanId, detail.external_span_id, detail.spanId, detail.span_id, detail.id]) {
      if (key != null && key !== "") details.set(String(key), detail);
    }
  }
  const spans = (trace.spans || []).map((span, index) => {
    const id = String(span.spanId ?? span.span_id ?? span.id ?? `span-${index}`);
    const externalSpanId = span.externalSpanId ?? span.external_span_id ?? id;
    const detail = details.get(String(externalSpanId)) || details.get(id) || {};
    const attrs = {
      ...(span.attrs && typeof span.attrs === "object" ? span.attrs : {}),
      ...(detail.attrs && typeof detail.attrs === "object" ? detail.attrs : {}),
    };
    const parentId = span.parentId ?? span.parent_id ?? detail.parentId ?? detail.parent_id ?? null;
    const externalParentSpanId = span.externalParentSpanId ?? span.external_parent_span_id
      ?? detail.externalParentSpanId ?? detail.external_parent_span_id ?? null;
    return {
      id,
      parentId: parentId == null ? null : String(parentId),
      externalTraceId: span.externalTraceId ?? span.external_trace_id ?? trace.externalTraceId ?? trace.external_trace_id ?? run.id,
      externalSpanId: externalSpanId == null ? null : String(externalSpanId),
      externalParentSpanId: externalParentSpanId == null ? null : String(externalParentSpanId),
      externalSessionId: span.externalSessionId ?? span.external_session_id ?? detail.externalSessionId ?? detail.external_session_id ?? run.session_id,
      kind: span.kind || detail.kind || "span",
      name: span.name || detail.name || attrs.tool_name || attrs.agent_name || String(externalSpanId || "span"),
      status: statusText(span.status ?? detail.status),
      depth: 0,
      order: index + 1,
      startMs: firstNumber(span.startMs, span.start_ms, detail.startMs, detail.start_ms),
      durMs: firstNumber(span.durMs, span.duration_ms, detail.durMs, detail.duration_ms)
        || firstNumber(span.durationNs, span.duration_ns, detail.durationNs, detail.duration_ns) / 1_000_000,
      cost: firstNumber(span.cost, detail.cost, attrs.cost_usd, attrs.trace_cost_usd),
      inTok: firstNumber(
        span.inputTokens,
        span.input_tokens,
        detail.inputTokens,
        detail.input_tokens,
        attrs.input_tokens,
        attrs.trace_input_tokens,
      ),
      outTok: firstNumber(
        span.outputTokens,
        span.output_tokens,
        detail.outputTokens,
        detail.output_tokens,
        attrs.output_tokens,
        attrs.trace_output_tokens,
      ),
      model: span.model || detail.model || null,
      input: detail.inputText || detail.input_text || detail.input || span.inputText || span.input_text || span.input || "",
      output: detail.outputText || detail.output_text || detail.output || span.outputText || span.output_text || span.output || "",
      logs: logMessages(span, detail),
      attrs,
    };
  });
  const byExternalId = new Map(spans.map((span) => [String(span.externalSpanId || span.id), span]));
  const depthOf = (span, visiting = new Set()) => {
    const key = String(span.externalSpanId || span.id);
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parent = span.externalParentSpanId ? byExternalId.get(String(span.externalParentSpanId)) : null;
    return parent ? depthOf(parent, visiting) + 1 : 0;
  };
  for (const span of spans) span.depth = depthOf(span);
  spans.sort((a, b) => a.depth - b.depth || a.order - b.order);

  return {
    traceId: String(trace.traceId ?? trace.trace_id ?? run.id),
    externalTraceId: trace.externalTraceId ?? trace.external_trace_id ?? run.id,
    name: "Agent Run",
    status: run.status === "failed" ? "error" : run.status || "ok",
    durMs: spans.find((span) => span.depth === 0)?.durMs || 0,
    cost: spans.reduce((sum, span) => sum + Number(span.cost || 0), 0),
    spanCount: spans.length,
    spans,
  };
}

function questionForRun(run, questions) {
  const runTime = new Date(run.created_at || "").getTime();
  let selected = null;
  for (const question of questions) {
    const questionTime = new Date(question.createdAt || "").getTime();
    if (!Number.isFinite(runTime) || !Number.isFinite(questionTime) || questionTime <= runTime + 1_000) selected = question;
  }
  return selected;
}

export async function listSessionTraces(ctx, input) {
  const { pid, sid } = input.params || {};
  const session = await ctx.queryOne(
    "SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL",
    [sid, pid],
  );
  if (!session) throw new ApiError("会话不存在", 404);
  const limit = Math.max(1, Math.min(50, Number(input.query?.limit || 20)));
  const runs = await ctx.query(
    `SELECT id,session_id,project_id,status,skill_name,mode,created_at,updated_at,finished_at
       FROM agent_runs
      WHERE session_id=$1 AND project_id=$2
      ORDER BY COALESCE(updated_at,created_at) DESC
      LIMIT $3`,
    [sid, pid, limit],
  );
  const rows = await ctx.query(
    `SELECT id,content_items,sequence_number,created_at
       FROM session_messages
      WHERE session_id=$1 AND role='user' AND deleted_at IS NULL
      ORDER BY sequence_number`,
    [sid],
  );
  const questions = rows.map((row, index) => ({
    questionNo: index + 1,
    questionMessageId: row.id,
    questionText: messageText(row.content_items),
    sequenceNumber: Number(row.sequence_number || 0),
    createdAt: row.created_at,
  }));

  const items = await Promise.all(runs.map(async (run) => {
    let trace = null;
    try {
      trace = normalizeTrace(await readYiTraceRun(run.id), run);
    } catch (error) {
      console.warn("[yitrace] trace 读取失败:", error?.message || error);
    }
    return {
      runId: run.id,
      sessionId: run.session_id,
      projectId: run.project_id,
      status: run.status,
      skill: run.skill_name,
      mode: run.mode,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      finishedAt: run.finished_at,
      question: questionForRun(run, questions),
      trace,
    };
  }));

  return { data: { enabled: true, dataDir: yiTraceDataDir(), items } };
}
