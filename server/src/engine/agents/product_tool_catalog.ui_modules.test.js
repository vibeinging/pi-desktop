import test from "node:test";
import assert from "node:assert/strict";

import { PRODUCT_CONFIRM_TOOL_NAMES, PRODUCT_TOOL_NAMES } from "./product_tool_catalog.js";

test("模块安装、停用和退回必须经过现有确认治理", () => {
  assert.equal(PRODUCT_TOOL_NAMES.has("skill_registry_search"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("skill_download"), true);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("skill_registry_search"), false);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("skill_download"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("ui_module_draft_create"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("ui_skill_product_draft_create"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("miniapp_agent_export_draft"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("miniapp_agent_export_publish"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("miniapp_list"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("miniapp_use"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("miniapp_open"), true);
  assert.equal(PRODUCT_TOOL_NAMES.has("ui_module_draft_preview"), true);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("ui_module_draft_create"), false);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("ui_skill_product_draft_create"), false);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("miniapp_agent_export_draft"), false);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("miniapp_agent_export_publish"), true);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("miniapp_use"), true);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("ui_module_draft_install"), true);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("ui_module_toggle"), true);
  assert.equal(PRODUCT_CONFIRM_TOOL_NAMES.has("ui_module_rollback"), true);
});
