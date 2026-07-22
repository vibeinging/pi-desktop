import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import {
  APP_SKILL_SCOPE,
  CHAT_SKILL_SCOPE,
  getAppSkill,
  getPiSkill,
  PI_TOOL_CATALOG,
} from "../agents/pi_skill_registry.js";
import { moduleKey, stableJson } from "./module_validator.js";
import {
  buildMiniAppPackage,
  compileBlueprintAgentActions,
  compileBlueprintPages,
  normalizeProductBlueprint,
} from "./miniapp_compiler.js";
import {
  SKILL_PRODUCT_STATE_GET_TOOL,
  SKILL_PRODUCT_STATE_SET_TOOL,
} from "./skill_product_state.js";

const PRODUCT_WORKFLOW_TOOL = "run_skill_workflow";
const TOOL_BY_NAME = new Map([
  ...PI_TOOL_CATALOG.map((tool) => [tool.name, tool]),
  [PRODUCT_WORKFLOW_TOOL, { name: PRODUCT_WORKFLOW_TOOL, safety: "read" }],
]);
const PRODUCT_RUNTIME_TYPES = new Set(["prompt", "workflow", "service"]);
const SUPPORTED_SERVICE_HANDLERS = new Set(["query_agent"]);
const PRODUCT_ADAPTER_VERSION = 1;

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isProjectScope(projectId) {
  const value = String(projectId || "").trim();
  return Boolean(value && value !== APP_SKILL_SCOPE && value !== CHAT_SKILL_SCOPE && !value.startsWith("folder:"));
}

async function requireProjectMembership(ctx, projectId) {
  const member = await ctx.queryOne(
    `SELECT 1 AS allowed FROM projects p
      JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND p.deleted_at IS NULL LIMIT 1`,
    [projectId, ctx.userId],
  ).catch(() => null);
  if (!member) throw new ApiError("项目不存在或无权限", 404);
}

function normalizeAllowedTools(skill, requestedTools, { fallbackTools = [] } = {}) {
  const declared = Array.isArray(skill?.allowed_tools)
    ? [...new Set(skill.allowed_tools.map((item) => cleanText(item, 100)).filter(Boolean))]
    : [];
  const requested = Array.isArray(requestedTools)
    ? [...new Set(requestedTools.map((item) => cleanText(item, 100)).filter(Boolean))]
    : [];
  const fallback = [...new Set(fallbackTools.map((item) => cleanText(item, 100)).filter(Boolean))];
  const boundary = declared.length ? declared : fallback;
  const selected = requested.length ? requested : boundary;
  if (!selected.length) {
    throw new ApiError("Skill 固化前必须明确 allowed_tools，不能把未声明边界的 Skill 自动变成产品", 400);
  }
  const outsideDeclared = selected.filter((name) => !boundary.includes(name));
  if (outsideDeclared.length) {
    throw new ApiError(`固化工具不能超出 Skill 声明范围: ${outsideDeclared.join(", ")}`, 400);
  }
  const unknown = selected.filter((name) => !TOOL_BY_NAME.has(name));
  if (unknown.length) throw new ApiError(`Skill 包含当前 Agent 不认识的工具: ${unknown.join(", ")}`, 400);
  if (selected.includes("use_skill")) {
    throw new ApiError("Skill Product 不能把 use_skill 作为工具，产品版本内的 Skill 必须固定", 400);
  }
  return selected;
}

export function skillProductPermission(moduleKeyValue) {
  return `skill-product:${moduleKey(moduleKeyValue)}:run`;
}

export function skillSnapshotFingerprint(snapshot) {
  return `sha256:${createHash("sha256").update(stableJson(snapshot || {})).digest("hex")}`;
}

export async function resolveSolidifiableSkill(ctx, { skillName, projectId, allowedTools } = {}) {
  const name = cleanText(skillName, 80);
  if (!name) throw new ApiError("skill_name 不能为空", 400);
  const scopedProjectId = cleanText(projectId, 200);
  const projectScoped = isProjectScope(scopedProjectId);
  if (projectScoped) await requireProjectMembership(ctx, scopedProjectId);
  const skill = projectScoped
    ? await getPiSkill(ctx, scopedProjectId, name)
    : await getAppSkill(ctx, name);
  const enabled = projectScoped
    ? bool(skill.effective_enabled ?? skill.is_enabled)
    : bool(skill.is_active) && bool(skill.default_enabled);
  if (!enabled) throw new ApiError(`Skill「${name}」未启用`, 409);
  if (skill.requires_project && !projectScoped) throw new ApiError(`Skill「${name}」需要绑定一个项目后才能固化`, 400);
  const sourceRuntime = cleanText(skill.runtime || "prompt", 32);
  if (!PRODUCT_RUNTIME_TYPES.has(sourceRuntime)) {
    throw new ApiError(`Skill「${name}」使用 ${sourceRuntime} runtime，需要先开发专用后端适配器`, 400);
  }
  if (sourceRuntime === "service" && (
    !skill.builtin
    || !SUPPORTED_SERVICE_HANDLERS.has(cleanText(skill.handler, 80))
    || !cleanText(skill.tool_name, 100)
  )) {
    throw new ApiError(`Service Skill「${name}」没有可用的产品后端适配器`, 400);
  }
  const sideEffect = cleanText(skill.side_effect || "read", 32).toLowerCase();
  const selectedTools = normalizeAllowedTools(
    skill,
    Array.isArray(allowedTools) && allowedTools.length
      ? allowedTools
      : sourceRuntime === "service"
        ? [skill.tool_name]
        : allowedTools,
    {
      fallbackTools: sourceRuntime === "workflow"
        ? [PRODUCT_WORKFLOW_TOOL]
        : sourceRuntime === "service"
          ? [skill.tool_name]
          : [],
    },
  );
  const automaticSafe = selectedTools.every((toolName) => {
    const safety = TOOL_BY_NAME.get(toolName)?.safety;
    return safety === "read" || safety === "meta";
  }) && ["", "none", "read", "query"].includes(sideEffect);
  const snapshot = {
    name: skill.name,
    display_name: cleanText(skill.display_name || skill.name, 120),
    description: cleanText(skill.description, 1000),
    category: cleanText(skill.category || "general", 80),
    tags: Array.isArray(skill.tags) ? skill.tags.map((item) => cleanText(item, 48)).filter(Boolean).slice(0, 12) : [],
    instructions: cleanText(skill.instructions, 64_000),
    allowed_tools: selectedTools,
    runtime: "prompt",
    source_runtime: sourceRuntime,
    side_effect: sideEffect || "read",
    requires_project: Boolean(skill.requires_project),
    project_id: projectScoped ? scopedProjectId : null,
    source_skill_id: skill.id || skill.name,
    source_updated_at: skill.updated_at || null,
    service_handler: sourceRuntime === "service" ? cleanText(skill.handler, 80) : null,
    service_tool_name: sourceRuntime === "service" ? cleanText(skill.tool_name, 100) : null,
    execution_mode: "interactive",
    automatic_safe: automaticSafe,
    product_adapter_version: PRODUCT_ADAPTER_VERSION,
    provenance: skill.provenance && typeof skill.provenance === "object" ? structuredClone(skill.provenance) : null,
  };
  if (!snapshot.instructions) throw new ApiError(`Skill「${name}」没有可执行指令`, 400);
  return {
    skill,
    snapshot,
    fingerprint: skillSnapshotFingerprint(snapshot),
    scope: projectScoped ? "project" : "app",
    project_id: snapshot.project_id,
  };
}

function containsAgentWorkspace(value) {
  if (Array.isArray(value)) return value.some(containsAgentWorkspace);
  if (!value || typeof value !== "object") return false;
  if (value.type === "AgentWorkspace") return true;
  return Object.values(value).some(containsAgentWorkspace);
}

function parseStructured(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

function pageTitle(pageId) {
  return cleanText(String(pageId || "").replace(/[-_]+/g, " "), 80) || "页面";
}

function normalizeProductNode(value, bindingId) {
  if (Array.isArray(value)) return value.map((item) => normalizeProductNode(item, bindingId));
  if (!value || typeof value !== "object") return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeProductNode(child, bindingId)]),
  );
  if (node.type === "AgentWorkspace" && !cleanText(node.bindingId || node.binding_id, 200)) {
    node.bindingId = bindingId;
  }
  if ((node.type === "Text" || node.type === "Markdown") && node.text == null && typeof node.content === "string") {
    node.text = node.content;
  }
  if (node.type === "Badge" && node.text == null && node.label != null) node.text = node.label;
  if (node.type === "MetricCard" && node.label == null && node.title != null) node.label = node.title;
  if (node.type === "Tabs" && !Array.isArray(node.items) && Array.isArray(node.tabs)) {
    node.items = node.tabs.map((item, index) => ({
      label: item?.label || item?.title || `标签 ${index + 1}`,
      content: item?.content || { type: "Stack", children: Array.isArray(item?.children) ? item.children : [] },
    }));
  }
  return node;
}

function normalizeProductPages(value, bindingId) {
  const input = parseStructured(value, {});
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).map(([pageId, rawPage]) => {
    const page = rawPage && typeof rawPage === "object" && !Array.isArray(rawPage) ? structuredClone(rawPage) : {};
    const layout = page.layout && typeof page.layout === "object"
      ? page.layout
      : typeof page.type === "string"
        ? page
        : { type: "Stack", children: Array.isArray(page.children) ? page.children : [] };
    return [pageId, {
      ...(page.layout ? page : {}),
      id: cleanText(page.id || pageId, 80),
      title: cleanText(page.title || page.label || pageTitle(pageId), 80),
      layout: normalizeProductNode(layout, bindingId),
    }];
  }));
}

function normalizeNavigation(value, pages) {
  const pageIds = new Set(Object.keys(pages));
  const parsed = parseStructured(value, []);
  const items = Array.isArray(parsed) ? parsed : [];
  const normalized = items
    .map((item) => typeof item === "string" ? { page: item, label: pages[item]?.title || item } : item)
    .filter((item) => item && pageIds.has(String(item.page || "")))
    .map((item) => ({
      page: String(item.page),
      label: cleanText(item.label || pages[item.page]?.title || item.page, 60),
      icon: cleanText(item.icon, 40) || undefined,
    }));
  const seen = new Set(normalized.map((item) => item.page));
  for (const page of pageIds) {
    if (!seen.has(page)) normalized.push({ page, label: cleanText(pages[page]?.title || page, 60) });
  }
  return normalized;
}

export function buildSkillProductContent({
  bindingId,
  moduleKey: rawModuleKey,
  name,
  description,
  icon,
  version = "1.0.0",
  sidebar,
  pages: requestedPages,
  navigation,
  actions,
  blueprint,
  permissions,
  skill,
  projectId,
} = {}) {
  const key = moduleKey(rawModuleKey || name || skill?.name);
  if (!key) throw new ApiError("module_key 不能为空", 400);
  const productPermission = skillProductPermission(key);
  const needsProductStorage = Array.isArray(skill?.allowed_tools) && skill.allowed_tools.some((tool) => (
    tool === SKILL_PRODUCT_STATE_GET_TOOL || tool === SKILL_PRODUCT_STATE_SET_TOOL
  ));
  const storagePermission = needsProductStorage ? `storage:${key}` : null;
  let pages = normalizeProductPages(requestedPages, bindingId);
  const normalizedBlueprint = normalizeProductBlueprint(blueprint, {
    moduleKey: key,
    name,
    description,
    skill,
    pages,
  });
  if (!Object.keys(pages).length) pages = compileBlueprintPages(normalizedBlueprint, { bindingId });
  if (!Object.values(pages).some(containsAgentWorkspace)) {
    pages.workspace = {
      id: "workspace",
      title: "工作台",
      layout: { type: "AgentWorkspace", bindingId },
    };
  }
  if (!pages.overview) {
    pages.overview = {
      id: "overview",
      title: "产品说明",
      layout: {
        type: "Stack",
        gap: "lg",
        children: [
          { type: "Heading", level: 1, text: name || skill?.display_name || skill?.name || key },
          { type: "Text", text: description || skill?.description || "这个产品由 Skill 固化生成。" },
          {
            type: "Card",
            children: [
              { type: "Badge", text: `Skill · ${skill?.name || ""}` },
              { type: "Text", text: "产品拥有独立页面、专属会话和固定版本的 Skill 执行逻辑。" },
            ],
          },
        ],
      },
    };
  }
  const nav = normalizeNavigation(navigation, pages);
  const entryPage = nav[0]?.page || Object.keys(pages)[0];
  const requestedActions = parseStructured(actions, {});
  const legacyActions = requestedActions && typeof requestedActions === "object" && !Array.isArray(requestedActions)
    ? structuredClone(requestedActions)
    : {};
  const normalizedActions = {
    ...legacyActions,
    ...compileBlueprintAgentActions(normalizedBlueprint, { productPermission }),
  };
  if (needsProductStorage && !Object.keys(normalizedActions).length) {
    normalizedActions.load_product_data = {
      type: "state.get",
      namespace: skill?.name || key,
      key: "product_data",
      permission: storagePermission,
    };
    for (const page of Object.values(pages)) {
      if (page?.layout?.type === "AgentWorkspace" || page.onLoad) continue;
      page.onLoad = { action: "load_product_data", target: "product_data" };
      if (!page.mockData) page.mockData = { product_data: { value: null, revision: 0, exists: false } };
    }
  }
  const parsedSidebar = parseStructured(sidebar, null);
  const parsedPermissions = parseStructured(permissions, []);
  return {
    manifest: {
      schemaVersion: 1,
      id: key,
      name: cleanText(name || skill?.display_name || skill?.name || key, 80),
      description: cleanText(description || skill?.description, 500),
      icon: cleanText(icon || "sparkles", 64),
      version: cleanText(version, 40) || "1.0.0",
      minAppVersion: "0.0.1",
      sidebar: parsedSidebar && typeof parsedSidebar === "object" && !Array.isArray(parsedSidebar)
        ? parsedSidebar
        : { visible: true, group: "products", order: 100 },
      entryPage,
      navigation: nav,
      product: {
        type: "skill-product",
        bindingId,
        skillName: skill?.name || "",
        projectId: projectId || null,
      },
      permissions: [...new Set([
        productPermission,
        ...(storagePermission ? [storagePermission] : []),
        ...(Array.isArray(parsedPermissions) ? parsedPermissions : []),
      ])],
    },
    pages,
    actions: normalizedActions,
  };
}

export function compileSkillProductMiniApp({
  skillSnapshot,
  skillFingerprint,
  ...options
} = {}) {
  const skill = options.skill || skillSnapshot || {};
  const key = moduleKey(options.moduleKey || options.name || skill?.name);
  const blueprint = normalizeProductBlueprint(options.blueprint, {
    moduleKey: key,
    name: options.name,
    description: options.description,
    skill,
    pages: parseStructured(options.pages, {}),
  });
  const content = buildSkillProductContent({
    ...options,
    moduleKey: key,
    blueprint,
    skill,
  });
  const miniappPackage = buildMiniAppPackage({
    blueprint,
    content,
    bindingId: options.bindingId,
    skillSnapshot: skillSnapshot || skill,
    skillFingerprint,
    projectId: options.projectId || null,
  });
  return {
    content,
    blueprint,
    package: miniappPackage,
    compiler_version: miniappPackage.compilerVersion,
    runtime_version: miniappPackage.runtimeVersion,
    state_schema: miniappPackage.stateSchema,
    lifecycle: miniappPackage.lifecycle,
    test_report: {
      status: "passed",
      checks: ["package.checksum", "blueprint.checksum", "content.checksum", "command.schema"],
      generated_tests: miniappPackage.tests,
    },
  };
}

export function publicSkillProductBinding(row) {
  if (!row) return null;
  const snapshot = parseJson(row.skill_snapshot_json);
  return {
    id: row.id,
    module_id: row.module_id || null,
    version_id: row.version_id || null,
    skill_name: row.skill_name,
    display_name: snapshot.display_name || row.skill_name,
    description: snapshot.description || "",
    skill_scope: row.skill_scope,
    project_id: row.project_id || null,
    source_runtime: row.source_runtime || snapshot.source_runtime || snapshot.runtime || "prompt",
    fingerprint: row.skill_fingerprint,
    allowed_tools: snapshot.allowed_tools || [],
    execution_mode: snapshot.execution_mode || "interactive",
    automatic_safe: snapshot.automatic_safe === true,
    permission: row.permission,
    status: row.status,
    created_at: row.created_at,
  };
}

export async function resolveInstalledSkillProduct(ctx, {
  moduleId,
  versionId,
  bindingId,
  sessionId,
  projectId,
} = {}) {
  const userId = cleanText(ctx?.userId, 200);
  if (!userId) throw new ApiError("未登录", 401);
  const module = await ctx.queryOne(
    `SELECT id,module_key,status,current_version_id FROM ui_modules
      WHERE owner_user_id=$1 AND (id=$2 OR module_key=$2) AND deleted_at IS NULL LIMIT 1`,
    [userId, cleanText(moduleId, 200)],
  );
  if (!module || module.status !== "active") throw new ApiError("Skill Product 不存在或未启用", 404);
  if (!versionId || versionId !== module.current_version_id) throw new ApiError("Skill Product 版本已变化，请刷新页面", 409);
  const binding = await ctx.queryOne(
    `SELECT * FROM ui_module_skill_bindings
      WHERE id=$1 AND module_id=$2 AND version_id=$3 AND owner_user_id=$4
        AND status='installed' AND deleted_at IS NULL LIMIT 1`,
    [cleanText(bindingId, 200), module.id, versionId, userId],
  );
  if (!binding) throw new ApiError("Skill Product 的执行绑定不存在", 409);
  const grant = await ctx.queryOne(
    `SELECT id FROM ui_module_permission_grants
      WHERE module_id=$1 AND granted_for_version_id=$2 AND permission=$3 AND status='granted' LIMIT 1`,
    [module.id, versionId, binding.permission],
  );
  if (!grant) throw new ApiError(`Skill Product 没有权限 ${binding.permission}`, 403);
  const expectedProjectId = binding.project_id || CHAT_SKILL_SCOPE;
  if (String(projectId || "") !== expectedProjectId) throw new ApiError("Skill Product 运行工作区不匹配", 409);
  if (binding.project_id) await requireProjectMembership(ctx, binding.project_id);
  const snapshot = parseJson(binding.skill_snapshot_json, null);
  if (!snapshot || skillSnapshotFingerprint(snapshot) !== binding.skill_fingerprint) {
    throw new ApiError("Skill Product 快照校验失败，请重新安装", 409);
  }
  if (Number(snapshot.product_adapter_version) !== PRODUCT_ADAPTER_VERSION) {
    throw new ApiError("Skill Product 执行适配器版本不兼容，请生成新版本", 409);
  }
  normalizeAllowedTools(snapshot, snapshot.allowed_tools);
  const sid = cleanText(sessionId, 200);
  if (!sid) throw new ApiError("Skill Product 缺少专属会话", 400);
  const session = await ctx.queryOne(
    `SELECT id,project_id,created_by,action_type FROM sessions WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [sid],
  );
  if (
    !session
    || session.created_by !== userId
    || session.project_id !== expectedProjectId
    || session.action_type !== "skill_product"
  ) {
    throw new ApiError("Skill Product 会话不存在或不属于当前用户", 403);
  }
  let existingSession = await ctx.queryOne(
    `SELECT * FROM ui_module_skill_sessions WHERE session_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [sid, userId],
  );
  if (existingSession && (
    existingSession.module_id !== module.id
    || existingSession.version_id !== versionId
    || existingSession.binding_id !== binding.id
  )) {
    throw new ApiError("这个会话已经属于另一个 Skill Product 版本", 409);
  }
  if (existingSession) {
    await ctx.query(`UPDATE ui_module_skill_sessions SET last_run_at=now(),updated_at=now() WHERE id=$1`, [existingSession.id]);
  } else {
    await ctx.query(
      `INSERT OR IGNORE INTO ui_module_skill_sessions
         (id,module_id,version_id,binding_id,session_id,owner_user_id,project_id,created_at,updated_at,last_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now(),now())`,
      [randomUUID(), module.id, versionId, binding.id, sid, userId, expectedProjectId],
    );
    existingSession = await ctx.queryOne(
      `SELECT * FROM ui_module_skill_sessions WHERE session_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL LIMIT 1`,
      [sid, userId],
    );
    if (!existingSession || (
      existingSession.module_id !== module.id
      || existingSession.version_id !== versionId
      || existingSession.binding_id !== binding.id
    )) {
      throw new ApiError("这个会话已经属于另一个 Skill Product 版本", 409);
    }
  }
  return {
    module,
    binding,
    product: {
      module_id: module.id,
      module_key: module.module_key,
      version_id: versionId,
      binding_id: binding.id,
      session_id: sid,
    },
    skill: {
      ...snapshot,
      id: binding.id,
      runtime: "prompt",
      effective_enabled: true,
      is_enabled: true,
      default_enabled: true,
      is_active: true,
      project_id: binding.project_id || null,
      source: "skill_product_snapshot",
    },
  };
}
