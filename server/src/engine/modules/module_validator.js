import { createHash } from "node:crypto";

export const MODULE_SCHEMA_VERSION = 1;
export const MODULE_COMPONENTS = new Set([
  "Stack",
  "Grid",
  "Tabs",
  "Toolbar",
  "Heading",
  "Text",
  "Button",
  "SearchInput",
  "MetricCard",
  "DataTable",
  "LineChart",
  "CandlestickChart",
  "MarketOverview",
  "EmptyState",
  "Card",
  "Section",
  "Badge",
  "Divider",
  "Markdown",
  "AgentWorkspace",
]);

export const MODULE_ACTION_TYPES = new Set(["state.get", "state.set", "provider.call", "agent.intent"]);

const MODULE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_PAGE_NODES = 400;
const MAX_PAGE_DEPTH = 16;
const FORBIDDEN_KEYS = new Set(["script", "javascript", "dangerouslySetInnerHTML", "html"]);

function jsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function semverParts(value) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9.-]+))?$/i);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareModuleVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : null;
    if (aNumber != null && bNumber != null) return aNumber < bNumber ? -1 : 1;
    if (aNumber != null) return -1;
    if (bNumber != null) return 1;
    return aPart.localeCompare(bPart) < 0 ? -1 : 1;
  }
  return 0;
}

export function appVersionSupports(minAppVersion, currentAppVersion) {
  const comparison = compareModuleVersions(currentAppVersion, minAppVersion);
  return comparison != null && comparison >= 0;
}

export function moduleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export function normalizeModuleContent(content = {}, options = {}) {
  const rawManifest = jsonObject(content.manifest);
  const key = moduleKey(rawManifest.id || rawManifest.module_key || options.module_key);
  const pageInput = content.pages || (content.page ? { [content.page.id || "home"]: content.page } : {});
  const pages = jsonObject(pageInput);
  const actions = jsonObject(content.actions);
  const permissions = Array.isArray(rawManifest.permissions)
    ? [...new Set(rawManifest.permissions.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  const version = String(rawManifest.version || options.version || "1.0.0").trim();
  const entryPage = String(rawManifest.entryPage || rawManifest.entry_page || Object.keys(pages)[0] || "home").trim();
  const manifest = {
    schemaVersion: Number(rawManifest.schemaVersion || rawManifest.schema_version || MODULE_SCHEMA_VERSION),
    id: key,
    name: String(rawManifest.name || options.name || key || "新模块").trim().slice(0, 80),
    description: String(rawManifest.description || options.description || "").trim().slice(0, 500),
    icon: String(rawManifest.icon || options.icon || "sparkles").trim().slice(0, 64),
    version,
    minAppVersion: String(rawManifest.minAppVersion || rawManifest.min_app_version || "0.0.1").trim(),
    sidebar: {
      visible: rawManifest.sidebar?.visible !== false,
      group: String(rawManifest.sidebar?.group || "personal").trim().slice(0, 40),
      order: Number.isFinite(Number(rawManifest.sidebar?.order)) ? Number(rawManifest.sidebar.order) : 100,
    },
    entryPage,
    navigation: Array.isArray(rawManifest.navigation)
      ? rawManifest.navigation.slice(0, 24).map((item) => typeof item === "string" ? { page: item, label: item } : {
          page: String(item?.page || "").trim().slice(0, 80),
          label: String(item?.label || item?.page || "").trim().slice(0, 80),
          ...(item?.icon ? { icon: String(item.icon).trim().slice(0, 64) } : {}),
        })
      : [],
    product: rawManifest.product && typeof rawManifest.product === "object" && !Array.isArray(rawManifest.product)
      ? {
          type: String(rawManifest.product.type || "").trim().slice(0, 40),
          bindingId: String(rawManifest.product.bindingId || rawManifest.product.binding_id || "").trim().slice(0, 200),
          skillName: String(rawManifest.product.skillName || rawManifest.product.skill_name || "").trim().slice(0, 80),
          projectId: rawManifest.product.projectId || rawManifest.product.project_id || null,
        }
      : null,
    permissions,
  };
  return { manifest, pages, actions };
}

function permissionAllowed(permission, moduleKeyValue) {
  if (permission === "notification:create") return true;
  if (permission === `storage:${moduleKeyValue}`) return true;
  if (/^provider:[a-z0-9][a-z0-9_-]{0,63}:read$/.test(permission)) return true;
  if (permission === `skill-product:${moduleKeyValue}:run`) return true;
  return false;
}

function actionRefs(value, refs, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => actionRefs(item, refs, `${path}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (/^on[A-Z]/.test(key) && child && typeof child === "object" && typeof child.action === "string") {
      refs.push({ action: child.action, path: childPath });
    }
    actionRefs(child, refs, childPath);
  }
}

function validatePageTree(value, errors, stats, path = "", depth = 0) {
  if (depth > MAX_PAGE_DEPTH) {
    errors.push({ code: "PAGE_TOO_DEEP", path, message: `页面层级不能超过 ${MAX_PAGE_DEPTH} 层` });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePageTree(item, errors, stats, `${path}/${index}`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push({ code: "FORBIDDEN_PAGE_FIELD", path: `${path}/${key}`, message: `页面描述不允许字段 ${key}` });
    }
  }
  if (typeof value.type === "string") {
    stats.nodes += 1;
    if (!MODULE_COMPONENTS.has(value.type)) {
      errors.push({ code: "UNKNOWN_COMPONENT", path: `${path}/type`, message: `不支持组件 ${value.type}` });
    }
    if (value.type === "AgentWorkspace" && !String(value.bindingId || value.binding_id || "").trim()) {
      errors.push({ code: "SKILL_PRODUCT_BINDING_REQUIRED", path: `${path}/bindingId`, message: "AgentWorkspace 缺少 Skill Product bindingId" });
    }
    if (stats.nodes > MAX_PAGE_NODES && !stats.nodeLimitReported) {
      stats.nodeLimitReported = true;
      errors.push({ code: "TOO_MANY_PAGE_NODES", path, message: `页面组件不能超过 ${MAX_PAGE_NODES} 个` });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "data" || key === "mockData") continue;
    validatePageTree(child, errors, stats, `${path}/${key}`, depth + 1);
  }
}

export function validateModuleContent(content = {}, options = {}) {
  const normalized = normalizeModuleContent(content, options);
  const { manifest, pages, actions } = normalized;
  const errors = [];
  const warnings = [];
  const size = Buffer.byteLength(stableJson(normalized));
  if (size > MAX_JSON_BYTES) {
    errors.push({ code: "MODULE_TOO_LARGE", path: "/", message: `模块描述不能超过 ${MAX_JSON_BYTES / 1024}KB` });
  }
  if (!MODULE_KEY_RE.test(manifest.id)) {
    errors.push({ code: "INVALID_MODULE_KEY", path: "/manifest/id", message: "模块标识只能包含小写字母、数字和中划线" });
  }
  const expectedKey = moduleKey(options.module_key);
  if (expectedKey && manifest.id !== expectedKey) {
    errors.push({ code: "MODULE_KEY_MISMATCH", path: "/manifest/id", message: `模块标识必须是 ${expectedKey}` });
  }
  if (!manifest.name) errors.push({ code: "MODULE_NAME_REQUIRED", path: "/manifest/name", message: "模块名称不能为空" });
  if (manifest.schemaVersion !== MODULE_SCHEMA_VERSION) {
    errors.push({ code: "UNSUPPORTED_SCHEMA_VERSION", path: "/manifest/schemaVersion", message: `当前只支持 schemaVersion=${MODULE_SCHEMA_VERSION}` });
  }
  if (!VERSION_RE.test(manifest.version)) {
    errors.push({ code: "INVALID_MODULE_VERSION", path: "/manifest/version", message: "模块版本必须使用 x.y.z 格式" });
  }
  if (!VERSION_RE.test(manifest.minAppVersion)) {
    errors.push({ code: "INVALID_MIN_APP_VERSION", path: "/manifest/minAppVersion", message: "最低 App 版本必须使用 x.y.z 格式" });
  } else if (options.current_app_version && !appVersionSupports(manifest.minAppVersion, options.current_app_version)) {
    errors.push({
      code: "APP_VERSION_INCOMPATIBLE",
      path: "/manifest/minAppVersion",
      message: `模块需要 YiW ${manifest.minAppVersion} 或更高版本，当前是 ${options.current_app_version}`,
    });
  }
  if (!Object.keys(pages).length) errors.push({ code: "MODULE_PAGE_REQUIRED", path: "/pages", message: "模块至少需要一个页面" });
  if (!pages[manifest.entryPage]) {
    errors.push({ code: "ENTRY_PAGE_MISSING", path: "/manifest/entryPage", message: `入口页面 ${manifest.entryPage} 不存在` });
  }
  for (const [index, item] of manifest.navigation.entries()) {
    if (!item.page || !pages[item.page]) {
      errors.push({ code: "NAVIGATION_PAGE_MISSING", path: `/manifest/navigation/${index}/page`, message: `导航页面 ${item.page || "(空)"} 不存在` });
    }
  }
  if (manifest.product) {
    if (manifest.product.type !== "skill-product") {
      errors.push({ code: "UNKNOWN_PRODUCT_TYPE", path: "/manifest/product/type", message: `不支持产品类型 ${manifest.product.type || "(空)"}` });
    }
    if (!manifest.product.bindingId) {
      errors.push({ code: "SKILL_PRODUCT_BINDING_REQUIRED", path: "/manifest/product/bindingId", message: "Skill Product 缺少执行绑定" });
    }
    const productPermission = `skill-product:${manifest.id}:run`;
    if (!manifest.permissions.includes(productPermission)) {
      errors.push({ code: "SKILL_PRODUCT_PERMISSION_REQUIRED", path: "/manifest/permissions", message: `Skill Product 必须声明 ${productPermission}` });
    }
  }
  for (const permission of manifest.permissions) {
    if (!permissionAllowed(permission, manifest.id)) {
      errors.push({ code: "UNKNOWN_PERMISSION", path: "/manifest/permissions", message: `不支持权限 ${permission}` });
    }
  }
  const stats = { nodes: 0, nodeLimitReported: false };
  for (const [pageId, page] of Object.entries(pages)) {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      errors.push({ code: "INVALID_PAGE", path: `/pages/${pageId}`, message: "页面必须是对象" });
      continue;
    }
    if (!page.layout || typeof page.layout !== "object") {
      errors.push({ code: "PAGE_LAYOUT_REQUIRED", path: `/pages/${pageId}/layout`, message: "页面缺少 layout" });
      continue;
    }
    validatePageTree(page.layout, errors, stats, `/pages/${pageId}/layout`);
    const refs = [];
    actionRefs(page.layout, refs, `/pages/${pageId}/layout`);
    for (const ref of refs) {
      if (!actions[ref.action]) errors.push({ code: "ACTION_NOT_FOUND", path: ref.path, message: `动作 ${ref.action} 不存在` });
    }
    const onLoad = Array.isArray(page.onLoad) ? page.onLoad : page.onLoad ? [page.onLoad] : [];
    for (const [index, item] of onLoad.entries()) {
      const actionName = typeof item === "string" ? item : item?.action;
      if (!actionName || !actions[actionName]) {
        errors.push({ code: "ACTION_NOT_FOUND", path: `/pages/${pageId}/onLoad/${index}`, message: `动作 ${actionName || "(空)"} 不存在` });
      }
    }
  }
  for (const [name, action] of Object.entries(actions)) {
    const path = `/actions/${name}`;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      errors.push({ code: "INVALID_ACTION", path, message: "动作必须是对象" });
      continue;
    }
    if (!MODULE_ACTION_TYPES.has(action.type)) {
      errors.push({ code: "UNKNOWN_ACTION_TYPE", path: `${path}/type`, message: `不支持动作类型 ${action.type || "(空)"}` });
      continue;
    }
    if (!action.permission || !manifest.permissions.includes(action.permission)) {
      errors.push({ code: "ACTION_PERMISSION_MISSING", path: `${path}/permission`, message: `动作 ${name} 的权限未在 manifest 声明` });
    }
    if (action.type === "provider.call") {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(action.provider || ""))) {
        errors.push({ code: "INVALID_PROVIDER_ALIAS", path: `${path}/provider`, message: `动作 ${name} 缺少合法 Provider 别名` });
      }
      if (!String(action.tool || "").trim()) errors.push({ code: "PROVIDER_TOOL_REQUIRED", path: `${path}/tool`, message: `动作 ${name} 缺少 Provider tool` });
      if (action.timeout_ms !== undefined) {
        const timeout = Number(action.timeout_ms);
        if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 60_000) {
          errors.push({ code: "INVALID_PROVIDER_TIMEOUT", path: `${path}/timeout_ms`, message: "Provider 超时必须在 1000 到 60000 毫秒之间" });
        }
      }
      const expectedPermission = `provider:${action.provider}:read`;
      if (action.permission && action.permission !== expectedPermission) {
        errors.push({ code: "PROVIDER_PERMISSION_MISMATCH", path: `${path}/permission`, message: `Provider 读取动作必须使用 ${expectedPermission}` });
      }
    }
    if (action.type === "agent.intent") {
      const expectedPermission = `skill-product:${manifest.id}:run`;
      if (!manifest.product) {
        errors.push({ code: "AGENT_INTENT_PRODUCT_REQUIRED", path, message: "agent.intent 只能用于 Skill Product" });
      }
      if (action.permission !== expectedPermission) {
        errors.push({ code: "AGENT_INTENT_PERMISSION_MISMATCH", path: `${path}/permission`, message: `Agent 命令必须使用 ${expectedPermission}` });
      }
      if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(String(action.command || ""))) {
        errors.push({ code: "INVALID_AGENT_COMMAND", path: `${path}/command`, message: `动作 ${name} 缺少合法 command` });
      }
      if (!String(action.intent || "").trim()) {
        errors.push({ code: "AGENT_INTENT_REQUIRED", path: `${path}/intent`, message: `动作 ${name} 缺少 intent` });
      }
      if (!action.input_schema || typeof action.input_schema !== "object" || Array.isArray(action.input_schema)) {
        errors.push({ code: "AGENT_INPUT_SCHEMA_REQUIRED", path: `${path}/input_schema`, message: `动作 ${name} 缺少输入结构` });
      }
    }
    if ((action.type === "state.get" || action.type === "state.set") && action.permission !== `storage:${manifest.id}`) {
      errors.push({ code: "STORAGE_PERMISSION_MISMATCH", path: `${path}/permission`, message: `状态动作必须使用 storage:${manifest.id}` });
    }
  }
  if (!Object.keys(actions).length) warnings.push({ code: "STATIC_MODULE", message: "模块没有动作，只会显示静态内容" });
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    requested_permissions: manifest.permissions,
    stats: { bytes: size, nodes: stats.nodes, pages: Object.keys(pages).length, actions: Object.keys(actions).length },
    normalized,
  };
}

export function validationHash(result) {
  return `sha256:${createHash("sha256").update(stableJson({
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    normalized: result.normalized,
    miniapp: result.miniapp || null,
  })).digest("hex")}`;
}

export function moduleChecksum(content) {
  return `sha256:${createHash("sha256").update(stableJson(normalizeModuleContent(content))).digest("hex")}`;
}

export function nextPatchVersion(value) {
  const match = VERSION_RE.exec(String(value || ""));
  if (!match) return "1.0.0";
  const [major, minor, patch] = String(value).split(/[.-]/).slice(0, 3).map((part) => Number(part));
  return `${major}.${minor}.${patch + 1}`;
}
