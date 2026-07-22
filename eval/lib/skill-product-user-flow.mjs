#!/usr/bin/env node

const baseUrl = String(process.env.YIW_BASE_URL || "http://127.0.0.1:57138").replace(/\/$/, "");
const prompt = process.env.YIW_SKILL_PRODUCT_PROMPT || [
  "帮我下载 thesis-tracker Skill。",
  "请把这个 Skill 做成一套投资观点跟踪小程序，嵌入到 YiW App 内。",
  "需要长期保存观点、论点、反证、催化剂和更新日志。",
  "请先下载，再由你根据 Skill 内容自动生成前端页面和后端数据逻辑，预览后安装。",
  "不要让我提供页面 JSON。",
].join("");
const installPrompt = [
  "确认安装刚才预览的 thesis-tracker 小程序。",
  "请直接调用安装工具，使用刚才预览返回的 revision、validation_hash 和 preview_token，",
  "不要重新生成草稿，也不要只用文字回复。",
].join("");

const approvedTools = new Set(["skill_download", "ui_module_draft_install"]);

async function jsonRequest(path, { method = "GET", token = "", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `${method} ${path} failed with HTTP ${response.status}`);
  }
  return payload?.data ?? payload;
}

async function approve(token, toolCallId, approved) {
  await jsonRequest("/api/agent/tool-decision", {
    method: "POST",
    token,
    body: { toolCallId, approved },
  });
}

function eventSummary(event) {
  const payload = event?.payload || {};
  return {
    type: event?.type || "",
    name: payload.name || payload.tool_name || "",
    tool_call_id: payload.tool_call_id || "",
    event: payload.event || "",
    module_id: payload.module_id || payload.module?.id || "",
    module_key: payload.module_key || payload.module?.module_key || "",
    draft_id: payload.draft_id || "",
  };
}

async function runChat(token, sessionId, message) {
  const response = await fetch(`${baseUrl}/api/agent/projects/${encodeURIComponent("__chat__")}/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, approval: "ask" }),
  });
  if (!response.ok || !response.body) throw new Error(`chat failed with HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const approvals = [];

  const consume = async (frame) => {
    const line = frame.split(/\r?\n/).find((item) => item.startsWith("data:"));
    if (!line) return;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") return;
    const event = JSON.parse(value);
    events.push(event);
    if (event.type !== "approval.requested") return;
    const toolName = String(event.payload?.name || "");
    const toolCallId = String(event.payload?.tool_call_id || event.payload?.approval_id || "");
    const allowed = approvedTools.has(toolName);
    approvals.push({ tool: toolName, approved: allowed });
    await approve(token, toolCallId, allowed);
    if (!allowed) throw new Error(`unexpected confirmation tool: ${toolName}`);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) await consume(frame);
  }
  if (buffer.trim()) await consume(buffer);
  return { events, approvals };
}

async function main() {
  const login = await jsonRequest("/api/user/builtin-login");
  const token = String(login?.access_token || "");
  if (!token) throw new Error("builtin login did not return a token");

  const beforeSkills = await jsonRequest("/api/agent/skills", { token });
  const beforeModules = await jsonRequest("/api/ui-modules", { token });
  const session = await jsonRequest(`/api/projects/${encodeURIComponent("__chat__")}/sessions`, {
    method: "POST",
    token,
    body: {
      title: "Skill 小程序真实用户流程",
      source_type: "agent",
      source_id: "__chat__",
      action_type: "agentic_chat",
    },
  });
  const runs = [await runChat(token, session.id, prompt)];
  if (!runs[0].approvals.some((item) => item.tool === "ui_module_draft_install" && item.approved)) {
    runs.push(await runChat(token, session.id, installPrompt));
  }
  const run = {
    events: runs.flatMap((item) => item.events),
    approvals: runs.flatMap((item) => item.approvals),
  };
  const afterSkills = await jsonRequest("/api/agent/skills", { token });
  const afterModules = await jsonRequest("/api/ui-modules", { token });

  const skillsBefore = Array.isArray(beforeSkills) ? beforeSkills : beforeSkills?.items || [];
  const skillsAfter = Array.isArray(afterSkills) ? afterSkills : afterSkills?.items || [];
  const modulesBefore = Array.isArray(beforeModules?.items) ? beforeModules.items : [];
  const modulesAfter = Array.isArray(afterModules?.items) ? afterModules.items : [];
  const imported = skillsAfter.find((item) => item.name === "thesis-tracker");
  const newModules = modulesAfter.filter((item) => !modulesBefore.some((before) => before.id === item.id));
  const installed = newModules.find((item) => item.status === "active") || modulesAfter.find((item) => (
    item.status === "active" && /thesis|观点/i.test(`${item.module_key} ${item.name}`)
  ));
  const detail = installed ? await jsonRequest(`/api/ui-modules/${encodeURIComponent(installed.id)}`, { token }) : null;
  const compactEvents = run.events
    .filter((event) => ["tool.completed", "tool.failed", "approval.requested", "approval.resolved", "workspace.updated", "run.completed", "run.failed"].includes(event.type))
    .map(eventSummary);
  const summary = {
    session_id: session.id,
    prompt,
    follow_up_prompt: runs.length > 1 ? installPrompt : null,
    approvals: run.approvals,
    skill: imported ? {
      name: imported.name,
      source_url: imported.provenance?.source_url || null,
      sha256: imported.provenance?.sha256 || null,
      adapted_for_product: imported.provenance?.adapted_for_product === true,
      allowed_tools: imported.allowed_tools || [],
      existed_before: skillsBefore.some((item) => item.name === imported.name),
    } : null,
    module: detail ? {
      id: detail.id,
      module_key: detail.module_key,
      name: detail.name,
      status: detail.status,
      version: detail.version?.version || null,
      pages: Object.keys(detail.version?.pages || {}),
      actions: Object.keys(detail.version?.actions || {}),
      permissions: detail.granted_permissions || [],
      skill_product: detail.skill_product || null,
    } : null,
    events: compactEvents,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!imported) throw new Error("App chat did not import thesis-tracker");
  if (!detail || detail.status !== "active") throw new Error("App chat did not install an active Skill Product");
  if (!detail.skill_product || detail.skill_product.skill_name !== imported.name) throw new Error("installed module is not bound to the downloaded Skill");
  if (Object.keys(detail.version?.pages || {}).length < 4) throw new Error("generated product does not contain at least four real pages");
  if (!Object.prototype.hasOwnProperty.call(detail.version?.actions || {}, "load_product_data")) {
    throw new Error("generated product does not contain the product data backend action");
  }
  if (!run.approvals.some((item) => item.tool === "skill_download" && item.approved)) throw new Error("download confirmation was not observed");
  if (!run.approvals.some((item) => item.tool === "ui_module_draft_install" && item.approved)) throw new Error("install confirmation was not observed");
}

main().catch((error) => {
  console.error(`[skill-product-user-flow] ${error?.stack || error}`);
  process.exitCode = 1;
});
