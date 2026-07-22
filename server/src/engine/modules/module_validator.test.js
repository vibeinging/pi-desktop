import test from "node:test";
import assert from "node:assert/strict";

import { appVersionSupports, nextPatchVersion, validateModuleContent } from "./module_validator.js";

function stockContent(overrides = {}) {
  return {
    manifest: {
      schemaVersion: 1,
      id: "stock-center",
      name: "股票",
      version: "1.0.0",
      entryPage: "home",
      permissions: ["storage:stock-center"],
    },
    pages: {
      home: {
        id: "home",
        layout: {
          type: "Stack",
          children: [
            { type: "Heading", text: "股票" },
            { type: "DataTable", source: "watchlist" },
            { type: "Button", label: "保存", onClick: { action: "saveWatchlist" } },
          ],
        },
      },
    },
    actions: {
      saveWatchlist: { type: "state.set", permission: "storage:stock-center", key: "watchlist", value: "$input.value" },
    },
    ...overrides,
  };
}

test("动态 UI 模块允许固定组件和已声明动作", () => {
  const result = validateModuleContent(stockContent());
  assert.equal(result.valid, true);
  assert.equal(result.stats.nodes, 4);
  assert.deepEqual(result.requested_permissions, ["storage:stock-center"]);
});

test("动态 UI 模块拒绝未知组件和任意脚本字段", () => {
  const content = stockContent();
  content.pages.home.layout.children.push({ type: "RemoteReact", script: "alert(1)" });
  const result = validateModuleContent(content);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "UNKNOWN_COMPONENT"));
  assert.ok(result.errors.some((item) => item.code === "FORBIDDEN_PAGE_FIELD"));
});

test("动态 UI 模块拒绝没有声明权限的动作", () => {
  const content = stockContent();
  content.manifest.permissions = [];
  const result = validateModuleContent(content);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "ACTION_PERMISSION_MISSING"));
});

test("模块版本默认递增补丁号", () => {
  assert.equal(nextPatchVersion("1.2.9"), "1.2.10");
  assert.equal(nextPatchVersion("bad"), "1.0.0");
});

test("草稿模块名不能和页面定义中的模块名不一致", () => {
  const result = validateModuleContent(stockContent(), { module_key: "another-module" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "MODULE_KEY_MISMATCH"));
});

test("模块最低 App 版本必须兼容当前版本", () => {
  const content = stockContent();
  content.manifest.minAppVersion = "2.0.0";
  const result = validateModuleContent(content, { current_app_version: "1.9.9" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "APP_VERSION_INCOMPATIBLE"));
  assert.equal(appVersionSupports("1.2.0", "1.2.0"), true);
  assert.equal(appVersionSupports("1.2.0", "1.1.9"), false);
});

test("Provider 动作拒绝越界超时", () => {
  const content = stockContent();
  content.manifest.permissions = ["provider:market-data:read"];
  content.actions = {
    loadQuotes: {
      type: "provider.call",
      permission: "provider:market-data:read",
      provider: "market-data",
      tool: "get_quotes",
      timeout_ms: 120_000,
    },
  };
  content.pages.home.layout.children[2].onClick.action = "loadQuotes";
  const result = validateModuleContent(content);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === "INVALID_PROVIDER_TIMEOUT"));
});

test("Skill Product 支持多页面导航和专属 Agent 工作台", () => {
  const result = validateModuleContent({
    manifest: {
      schemaVersion: 1,
      id: "research-product",
      name: "研究产品",
      version: "1.0.0",
      entryPage: "dashboard",
      navigation: [{ page: "dashboard", label: "看板" }, { page: "workspace", label: "工作台" }],
      product: { type: "skill-product", bindingId: "binding-1", skillName: "research" },
      permissions: ["skill-product:research-product:run"],
    },
    pages: {
      dashboard: { layout: { type: "Card", children: [{ type: "Badge", text: "运行中" }] } },
      workspace: { layout: { type: "AgentWorkspace", bindingId: "binding-1" } },
    },
    actions: {},
  });
  assert.equal(result.valid, true);
  assert.equal(result.normalized.manifest.navigation.length, 2);
  assert.equal(result.normalized.manifest.product.bindingId, "binding-1");
});
