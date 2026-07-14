import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("yiTrace provider writes and reads Agent, LLM, and tool spans with redaction", { concurrency: false }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-yitrace-"));
  process.env.PI_YITRACE_DIR = dataDir;
  const {
    closeYiTrace,
    createYiTraceRecorder,
    readYiTraceRun,
  } = await import("../src/app/observability/providers/yitrace/provider.js");
  const { listSessionTraces } = await import("../src/app/observability/trace_service.js");

  try {
    const recorder = createYiTraceRecorder({
      projectId: "project-1",
      sessionId: "session-1",
      runId: "run-1",
      question: "读取配置，authorization: Bearer private-token",
    });
    const agentSpanId = recorder.recordAgentStart({ name: "WorkspaceAgent", input: "处理任务" });
    recorder.recordToolStart({
      toolCallId: "tool-1",
      name: "read",
      input: { path: "/tmp/config.json", api_key: "private-key" },
      parentSpanId: agentSpanId,
    });
    recorder.recordToolEnd({
      toolCallId: "tool-1",
      output: { ok: true, token: "private-tool-token" },
      durationMs: 2,
    });
    recorder.recordLlmCall({
      callSite: "workspace_agent",
      model: "test-model",
      input: "总结工具结果",
      output: "任务完成",
      usage: { input_tokens: 12, output_tokens: 6 },
      durationMs: 3,
    });
    recorder.recordAgentEnd({ spanId: agentSpanId, output: "任务完成", durationMs: 5 });
    await recorder.finish({ status: "completed", output: "任务完成" });

    const result = await readYiTraceRun("run-1");
    assert.ok(result?.trace);
    const spans = result.trace.spans || [];
    assert.ok(spans.some((span) => span.kind === "agent"));
    assert.ok(spans.some((span) => span.kind === "llm"));
    assert.ok(spans.some((span) => span.kind === "tool"));

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("private-key"), false);
    assert.equal(serialized.includes("private-token"), false);
    assert.equal(serialized.includes("private-tool-token"), false);
    assert.ok(serialized.includes("[REDACTED]"));

    const response = await listSessionTraces({
      async queryOne() { return { id: "session-1" }; },
      async query(sql) {
        if (sql.includes("FROM agent_runs")) {
          return [{
            id: "run-1",
            session_id: "session-1",
            project_id: "project-1",
            status: "completed",
            skill_name: null,
            mode: "workspace",
            created_at: "2026-07-14T00:00:01.000Z",
            updated_at: "2026-07-14T00:00:02.000Z",
            finished_at: "2026-07-14T00:00:02.000Z",
          }];
        }
        if (sql.includes("FROM session_messages")) {
          return [{
            id: "message-1",
            content_items: JSON.stringify([{ type: "text", content: "读取配置" }]),
            sequence_number: 1,
            created_at: "2026-07-14T00:00:00.000Z",
          }];
        }
        return [];
      },
    }, {
      params: { pid: "project-1", sid: "session-1" },
      query: { limit: "10" },
    });
    const item = response.data.items[0];
    assert.equal(item.question.questionText, "读取配置");
    assert.ok(
      item.trace.spans.some((span) => span.kind === "llm" && span.inTok === 12 && span.outTok === 6),
      JSON.stringify(item.trace.spans),
    );
    assert.ok(item.trace.spans.some((span) => span.kind === "tool" && span.input.includes("[REDACTED]")));
  } finally {
    await closeYiTrace();
    delete process.env.PI_YITRACE_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("yiTrace storage failure does not fail the Agent run", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-desktop-yitrace-failure-"));
  const blockedPath = join(tempDir, "not-a-directory");
  await writeFile(blockedPath, "file");
  process.env.PI_YITRACE_DIR = join(blockedPath, "yitrace");
  const { closeYiTrace, createYiTraceRecorder } = await import("../src/app/observability/providers/yitrace/provider.js");

  try {
    // 上一个测试关闭 worker 后，等待 exit 回调清掉进程引用。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recorder = createYiTraceRecorder({
      projectId: "project-failure",
      sessionId: "session-failure",
      runId: "run-failure",
      question: "仍应完成对话",
    });
    await assert.doesNotReject(() => recorder.finish({ status: "completed", output: "完成" }));
  } finally {
    await closeYiTrace();
    delete process.env.PI_YITRACE_DIR;
    await rm(tempDir, { recursive: true, force: true });
  }
});
