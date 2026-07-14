import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.PI_YITRACE_DIR || join(homedir(), ".pi-desktop", "yitrace");
const tenantId = Number(process.env.PI_YITRACE_TENANT_ID || 1);

let dbPromise = null;
let modulePromise = null;

async function loadModule() {
  if (!modulePromise) modulePromise = import("@yitrace/db");
  return modulePromise;
}

async function openDb() {
  if (!dbPromise) {
    dbPromise = loadModule().then(({ YiTraceDB }) => YiTraceDB.open({ dataDir, tenantId }));
  }
  return dbPromise;
}

function serializable(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

async function ingestRun(message) {
  const db = await openDb();
  const { createSpanEventBuilder } = await loadModule();
  const builder = createSpanEventBuilder(message.defaults || {});
  for (const command of message.commands || []) {
    if (command?.op === "start") builder.startSpan(command.data || {});
    else if (command?.op === "log") builder.log(command.data || {});
    else if (command?.op === "end") builder.endSpan(command.data || {});
  }
  const result = await builder.ingest(db);
  await db.flush();
  return result;
}

async function readTraceDetail(runId) {
  const db = await openDb();
  const trace = await db.trace(String(runId || ""));
  if (!trace) return null;
  const details = [];
  for (const span of (trace.spans || []).slice(0, 200)) {
    const spanId = span.externalSpanId || span.external_span_id || span.spanId || span.span_id || span.id;
    if (spanId == null || spanId === "") continue;
    try {
      const detail = await db.span(String(runId || ""), String(spanId));
      if (detail) details.push(detail);
    } catch {
      // 单个 span 详情失败时仍返回 trace 概要。
    }
  }
  return { trace, details };
}

async function handle(message = {}) {
  if (message.action === "warmup") {
    await openDb();
    return true;
  }
  if (message.action === "ingest") return ingestRun(message);
  if (message.action === "trace") return readTraceDetail(message.runId);
  if (message.action === "close") {
    const pending = dbPromise;
    dbPromise = null;
    if (pending) await (await pending)?.close?.();
    return true;
  }
  throw new Error(`unknown yiTrace worker action: ${message.action || ""}`);
}

process.on("message", (message = {}) => {
  const id = message.id;
  void handle(message)
    .then((data) => {
      if (process.connected) process.send({ id, ok: true, data: serializable(data) });
      if (message.action === "close") process.exit(0);
    })
    .catch((error) => {
      if (process.connected) process.send({ id, ok: false, error: error?.message || String(error) });
    });
});

process.on("disconnect", () => {
  void handle({ action: "close" }).finally(() => process.exit(0));
});
