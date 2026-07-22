// 动态 UI 模块用例层。传输层只负责拆参数，规则和事务统一在 registry 中。
import {
  activateVersion,
  bindProvider,
  createMiniAppSkillExportDraft,
  createDraft,
  createSkillProductDraft,
  deleteModule,
  getDraft,
  getModule,
  getModuleState,
  installDraft,
  listMiniAppAgentSkills,
  listModules,
  listVersions,
  previewDraft,
  publishMiniAppSkillExport,
  replaceDraft,
  runModuleAction,
  setModuleStatus,
  suspendMiniAppSkillExport,
  useMiniAppAgentSkill,
  validateDraft,
  validateMiniAppSkillExport,
} from "../../engine/modules/module_registry.js";

const ok = (data) => ({ data });

export async function list(ctx, req = {}) {
  return ok(await listModules(ctx, req.query || {}));
}

export async function detail(ctx, req = {}) {
  return ok(await getModule(ctx, req.params?.moduleId));
}

export async function versions(ctx, req = {}) {
  return ok(await listVersions(ctx, req.params?.moduleId));
}

export async function moduleState(ctx, req = {}) {
  return ok(await getModuleState(ctx, req.params?.moduleId, req.query || {}));
}

export async function createModuleDraft(ctx, req = {}) {
  return ok(await createDraft(ctx, req.body || {}));
}

export async function createProductFromSkill(ctx, req = {}) {
  return ok(await createSkillProductDraft(ctx, req.body || {}));
}

export async function moduleDraft(ctx, req = {}) {
  return ok(await getDraft(ctx, req.params?.draftId));
}

export async function updateModuleDraft(ctx, req = {}) {
  return ok(await replaceDraft(ctx, req.params?.draftId, req.body || {}));
}

export async function checkModuleDraft(ctx, req = {}) {
  return ok(await validateDraft(ctx, req.params?.draftId, req.body || {}));
}

export async function openModulePreview(ctx, req = {}) {
  return ok(await previewDraft(ctx, req.params?.draftId, req.body || {}));
}

export async function installModuleDraft(ctx, req = {}) {
  return ok(await installDraft(ctx, req.params?.draftId, req.body || {}));
}

export async function toggleModule(ctx, req = {}) {
  return ok(await setModuleStatus(ctx, req.params?.moduleId, req.body || {}));
}

export async function switchModuleVersion(ctx, req = {}) {
  return ok(await activateVersion(ctx, req.params?.moduleId, req.params?.versionId, req.body || {}));
}

export async function removeModule(ctx, req = {}) {
  return ok(await deleteModule(ctx, req.params?.moduleId));
}

export async function bindModuleProvider(ctx, req = {}) {
  return ok(await bindProvider(ctx, req.params?.moduleId, req.params?.providerAlias, req.body || {}));
}

export async function executeModuleAction(ctx, req = {}) {
  return ok(await runModuleAction(ctx, req.params?.moduleId, req.params?.actionName, req.body || {}));
}

export async function createAgentExport(ctx, req = {}) {
  return ok(await createMiniAppSkillExportDraft(ctx, req.params?.moduleId, req.body || {}));
}

export async function validateAgentExport(ctx, req = {}) {
  return ok(await validateMiniAppSkillExport(ctx, req.params?.exportId));
}

export async function publishAgentExport(ctx, req = {}) {
  return ok(await publishMiniAppSkillExport(ctx, req.params?.exportId, req.body || {}));
}

export async function suspendAgentExport(ctx, req = {}) {
  return ok(await suspendMiniAppSkillExport(ctx, req.params?.exportId));
}

export async function listAgentSkills(ctx, req = {}) {
  return ok(await listMiniAppAgentSkills(ctx, req.query || {}));
}

export async function invokeAgentSkill(ctx, req = {}) {
  return ok(await useMiniAppAgentSkill(ctx, {
    ...(req.body || {}),
    export_id: req.params?.exportId,
    command: req.params?.commandName,
  }));
}
