import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppSkill, updateAppSkill } from "../agents/pi_skill_registry.js";
import {
  createSkillProductDraft,
  getModule,
  getModuleState,
  installDraft,
  previewDraft,
  replaceDraft,
  resolveMiniAppAgentCommand,
  runModuleAction,
  validateDraft,
} from "./module_registry.js";
import { buildSkillProductContent, resolveInstalledSkillProduct } from "./skill_product.js";
import {
  getSkillProductState,
  setSkillProductState,
  SKILL_PRODUCT_STATE_GET_TOOL,
  SKILL_PRODUCT_STATE_SET_TOOL,
} from "./skill_product_state.js";

const ANTHROPIC_THESIS_TRACKER_SOURCE = "https://github.com/anthropics/financial-services/blob/main/plugins/vertical-plugins/equity-research/skills/thesis-tracker/SKILL.md";

const ANTHROPIC_THESIS_TRACKER_INSTRUCTIONS = `# Thesis Tracker

## Workflow

### Step 1: Define or Load Thesis

For a new thesis, record company and ticker, long or short position, a falsifiable thesis statement, 3-5 supporting pillars, 3-5 invalidating risks, upcoming catalysts, target valuation, and an exit trigger.

### Step 2: Update Log

For every new data point, record its date, what changed, which pillar it strengthens or weakens, the proposed action, and the updated conviction level.

### Step 3: Thesis Scorecard

Maintain a running scorecard with each pillar's original expectation, current status, evidence, and trend.

### Step 4: Catalyst Calendar

Track catalyst date, event, expected impact, and notes.

### Step 5: Output

Produce a concise thesis summary for a morning meeting, portfolio review, or risk committee. Track disconfirming evidence as rigorously as confirming evidence and review every thesis at least quarterly.

## YiW Product Adapter

Before creating or updating a thesis, call ${SKILL_PRODUCT_STATE_GET_TOOL} with namespace "thesis-tracker" and key "theses". Save the complete structured thesis list with ${SKILL_PRODUCT_STATE_SET_TOOL}; pass the revision just read as expected_revision. Never claim data was saved until the write tool succeeds.`;

test("App Agent 传入 JSON 字符串页面时会编译成真正的 Skill Product 页面", () => {
  const content = buildSkillProductContent({
    bindingId: "binding-json-pages",
    moduleKey: "json-pages-product",
    name: "观点跟踪",
    sidebar: JSON.stringify({ visible: true, group: "research", order: 3 }),
    navigation: JSON.stringify([
      { page: "dashboard", label: "仪表盘" },
      { page: "agent", label: "对话" },
    ]),
    pages: JSON.stringify({
      dashboard: {
        type: "Stack",
        children: [
          { type: "Markdown", content: "跟踪观点与反证" },
          { type: "MetricCard", title: "跟踪论点", value: 0 },
        ],
      },
      agent: { type: "AgentWorkspace" },
    }),
    skill: {
      name: "thesis-tracker",
      description: "跟踪投资观点",
      allowed_tools: [SKILL_PRODUCT_STATE_GET_TOOL, SKILL_PRODUCT_STATE_SET_TOOL],
    },
  });
  assert.equal(content.manifest.entryPage, "dashboard");
  assert.equal(content.manifest.sidebar.group, "research");
  assert.equal(content.pages.dashboard.layout.type, "Stack");
  assert.equal(content.pages.dashboard.layout.children[0].text, "跟踪观点与反证");
  assert.equal(content.pages.dashboard.layout.children[1].label, "跟踪论点");
  assert.equal(content.pages.agent.layout.bindingId, "binding-json-pages");
  assert.equal(content.pages.dashboard.onLoad.action, "load_product_data");
  assert.deepEqual(content.actions.load_product_data, {
    type: "state.get",
    namespace: "thesis-tracker",
    key: "product_data",
    permission: "storage:json-pages-product",
  });
});

function thesisTrackerPages() {
  const example = [{
    ticker: "ACME",
    position: "Long",
    thesis: "Pricing power and operating leverage can expand margins.",
    conviction: "Medium",
    review_date: "2026-10-01",
    pillars: [
      { pillar: "Revenue growth", expectation: ">20%", status: "On track", trend: "Stable" },
      { pillar: "Margin expansion", expectation: "+300bps", status: "Behind", trend: "Concerning" },
    ],
    catalysts: [{ date: "2026-08-01", event: "Quarterly earnings", impact: "High", notes: "Check margin guidance" }],
    updates: [{ date: "2026-07-22", evidence: "Baseline created", impact: "Neutral", action: "No change" }],
  }];
  const refresh = { type: "Button", label: "刷新产品数据", onClick: { action: "load_theses", target: "theses" } };
  return {
    overview: {
      id: "overview",
      title: "观点总览",
      onLoad: { action: "load_theses", target: "theses" },
      mockData: { theses: { value: example } },
      layout: {
        type: "Stack",
        gap: "lg",
        children: [
          { type: "Toolbar", children: [{ type: "Heading", level: 1, text: "投资观点跟踪" }, refresh] },
          {
            type: "Grid",
            columns: 3,
            children: [
              { type: "MetricCard", label: "覆盖标的", source: "$data.theses.value.length" },
              { type: "MetricCard", label: "当前流程", value: "持续复核" },
              { type: "MetricCard", label: "证据原则", value: "正反同权" },
            ],
          },
          {
            type: "DataTable",
            source: "$data.theses.value",
            emptyText: "还没有投资观点，请到研究工作台创建。",
            columns: [
              { key: "ticker", label: "标的" },
              { key: "position", label: "方向" },
              { key: "thesis", label: "核心观点" },
              { key: "conviction", label: "信心" },
              { key: "review_date", label: "下次复核" },
            ],
          },
        ],
      },
    },
    scorecard: {
      id: "scorecard",
      title: "论点记分卡",
      onLoad: { action: "load_theses", target: "theses" },
      mockData: { theses: { value: example } },
      layout: {
        type: "Stack",
        children: [
          { type: "Heading", level: 1, text: "论点记分卡" },
          { type: "Text", text: "逐项检查原始预期、当前状态和趋势。" },
          {
            type: "DataTable",
            source: "$data.theses.value.0.pillars",
            columns: [
              { key: "pillar", label: "论点" },
              { key: "expectation", label: "原始预期" },
              { key: "status", label: "当前状态" },
              { key: "trend", label: "趋势" },
            ],
          },
        ],
      },
    },
    catalysts: {
      id: "catalysts",
      title: "催化剂日历",
      onLoad: { action: "load_theses", target: "theses" },
      mockData: { theses: { value: example } },
      layout: {
        type: "Stack",
        children: [
          { type: "Heading", level: 1, text: "催化剂日历" },
          {
            type: "DataTable",
            source: "$data.theses.value.0.catalysts",
            columns: [
              { key: "date", label: "日期" },
              { key: "event", label: "事件" },
              { key: "impact", label: "预期影响" },
              { key: "notes", label: "检查重点" },
            ],
          },
        ],
      },
    },
    updates: {
      id: "updates",
      title: "证据更新",
      onLoad: { action: "load_theses", target: "theses" },
      mockData: { theses: { value: example } },
      layout: {
        type: "Stack",
        children: [
          { type: "Heading", level: 1, text: "证据更新" },
          { type: "Badge", text: "同时记录支持与反对证据" },
          {
            type: "DataTable",
            source: "$data.theses.value.0.updates",
            columns: [
              { key: "date", label: "日期" },
              { key: "evidence", label: "新证据" },
              { key: "impact", label: "影响" },
              { key: "action", label: "动作" },
            ],
          },
        ],
      },
    },
  };
}

test("公开 thesis-tracker Skill 可以固化成有共享数据后端的完整产品", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-external-thesis-tracker-"));
  process.env.DB_SQLITE_PATH = join(dir, "external-thesis-tracker.db");
  const db = await import(`../../db.js?external-thesis-tracker-test=${Date.now()}`);
  const userId = "user-external-thesis-tracker";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await createAppSkill(ctx, {
      name: "anthropic-thesis-tracker",
      description: "维护并持续更新持仓与观察名单的投资观点、论点、风险、证据和催化剂。",
      category: "research",
      tags: ["equity-research", "thesis", "external-skill"],
      instructions: ANTHROPIC_THESIS_TRACKER_INSTRUCTIONS,
      allowed_tools: [SKILL_PRODUCT_STATE_GET_TOOL, SKILL_PRODUCT_STATE_SET_TOOL],
      runtime: "prompt",
      side_effect: "write",
    }, userId);

    const moduleKey = "anthropic-thesis-tracker";
    const storagePermission = `storage:${moduleKey}`;
    const draft = await createSkillProductDraft(ctx, {
      skill_name: "anthropic-thesis-tracker",
      module_key: moduleKey,
      name: "投资观点跟踪器",
      description: "把投资逻辑、反证、催化剂和复核动作放进同一个持续更新的产品。",
      icon: "chart-candlestick",
      request_text: `测试公开 Skill: ${ANTHROPIC_THESIS_TRACKER_SOURCE}`,
      pages: thesisTrackerPages(),
      navigation: [
        { page: "overview", label: "观点总览" },
        { page: "scorecard", label: "论点记分卡" },
        { page: "catalysts", label: "催化剂日历" },
        { page: "updates", label: "证据更新" },
      ],
      actions: {
        load_theses: {
          type: "state.get",
          namespace: "thesis-tracker",
          key: "theses",
          permission: storagePermission,
        },
      },
    });
    assert.equal(draft.content.manifest.navigation.length, 5);
    assert.deepEqual(Object.keys(draft.content.pages), ["overview", "scorecard", "catalysts", "updates", "workspace"]);
    assert.deepEqual(draft.skill_product.allowed_tools, [SKILL_PRODUCT_STATE_GET_TOOL, SKILL_PRODUCT_STATE_SET_TOOL]);
    assert.equal(draft.skill_product.execution_mode, "interactive");
    assert.equal(draft.skill_product.automatic_safe, false);

    const checked = await validateDraft(ctx, draft.id, { expected_revision: draft.revision });
    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
    assert.ok(checked.new_permissions.includes(storagePermission));
    const preview = await previewDraft(ctx, draft.id, {
      expected_revision: draft.revision,
      validation_hash: checked.validation_hash,
    });
    const installed = await installDraft(ctx, draft.id, {
      expected_revision: draft.revision,
      validation_hash: preview.validation_hash,
      preview_token: preview.preview_token,
      permission_decisions: Object.fromEntries(checked.new_permissions.map((permission) => [permission, true])),
    });

    await ctx.query(
      `INSERT INTO sessions
         (id,project_id,created_by,title,source_type,source_id,action_type,status,message_count,created_at,updated_at)
       VALUES ($1,'__chat__',$2,'观点跟踪会话一','agent','__chat__','skill_product','active',0,now(),now())`,
      ["thesis-product-session-1", userId],
    );
    const firstRuntime = await resolveInstalledSkillProduct(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      bindingId: installed.skill_product.id,
      sessionId: "thesis-product-session-1",
      projectId: "__chat__",
    });
    assert.match(firstRuntime.skill.instructions, /falsifiable/);
    assert.equal(firstRuntime.product.module_key, moduleKey);

    const theses = [{
      ticker: "ACME",
      position: "Long",
      thesis: "Margin expansion depends on pricing power and operating leverage.",
      conviction: "Medium",
      review_date: "2026-10-01",
      pillars: [{ pillar: "Margin expansion", expectation: "+300bps", status: "On track", trend: "Improving" }],
      catalysts: [{ date: "2026-08-01", event: "Quarterly earnings", impact: "High", notes: "Check guidance" }],
      updates: [{ date: "2026-07-22", evidence: "Baseline created", impact: "Neutral", action: "No change" }],
    }];
    const saved = await setSkillProductState(ctx, firstRuntime.product, {
      namespace: "thesis-tracker",
      key: "theses",
      value: theses,
      expected_revision: 0,
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.event, "state.changed");
    const stateSnapshot = await getModuleState(ctx, installed.id, { version_id: installed.version.id });
    assert.deepEqual(stateSnapshot.state["thesis-tracker"].theses, theses);
    assert.equal(stateSnapshot.items[0].revision, 1);
    assert.ok(stateSnapshot.event_cursor?.id);
    const readBack = await getSkillProductState(ctx, firstRuntime.product, {
      namespace: "thesis-tracker",
      key: "theses",
    });
    assert.deepEqual(readBack.value, theses);
    assert.equal(readBack.revision, 1);
    await assert.rejects(() => getSkillProductState(ctx, {
      ...firstRuntime.product,
      session_id: "another-product-session",
    }, {
      namespace: "thesis-tracker",
      key: "theses",
    }), /没有当前版本的数据访问权限/);
    await assert.rejects(() => setSkillProductState(ctx, firstRuntime.product, {
      namespace: "thesis-tracker",
      key: "theses",
      value: [],
      expected_revision: 0,
    }), /产品数据已变化/);

    const pageLoad = await runModuleAction(ctx, installed.id, "load_theses", {
      version_id: installed.version.id,
      request_id: "load-theses-after-agent-write",
      input: {},
    });
    assert.deepEqual(pageLoad.data.value, theses);

    await ctx.query(
      `INSERT INTO sessions
         (id,project_id,created_by,title,source_type,source_id,action_type,status,message_count,created_at,updated_at)
       VALUES ($1,'__chat__',$2,'观点跟踪会话二','agent','__chat__','skill_product','active',0,now(),now())`,
      ["thesis-product-session-2", userId],
    );
    const secondRuntime = await resolveInstalledSkillProduct(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      bindingId: installed.skill_product.id,
      sessionId: "thesis-product-session-2",
      projectId: "__chat__",
    });
    const crossSession = await getSkillProductState(ctx, secondRuntime.product, {
      namespace: "thesis-tracker",
      key: "theses",
    });
    assert.deepEqual(crossSession.value, theses);
    assert.equal((await getModule(ctx, installed.id)).skill_product_sessions.length, 2);
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill 可以固化成多页面产品，并使用安装时的不可变快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-skill-product-"));
  process.env.DB_SQLITE_PATH = join(dir, "skill-product.db");
  const db = await import(`../../db.js?skill-product-test=${Date.now()}`);
  const userId = "user-skill-product";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await createAppSkill(ctx, {
      name: "company_research",
      description: "研究一家公司",
      instructions: "读取公开信息并给出结构化研究结论。",
      allowed_tools: ["project_list"],
      side_effect: "read",
    }, userId);

    const draft = await createSkillProductDraft(ctx, {
      skill_name: "company_research",
      module_key: "company-research-product",
      name: "公司研究",
      blueprint: {
        product: { name: "公司研究", jobs: ["分析一家公司并形成研究结论"] },
        domain: { entities: ["Company", "ResearchReport"] },
        commands: [{
          name: "company.analyze",
          title: "开始公司研究",
          action: "analyze_company",
          inputSchema: {
            type: "object",
            required: ["company"],
            properties: { company: { type: "string" } },
            additionalProperties: false,
          },
          handler: { type: "agent.intent", intent: "研究指定公司并形成结构化结论" },
        }],
        surfaces: [{ id: "dashboard", title: "研究看板", commands: ["company.analyze"] }],
        acceptanceTests: ["输入公司名称后能够启动专属 Agent 研究"],
      },
      navigation: [{ page: "dashboard", label: "研究看板" }],
      pages: {
        dashboard: {
          id: "dashboard",
          title: "研究看板",
          layout: { type: "Grid", children: [{ type: "MetricCard", label: "覆盖公司", value: 0 }] },
        },
      },
    });
    assert.equal(draft.skill_product.skill_name, "company_research");
    assert.equal(draft.blueprint.commands[0].name, "company.analyze");
    assert.equal(draft.miniapp_package.packageVersion, 1);
    assert.equal(draft.content.actions.analyze_company.type, "agent.intent");
    assert.ok(Object.values(draft.content.pages).some((page) => page.layout?.type === "AgentWorkspace"));
    assert.ok(draft.content.manifest.navigation.length >= 2);

    const checked = await validateDraft(ctx, draft.id, { expected_revision: draft.revision });
    assert.equal(checked.valid, true);
    const preview = await previewDraft(ctx, draft.id, {
      expected_revision: draft.revision,
      validation_hash: checked.validation_hash,
    });
    const permission = `skill-product:${draft.module_key}:run`;
    const installed = await installDraft(ctx, draft.id, {
      expected_revision: draft.revision,
      validation_hash: preview.validation_hash,
      preview_token: preview.preview_token,
      permission_decisions: { [permission]: true },
    });
    assert.equal(installed.skill_product.skill_name, "company_research");
    assert.equal(installed.version.runtime_version, "1");
    assert.equal(installed.version.miniapp_package.commands[0].name, "company.analyze");

    const commandAction = await runModuleAction(ctx, installed.id, "analyze_company", {
      request_id: "company-analyze-command",
      version_id: installed.version.id,
      input: { company: "ACME" },
    });
    assert.deepEqual(commandAction.data, {
      kind: "agent.intent",
      action_name: "analyze_company",
      command: "company.analyze",
      title: "开始公司研究",
      input: { company: "ACME" },
      binding_id: installed.skill_product.id,
      project_id: null,
    });
    const resolvedCommand = await resolveMiniAppAgentCommand(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      actionName: "analyze_company",
      requestId: "company-analyze-command",
      input: { company: "ACME" },
    });
    assert.match(resolvedCommand.agent_message, /结构化输入：\{"company":"ACME"\}/);
    await assert.rejects(() => resolveMiniAppAgentCommand(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      actionName: "analyze_company",
      requestId: "company-analyze-command",
      input: { ticker: "ACME" },
    }), /输入与动作记录不一致/);

    await ctx.query(
      `INSERT INTO sessions
         (id,project_id,created_by,title,source_type,source_id,action_type,status,message_count,created_at,updated_at)
       VALUES ($1,'__chat__',$2,'普通会话','agent','__chat__','agentic_chat','active',0,now(),now())`,
      ["ordinary-agent-session", userId],
    );
    await assert.rejects(() => resolveInstalledSkillProduct(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      bindingId: installed.skill_product.id,
      sessionId: "ordinary-agent-session",
      projectId: "__chat__",
    }), /会话不存在或不属于当前用户/);

    await ctx.query(
      `INSERT INTO sessions
         (id,project_id,created_by,title,source_type,source_id,action_type,status,message_count,created_at,updated_at)
       VALUES ($1,'__chat__',$2,'产品会话','agent','__chat__','skill_product','active',0,now(),now())`,
      ["skill-product-session", userId],
    );
    const runtime = await resolveInstalledSkillProduct(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      bindingId: installed.skill_product.id,
      sessionId: "skill-product-session",
      projectId: "__chat__",
    });
    assert.match(runtime.skill.instructions, /结构化研究结论/);
    const detailWithSession = await getModule(ctx, installed.id);
    assert.deepEqual(detailWithSession.skill_product_sessions.map((item) => item.id), ["skill-product-session"]);

    await updateAppSkill(ctx, "company_research", {
      instructions: "这是更新后的另一套逻辑。",
    }, userId);
    const afterUpdate = await resolveInstalledSkillProduct(ctx, {
      moduleId: installed.id,
      versionId: installed.version.id,
      bindingId: installed.skill_product.id,
      sessionId: "skill-product-session",
      projectId: "__chat__",
    });
    assert.match(afterUpdate.skill.instructions, /结构化研究结论/);
    assert.doesNotMatch(afterUpdate.skill.instructions, /更新后的另一套逻辑/);
    assert.equal((await getModule(ctx, installed.id)).skill_bindings.length, 1);
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("写入型 Skill 可以固化，但会保留交互确认模式而不是自动放权", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-skill-product-unsafe-"));
  process.env.DB_SQLITE_PATH = join(dir, "skill-product-unsafe.db");
  const db = await import(`../../db.js?skill-product-unsafe-test=${Date.now()}`);
  const userId = "user-skill-product-unsafe";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await createAppSkill(ctx, {
      name: "script_writer",
      description: "写脚本",
      instructions: "生成并执行脚本。",
      allowed_tools: ["bash"],
      side_effect: "execute",
    }, userId);
    const draft = await createSkillProductDraft(ctx, {
      skill_name: "script_writer",
      module_key: "script-writer-product",
      name: "脚本产品",
    });
    assert.equal(draft.skill_product.execution_mode, "interactive");
    assert.equal(draft.skill_product.automatic_safe, false);
    assert.deepEqual(draft.skill_product.allowed_tools, ["bash"]);
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内置 Service Skill 通过已有后端 handler 固化为产品", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-service-skill-product-"));
  process.env.DB_SQLITE_PATH = join(dir, "service-skill-product.db");
  const db = await import(`../../db.js?service-skill-product-test=${Date.now()}`);
  const userId = "user-service-skill-product";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await assert.rejects(() => createSkillProductDraft(ctx, {
      skill_name: "smart_query",
      project_id: "project-service-skill",
      module_key: "smart-query-product",
      name: "项目数据分析",
    }), /项目不存在或无权限/);
    await ctx.query(
      `INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now())`,
      ["project-service-skill", "Service Skill 项目"],
    );
    await ctx.query(
      `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,1,now(),now())`,
      ["member-service-skill", "project-service-skill", userId],
    );
    const draft = await createSkillProductDraft(ctx, {
      skill_name: "smart_query",
      project_id: "project-service-skill",
      module_key: "smart-query-product",
      name: "项目数据分析",
    });
    assert.equal(draft.skill_product.source_runtime, "service");
    assert.deepEqual(draft.skill_product.allowed_tools, ["query_project_data"]);
    assert.equal(draft.skill_product.automatic_safe, true);
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill Product 草稿不能移除 manifest 绑定后伪装成普通模块安装", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-skill-product-binding-"));
  process.env.DB_SQLITE_PATH = join(dir, "skill-product-binding.db");
  const db = await import(`../../db.js?skill-product-binding-test=${Date.now()}`);
  const userId = "user-skill-product-binding";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await createAppSkill(ctx, {
      name: "binding_guard_skill",
      description: "检查绑定",
      instructions: "只执行绑定 Skill。",
      allowed_tools: ["project_list"],
      side_effect: "read",
    }, userId);
    const draft = await createSkillProductDraft(ctx, {
      skill_name: "binding_guard_skill",
      module_key: "binding-guard-product",
    });
    const replaced = await replaceDraft(ctx, draft.id, {
      expected_revision: draft.revision,
      content: {
        manifest: { ...draft.content.manifest, product: null, permissions: [] },
        pages: {
          overview: {
            id: "overview",
            layout: { type: "Stack", children: [{ type: "Text", text: "普通模块" }] },
          },
        },
        actions: {},
      },
    });
    const checked = await validateDraft(ctx, draft.id, { expected_revision: replaced.revision });
    assert.equal(checked.valid, false);
    assert.ok(checked.errors.some((item) => item.code === "SKILL_PRODUCT_MANIFEST_REQUIRED"));
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Workflow Skill 使用固化 workflow 适配器，不能由请求方扩张未声明工具", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-workflow-skill-product-"));
  process.env.DB_SQLITE_PATH = join(dir, "workflow-skill-product.db");
  const db = await import(`../../db.js?workflow-skill-product-test=${Date.now()}`);
  const userId = "user-workflow-skill-product";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await ctx.query(
      `INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now())`,
      ["project-workflow-skill", "Workflow Skill 项目"],
    );
    await ctx.query(
      `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,1,now(),now())`,
      ["member-workflow-skill", "project-workflow-skill", userId],
    );
    const workflowDraft = await createSkillProductDraft(ctx, {
      skill_name: "trace_tuning_proposer",
      project_id: "project-workflow-skill",
      module_key: "trace-tuning-product",
    });
    assert.equal(workflowDraft.skill_product.source_runtime, "workflow");
    assert.deepEqual(workflowDraft.skill_product.allowed_tools, ["run_skill_workflow"]);

    await createAppSkill(ctx, {
      name: "no_tool_boundary",
      description: "未声明工具",
      instructions: "不要自动扩大工具范围。",
      allowed_tools: [],
      side_effect: "read",
    }, userId);
    await assert.rejects(() => createSkillProductDraft(ctx, {
      skill_name: "no_tool_boundary",
      module_key: "no-tool-boundary-product",
      allowed_tools: ["project_list"],
    }), /不能超出 Skill 声明范围/);
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Skill Product 幂等创建在并发重试时返回同一草稿，并拒绝换用另一请求", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-skill-product-idempotency-"));
  process.env.DB_SQLITE_PATH = join(dir, "skill-product-idempotency.db");
  const db = await import(`../../db.js?skill-product-idempotency-test=${Date.now()}`);
  const userId = "user-skill-product-idempotency";
  const ctx = { userId, query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    await createAppSkill(ctx, {
      name: "idempotent_skill",
      description: "幂等创建",
      instructions: "保持同一个产品草稿。",
      allowed_tools: ["project_list"],
      side_effect: "read",
    }, userId);
    const request = {
      skill_name: "idempotent_skill",
      module_key: "idempotent-product",
      idempotency_key: "same-request",
    };
    const [first, second] = await Promise.all([
      createSkillProductDraft(ctx, request),
      createSkillProductDraft(ctx, request),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(first.skill_product.id, second.skill_product.id);

    await assert.rejects(() => createSkillProductDraft(ctx, {
      ...request,
      module_key: "different-product",
    }), /幂等键已经被另一个 Skill Product 请求使用/);
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
