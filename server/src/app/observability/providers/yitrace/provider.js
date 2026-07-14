import { fork } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_CONFIG } from "../../../../generated/app-config.js";
import { createNoopTraceRecorder } from "../../../../engine/observability/recorder.js";
import { sanitizeTraceValue, traceText } from "../../../../engine/observability/redaction.js";
import { activeTraceSpanId } from "../../../../engine/trace/trace_context.js";

const ROOT_SPAN_ID = "pi-desktop-run";
const TENANT_ID = 1;
const WORKER_TIMEOUT_MS = 5_000;
const WARMUP_TIMEOUT_MS = 60_000;
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");

let worker = null;
let workerSeq = 0;
const pending = new Map();

export function yiTraceDataDir() {
  return process.env.PI_YITRACE_DIR || join(homedir(), APP_CONFIG.dataDirName, "yitrace");
}

function clearPending(value = null) {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.resolve(value);
  }
  pending.clear();
  worker?.channel?.unref?.();
}

function unrefWorkerChannelWhenIdle() {
  if (pending.size === 0) worker?.channel?.unref?.();
}

function ensureWorker() {
  if (worker?.connected) return worker;
  worker = fork(workerPath, [], {
    // 测试和嵌入式启动可能通过 `node -e` 运行后端。fork 默认会继承
    // `-e`、`--input-type` 等参数，结果可能再次执行父脚本而不是 worker 文件。
    execArgv: [],
    env: {
      ...process.env,
      PI_YITRACE_DIR: yiTraceDataDir(),
      PI_YITRACE_TENANT_ID: String(TENANT_ID),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  worker.on("message", (message = {}) => {
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    if (!message.ok) console.warn("[yitrace] worker 请求失败:", message.error || "unknown error");
    item.resolve(message.ok ? message.data : null);
    unrefWorkerChannelWhenIdle();
  });
  worker.on("exit", () => {
    worker = null;
    clearPending(null);
  });
  worker.on("error", (error) => {
    console.warn("[yitrace] worker 异常:", error?.message || error);
  });
  // yiTrace 不应让一次性的脚本或测试进程无法正常退出。桌面后端本身
  // 还有 HTTP/IPC 句柄维持运行，父进程退出时 worker 会收到 disconnect。
  worker.unref?.();
  worker.channel?.unref?.();
  return worker;
}

function workerCall(action, payload = {}, timeoutMs = WORKER_TIMEOUT_MS) {
  const child = ensureWorker();
  if (!child?.connected) return Promise.resolve(null);
  child.channel?.ref?.();
  const id = `yitrace-${++workerSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      console.warn(`[yitrace] worker ${action} 超时`);
      resolve(null);
      unrefWorkerChannelWhenIdle();
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, timer });
    try {
      child.send({ id, action, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      console.warn(`[yitrace] worker ${action} 发送失败:`, error?.message || error);
      resolve(null);
      unrefWorkerChannelWhenIdle();
    }
  });
}

export function warmupYiTrace() {
  return workerCall("warmup", {}, WARMUP_TIMEOUT_MS);
}

export async function closeYiTrace() {
  const child = worker;
  if (!child?.connected) return;
  await workerCall("close", {}, 1_500);
  if (child.connected) child.kill();
}

export function readYiTraceRun(runId) {
  return workerCall("trace", { runId: String(runId || "") });
}

function nowNs() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function durationNs(startedAt) {
  return Math.max(0, Date.now() - Number(startedAt || Date.now())) * 1_000_000;
}

function safeToken(value, fallback = "span") {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || fallback;
}

function statusCode(status, error = null) {
  return error || status === "failed" || status === "error" || status === 1 ? 1 : 0;
}

function usageValue(usage, ...keys) {
  for (const key of keys) {
    const value = Number(usage?.[key] || 0);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function createYiTraceRecorder({ projectId, sessionId, runId, mode = "workspace", question = "" } = {}) {
  if (!projectId || !sessionId || !runId) return createNoopTraceRecorder();

  const rootAttrs = {
    project_id: String(projectId),
    mode: String(mode || "workspace"),
    external_run_id: String(runId),
    source: "pi-desktop",
  };
  const commands = [];
  const started = new Set([ROOT_SPAN_ID]);
  const ended = new Set();
  const startedAt = new Map([[ROOT_SPAN_ID, Date.now()]]);
  const spanInfo = new Map([[ROOT_SPAN_ID, { kind: "agent", name: "PI Desktop Agent" }]]);
  let agentSeq = 0;
  let llmSeq = 0;
  let finished = false;

  commands.push({
    op: "start",
    data: {
      spanId: ROOT_SPAN_ID,
      name: "Agent Run",
      agentName: "PI Desktop",
      inputText: traceText(question),
      attrs: rootAttrs,
      ts: nowNs(),
    },
  });

  const resolveParent = (preferred = "") => {
    const parent = String(preferred || activeTraceSpanId() || "");
    return parent && started.has(parent) ? parent : ROOT_SPAN_ID;
  };

  const startSpan = ({ spanId, parentSpanId = "", kind = "span", name = "span", input = "", attrs = {}, ...fields }) => {
    const id = String(spanId || "").trim();
    if (!id || started.has(id)) return id;
    const parent = resolveParent(parentSpanId);
    started.add(id);
    startedAt.set(id, Date.now());
    spanInfo.set(id, { kind, name });
    commands.push({
      op: "start",
      data: {
        spanId: id,
        parentSpanId: parent,
        name,
        inputText: traceText(input),
        attrs: sanitizeTraceValue(attrs),
        ts: nowNs(),
        ...fields,
      },
    });
    return id;
  };

  const endSpan = ({ spanId, output = "", status = 0, error = null, durationMs = 0, attrs = {}, ...fields }) => {
    const id = String(spanId || "").trim();
    if (!id || !started.has(id) || ended.has(id)) return;
    commands.push({
      op: "end",
      data: {
        spanId: id,
        status: statusCode(status, error),
        outputText: traceText(error ? error?.message || error : output),
        durationNs: Math.max(0, Number(durationMs || 0)) * 1_000_000 || durationNs(startedAt.get(id)),
        attrs: sanitizeTraceValue(attrs),
        ts: nowNs(),
        ...fields,
      },
    });
    ended.add(id);
  };

  const recorder = {
    recordToolStart({ toolCallId = "", name = "tool", input = "", attrs = {}, parentSpanId = "" } = {}) {
      return startSpan({
        spanId: String(toolCallId || `pi-tool:${safeToken(name)}:${Date.now()}`),
        parentSpanId,
        kind: "tool",
        name,
        input,
        attrs,
        toolName: name,
      });
    },

    recordToolEnd({ toolCallId = "", output = "", status = 0, error = null, durationMs = 0, attrs = {} } = {}) {
      endSpan({ spanId: toolCallId, output, status, error, durationMs, attrs });
    },

    recordAgentStart({ name = "agent", input = "", attrs = {}, parentSpanId = "" } = {}) {
      const spanId = `pi-agent:${safeToken(name)}:${Date.now()}:${++agentSeq}`;
      return startSpan({ spanId, parentSpanId, kind: "agent", name, input, attrs, agentName: name });
    },

    recordAgentEnd({ spanId = "", output = "", status = 0, error = null, durationMs = 0, attrs = {} } = {}) {
      endSpan({ spanId, output, status, error, durationMs, attrs });
    },

    recordLlmCall({ callSite = "", model = "", input = "", output = "", usage = null, status = 0, error = null, durationMs = 0, attrs = {} } = {}) {
      if (finished) return;
      const parentSpanId = resolveParent();
      const spanId = `pi-llm:${safeToken(parentSpanId)}:${Date.now()}:${++llmSeq}`;
      const inputTokens = usageValue(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
      const outputTokens = usageValue(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
      const cachedTokens = usageValue(usage, "cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens");
      const costUsd = Number(usage?.cost_usd || usage?.costUsd || 0) || 0;
      startSpan({
        spanId,
        parentSpanId,
        kind: "llm",
        name: callSite ? `LLM ${callSite}` : "LLM Call",
        input,
        attrs: { call_site: callSite, ...attrs },
        model,
      });
      endSpan({
        spanId,
        output,
        status,
        error,
        durationMs,
        inputTokens: inputTokens || null,
        outputTokens: outputTokens || null,
        attrs: {
          call_site: callSite,
          input_tokens: inputTokens || null,
          output_tokens: outputTokens || null,
          cached_tokens: cachedTokens || null,
          cost_usd: costUsd || null,
          trace_input_tokens: inputTokens || null,
          trace_output_tokens: outputTokens || null,
          trace_cached_tokens: cachedTokens || null,
          trace_cost_usd: costUsd || null,
          ...attrs,
        },
      });
    },

    traceSpanInfo(spanId = "") {
      const id = started.has(spanId) ? spanId : ROOT_SPAN_ID;
      return { spanId: id, ...(spanInfo.get(id) || { kind: "span", name: "" }) };
    },

    currentTraceSpanInfo() {
      return recorder.traceSpanInfo(activeTraceSpanId());
    },

    async finish({ status = "completed", error = null, output = "" } = {}) {
      if (finished) return;
      finished = true;
      for (const spanId of started) {
        if (spanId === ROOT_SPAN_ID || ended.has(spanId)) continue;
        endSpan({ spanId, status, error });
      }
      endSpan({
        spanId: ROOT_SPAN_ID,
        output,
        status,
        error,
        attrs: { run_status: status },
      });
      try {
        await workerCall("ingest", {
          defaults: {
            traceId: String(runId),
            sessionId: String(sessionId),
            tenantId: TENANT_ID,
            attrs: rootAttrs,
          },
          commands,
        });
      } catch (ingestError) {
        console.warn("[yitrace] trace 写入失败:", ingestError?.message || ingestError);
      }
    },
  };

  return recorder;
}
