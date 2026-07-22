import test from "node:test";
import assert from "node:assert/strict";

import {
  assertMiniAppCommandInput,
  assertMiniAppStateValue,
  buildMiniAppPackage,
  compileBlueprintAgentActions,
  compileBlueprintPages,
  normalizeRequirementBundle,
  normalizeProductBlueprint,
  validateMiniAppPackage,
} from "./miniapp_compiler.js";

function blueprint() {
  return normalizeProductBlueprint({
    product: { name: "观点跟踪", jobs: ["持续跟踪投资观点"] },
    commands: [{
      name: "thesis.create",
      title: "创建观点",
      action: "create_thesis",
      inputSchema: {
        type: "object",
        required: ["ticker"],
        properties: { ticker: { type: "string" } },
        additionalProperties: false,
      },
      handler: { type: "agent.intent", intent: "为指定股票创建可证伪的投资观点" },
    }],
    surfaces: [
      { id: "overview", title: "观点总览", description: "查看当前观点" },
      { id: "workspace", title: "研究工作台", kind: "workspace" },
    ],
    stateSchema: {
      version: 1,
      additionalNamespaces: false,
      namespaces: {
        thesis: {
          additionalKeys: false,
          keys: { items: { type: "array", items: { type: "object" } } },
        },
      },
    },
    acceptanceTests: ["可以创建投资观点"],
  }, { moduleKey: "thesis-tracker" });
}

test("Product Blueprint 会确定性编译页面、Agent 命令和完整包", () => {
  const value = blueprint();
  const actions = compileBlueprintAgentActions(value, { productPermission: "skill-product:thesis-tracker:run" });
  const pages = compileBlueprintPages(value, { bindingId: "binding-1" });
  const content = {
    manifest: { id: "thesis-tracker", version: "1.0.0" },
    pages,
    actions,
  };
  const pkg = buildMiniAppPackage({
    blueprint: value,
    content,
    bindingId: "binding-1",
    skillSnapshot: { name: "thesis-tracker", source_runtime: "prompt", allowed_tools: ["project_list"] },
    skillFingerprint: "sha256:skill",
  });
  assert.equal(actions.create_thesis.type, "agent.intent");
  assert.equal(pages.workspace.layout.type, "AgentWorkspace");
  assert.equal(pkg.packageVersion, 1);
  assert.deepEqual(pkg.capabilities.requested, ["yiw.agent.invoke"]);
  assert.equal(pkg.tests.length, 1);
  assert.equal(validateMiniAppPackage(pkg, { content, blueprint: value }).valid, true);
  const changed = structuredClone(pkg);
  changed.commands[0].title = "被修改";
  assert.equal(validateMiniAppPackage(changed, { content, blueprint: value }).valid, false);
});

test("MiniApp 命令输入和产品状态按声明结构检查", () => {
  const value = blueprint();
  const schema = value.commands[0].inputSchema;
  assert.doesNotThrow(() => assertMiniAppCommandInput({ ticker: "AAPL" }, schema));
  assert.throws(() => assertMiniAppCommandInput({ code: "AAPL" }, schema), /ticker 为必填项/);
  assert.doesNotThrow(() => assertMiniAppStateValue(value.stateSchema, {
    namespace: "thesis",
    key: "items",
    value: [{ ticker: "AAPL" }],
  }));
  assert.throws(() => assertMiniAppStateValue(value.stateSchema, {
    namespace: "thesis",
    key: "unknown",
    value: [],
  }), /未在 state schema 中声明/);
});

test("普通小程序可以带 Skill 需求模板，但不生成 Agent 绑定", () => {
  const value = normalizeProductBlueprint({
    product: { name: "股票复盘", description: "记录每日复盘" },
    surfaces: [{ id: "home", title: "复盘首页" }],
    acceptanceTests: ["可以查看复盘首页"],
  }, { moduleKey: "stock-review" });
  const content = {
    manifest: { id: "stock-review", version: "1.0.0" },
    pages: { home: { id: "home", title: "复盘首页", layout: { type: "Stack", children: [] } } },
    actions: {},
  };
  const requirements = normalizeRequirementBundle({
    goal: "做一个股票复盘小程序",
    sources: [{
      type: "skill",
      ref: "thesis-tracker",
      fingerprint: "sha256:template",
      snapshot: { description: "观点跟踪模板", instructions: "记录观点与反证" },
    }],
  });
  const pkg = buildMiniAppPackage({ blueprint: value, content, requirements });
  assert.equal(pkg.agentExposure, "none");
  assert.equal("agent" in pkg, false);
  assert.equal("skill" in pkg, false);
  assert.equal(pkg.requirements.sources[0].type, "skill");
  assert.equal(validateMiniAppPackage(pkg, { content, blueprint: value }).valid, true);
});
