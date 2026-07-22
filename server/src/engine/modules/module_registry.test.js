import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activateVersion,
  createMiniAppSkillExportDraft,
  createDraft,
  getModule,
  installDraft,
  listMiniAppAgentSkills,
  listModules,
  openMiniApp,
  listVersions,
  previewDraft,
  runModuleAction,
  publishMiniAppSkillExport,
  setModuleStatus,
  useMiniAppAgentSkill,
  validateDraft,
  validateMiniAppSkillExport,
} from "./module_registry.js";

function content(version, label, { withStorage = true } = {}) {
  return {
    manifest: {
      schemaVersion: 1,
      id: "stock-center",
      name: "股票",
      description: label,
      icon: "chart-candlestick",
      version,
      sidebar: { visible: true, group: "personal", order: 20 },
      entryPage: "home",
      permissions: withStorage ? ["storage:stock-center"] : [],
    },
    pages: {
      home: {
        id: "home",
        data: { watchlist: [{ code: "000001", price: 12.3 }] },
        layout: { type: "Stack", children: [{ type: "DataTable", source: "watchlist" }] },
      },
    },
    actions: withStorage ? {
      saveWatchlist: {
        type: "state.set",
        permission: "storage:stock-center",
        namespace: "stock",
        key: "watchlist",
        value: "$input.value",
      },
    } : {},
  };
}

test("模块草稿可以安装、执行受控动作、停用并退回旧版本", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-ui-module-"));
  process.env.DB_SQLITE_PATH = join(dir, "module-test.db");
  const db = await import(`../../db.js?ui-module-test=${Date.now()}`);
  const ctx = { userId: "user-module-test", query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  try {
    const draft1 = await createDraft(ctx, {
      module_key: "stock-center",
      name: "股票",
      content: content("1.0.0", "第一版"),
      requirements: {
        goal: "做一个股票自选小程序",
        sources: [{
          type: "skill",
          ref: "watchlist-template",
          fingerprint: "sha256:requirement-template",
          snapshot: { description: "自选股需求模板", instructions: "保存并查看自选股" },
        }],
        acceptanceCriteria: ["可以保存自选股"],
      },
      blueprint: {
        product: { name: "股票", description: "自选股管理" },
        surfaces: [{ id: "home", title: "自选股" }],
        acceptanceTests: ["可以保存自选股"],
      },
      idempotency_key: "stock-draft-v1",
    });
    assert.equal(draft1.miniapp_package.agentExposure, "none");
    assert.equal(draft1.miniapp_package.agent, undefined);
    assert.equal(draft1.requirements.sources[0].ref, "watchlist-template");
    const checked1 = await validateDraft(ctx, draft1.id, { expected_revision: draft1.revision });
    assert.equal(checked1.valid, true);
    await assert.rejects(() => installDraft(ctx, draft1.id, {
      expected_revision: draft1.revision,
      validation_hash: checked1.validation_hash,
      permission_decisions: { "storage:stock-center": true },
    }), /必须先预览/);
    const preview1 = await previewDraft(ctx, draft1.id, {
      expected_revision: draft1.revision,
      validation_hash: checked1.validation_hash,
    });
    const installed1 = await installDraft(ctx, draft1.id, {
      expected_revision: draft1.revision,
      validation_hash: preview1.validation_hash,
      preview_token: preview1.preview_token,
      permission_decisions: { "storage:stock-center": true },
    });
    assert.equal(installed1.status, "active");
    assert.equal(installed1.agent_exposure, "none");
    assert.equal(installed1.version.requirements.sources[0].type, "skill");
    assert.equal(installed1.skill_product, null);
    const exportDraft = await createMiniAppSkillExportDraft(ctx, installed1.id, {
      skill_name: "stock-watchlist-agent",
      description: "让主 Agent 保存用户确认过的自选股",
      commands: [{
        action: "saveWatchlist",
        name: "watchlist.save",
        input_schema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
        open_page: "home",
      }],
    });
    assert.equal(exportDraft.status, "draft");
    assert.equal(exportDraft.contract.commands[0].confirmation, "required");
    const exportCheck = await validateMiniAppSkillExport(ctx, exportDraft.id);
    assert.equal(exportCheck.valid, true);
    const publishedExport = await publishMiniAppSkillExport(ctx, exportDraft.id, {
      validation_hash: exportCheck.validation_hash,
    });
    assert.equal(publishedExport.status, "published");
    assert.equal((await getModule(ctx, installed1.id)).agent_exposure, "published");
    assert.equal((await listMiniAppAgentSkills(ctx)).items[0].callable, true);
    const agentRun = await useMiniAppAgentSkill(ctx, {
      export_id: publishedExport.id,
      command: "watchlist.save",
      request_id: "agent-watchlist-save-1",
      input: { value: ["000001"] },
    });
    assert.equal(agentRun.status, "completed");
    assert.equal(agentRun.handoff.page_id, "home");
    assert.deepEqual(await openMiniApp(ctx, installed1.id, {
      page_id: "home",
      invocation_id: agentRun.invocation_id,
    }), {
      module_id: installed1.id,
      module_key: "stock-center",
      page_id: "home",
      invocation_id: agentRun.invocation_id,
    });
    const agentReplay = await useMiniAppAgentSkill(ctx, {
      export_id: publishedExport.id,
      command: "watchlist.save",
      request_id: "agent-watchlist-save-1",
      input: { value: ["000001"] },
    });
    assert.equal(agentReplay.idempotent_replay, true);
    assert.equal(agentReplay.handoff.page_id, "home");
    await assert.rejects(() => useMiniAppAgentSkill(ctx, {
      export_id: publishedExport.id,
      command: "watchlist.save",
      request_id: "agent-watchlist-save-1",
      input: { value: ["600000"] },
    }), /不同的小程序命令输入/);
    assert.equal((await listModules(ctx)).items.length, 1);

    const action = await runModuleAction(ctx, installed1.id, "saveWatchlist", {
      request_id: "save-watchlist-1",
      version_id: installed1.version.id,
      input: { value: ["000001", "600000"] },
    });
    assert.deepEqual(action.data, { key: "watchlist", namespace: "stock", value: ["000001", "600000"], revision: 2 });
    const replay = await runModuleAction(ctx, installed1.id, "saveWatchlist", {
      request_id: "save-watchlist-1",
      version_id: installed1.version.id,
      input: { value: ["ignored"] },
    });
    assert.equal(replay.idempotent_replay, true);
    assert.deepEqual(replay.data, action.data);

    const large = await runModuleAction(ctx, installed1.id, "saveWatchlist", {
      request_id: "save-watchlist-large",
      version_id: installed1.version.id,
      input: { value: "x".repeat(30_000) },
    });
    assert.equal(large.data.truncated, true);
    const largeReplay = await runModuleAction(ctx, installed1.id, "saveWatchlist", {
      request_id: "save-watchlist-large",
      version_id: installed1.version.id,
      input: { value: "ignored" },
    });
    assert.deepEqual(largeReplay.data, large.data);

    const staleDraft = await createDraft(ctx, {
      module_key: "stock-center",
      base_module_id: installed1.id,
      version: "1.0.2",
      content: content("1.0.2", "过期草稿"),
    });
    const draft2 = await createDraft(ctx, {
      module_key: "stock-center",
      base_module_id: installed1.id,
      content: content("1.0.1", "第二版"),
    });
    const checked2 = await validateDraft(ctx, draft2.id, { expected_revision: draft2.revision });
    assert.deepEqual(checked2.new_permissions, []);
    const preview2 = await previewDraft(ctx, draft2.id, {
      expected_revision: draft2.revision,
      validation_hash: checked2.validation_hash,
    });
    const installed2 = await installDraft(ctx, draft2.id, {
      expected_revision: draft2.revision,
      validation_hash: preview2.validation_hash,
      preview_token: preview2.preview_token,
      permission_decisions: {},
    });
    assert.equal(installed2.version.version, "1.0.1");
    assert.equal(installed2.agent_exposure, "needs_review");
    await assert.rejects(() => useMiniAppAgentSkill(ctx, {
      export_id: publishedExport.id,
      command: "watchlist.save",
      input: { value: ["600000"] },
    }), /需要重新检查/);

    const staleChecked = await validateDraft(ctx, staleDraft.id, { expected_revision: staleDraft.revision });
    const stalePreview = await previewDraft(ctx, staleDraft.id, {
      expected_revision: staleDraft.revision,
      validation_hash: staleChecked.validation_hash,
    });
    await assert.rejects(() => installDraft(ctx, staleDraft.id, {
      expected_revision: staleDraft.revision,
      validation_hash: stalePreview.validation_hash,
      preview_token: stalePreview.preview_token,
      permission_decisions: {},
    }), /当前版本已变化/);

    const draft3 = await createDraft(ctx, {
      module_key: "stock-center",
      base_module_id: installed2.id,
      content: content("1.0.2", "第三版", { withStorage: false }),
    });
    const checked3 = await validateDraft(ctx, draft3.id, { expected_revision: draft3.revision });
    const preview3 = await previewDraft(ctx, draft3.id, {
      expected_revision: draft3.revision,
      validation_hash: checked3.validation_hash,
    });
    const installed3 = await installDraft(ctx, draft3.id, {
      expected_revision: draft3.revision,
      validation_hash: preview3.validation_hash,
      preview_token: preview3.preview_token,
      permission_decisions: {},
    });
    assert.equal(installed3.version.version, "1.0.2");
    const versions = await listVersions(ctx, installed3.id);
    assert.equal(versions.items.length, 3);
    const old = versions.items.find((item) => item.version === "1.0.0");
    const rolledBack = await activateVersion(ctx, installed3.id, old.id, { expected_current_version_id: installed3.version.id });
    assert.equal(rolledBack.version.version, "1.0.0");
    assert.equal(rolledBack.agent_exposure, "published");
    assert.deepEqual(rolledBack.granted_permissions, ["storage:stock-center"]);
    const rolledBackAction = await runModuleAction(ctx, installed3.id, "saveWatchlist", {
      request_id: "save-after-rollback",
      version_id: old.id,
      input: { value: ["000001"] },
    });
    assert.deepEqual(rolledBackAction.data.value, ["000001"]);

    const disabled = await setModuleStatus(ctx, installed3.id, { enabled: false });
    assert.equal(disabled.status, "disabled");
    await assert.rejects(() => runModuleAction(ctx, installed3.id, "saveWatchlist", { input: {} }), /模块不存在/);
    assert.equal((await getModule(ctx, installed3.id)).status, "disabled");
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
