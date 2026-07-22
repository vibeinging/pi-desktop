import { createHash } from "node:crypto";
import { ApiError } from "../../errors.js";
import { moduleKey, stableJson } from "./module_validator.js";

export const MINIAPP_PACKAGE_VERSION = 1;
export const MINIAPP_RUNTIME_VERSION = "1";
export const MINIAPP_COMPILER_VERSION = "1.0.0";
export const MINIAPP_HOST_CAPABILITIES = new Set([
  "yiw.state.read",
  "yiw.state.write",
  "yiw.agent.invoke",
  "yiw.provider.call",
  "yiw.navigation.open",
]);

const COMMAND_NAME_RE = /^[a-z][a-z0-9_.-]{0,79}$/;
const ACTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_BLUEPRINT_BYTES = 128 * 1024;
const MAX_REQUIREMENTS_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 12;

function parseObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function stringList(value, maxItems = 50, maxLength = 200) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems)
    : [];
}

function checksum(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function normalizeRequirementBundle(value, options = {}) {
  const raw = parseObject(value);
  const rawSources = Array.isArray(raw.sources)
    ? raw.sources
    : Array.isArray(options.sources)
      ? options.sources
      : [];
  const sources = rawSources.slice(0, 40).map((item, index) => {
    const source = parseObject(item);
    const type = clean(source.type || "reference", 40).toLowerCase();
    const normalized = {
      type,
      ref: clean(source.ref || source.name || source.url || `${type}-${index + 1}`, 500),
      summary: clean(source.summary || source.description, 4000),
    };
    if (source.version != null) normalized.version = clean(source.version, 100);
    if (source.fingerprint != null) normalized.fingerprint = clean(source.fingerprint, 200);
    if (source.snapshot && typeof source.snapshot === "object") normalized.snapshot = structuredClone(source.snapshot);
    return normalized;
  });
  const bundle = {
    schemaVersion: 1,
    goal: clean(raw.goal || options.goal, 4000),
    sources,
    constraints: stringList(raw.constraints, 100, 500),
    acceptanceCriteria: stringList(raw.acceptanceCriteria || raw.acceptance_criteria, 100, 500),
  };
  if (Buffer.byteLength(stableJson(bundle)) > MAX_REQUIREMENTS_BYTES) {
    throw new ApiError(`Requirement Bundle 不能超过 ${MAX_REQUIREMENTS_BYTES / 1024}KB`, 400);
  }
  return bundle;
}

function containsAgentWorkspace(value) {
  if (Array.isArray(value)) return value.some(containsAgentWorkspace);
  if (!value || typeof value !== "object") return false;
  if (value.type === "AgentWorkspace") return true;
  return Object.values(value).some(containsAgentWorkspace);
}

function commandActionName(commandName, requested) {
  const explicit = clean(requested, 80);
  if (ACTION_NAME_RE.test(explicit)) return explicit;
  const derived = `command_${commandName.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")}`.slice(0, 80);
  return ACTION_NAME_RE.test(derived) ? derived : `command_${checksum(commandName).slice(-12)}`;
}

function normalizeInputSchema(value) {
  const schema = parseObject(value, { type: "object", additionalProperties: true });
  if (!schema.type) schema.type = "object";
  return structuredClone(schema);
}

function normalizeCommands(value) {
  if (!Array.isArray(value)) return [];
  const seenNames = new Set();
  const seenActions = new Set();
  return value.slice(0, 80).map((raw, index) => {
    const command = parseObject(raw);
    const name = clean(command.name, 80);
    if (!COMMAND_NAME_RE.test(name)) throw new ApiError(`Product Blueprint 命令 ${index + 1} 的 name 不合法`, 400);
    if (seenNames.has(name)) throw new ApiError(`Product Blueprint 命令重复: ${name}`, 400);
    seenNames.add(name);
    const handler = parseObject(command.handler);
    const handlerType = clean(handler.type || command.handler_type, 40) || "agent.intent";
    if (handlerType !== "agent.intent") {
      throw new ApiError(`MiniApp Package v1 暂不支持命令处理器 ${handlerType}`, 400);
    }
    const intent = clean(handler.intent || command.intent || command.description, 4000);
    if (!intent) throw new ApiError(`Product Blueprint 命令 ${name} 缺少 intent`, 400);
    const actionName = commandActionName(name, command.action || command.actionName || command.action_name);
    if (seenActions.has(actionName)) throw new ApiError(`Product Blueprint 命令动作重复: ${actionName}`, 400);
    seenActions.add(actionName);
    return {
      name,
      title: clean(command.title || command.label || name, 100),
      description: clean(command.description || intent, 1000),
      action: actionName,
      inputSchema: normalizeInputSchema(command.inputSchema || command.input_schema),
      handler: {
        type: "agent.intent",
        intent,
      },
    };
  });
}

function normalizeSurfaces(value, pages = {}) {
  const requested = Array.isArray(value) ? value : [];
  const surfaces = requested.slice(0, 32).map((raw, index) => {
    const surface = parseObject(raw);
    const id = moduleKey(surface.id || surface.page || `page-${index + 1}`);
    if (!id) throw new ApiError(`Product Blueprint 页面 ${index + 1} 缺少合法 id`, 400);
    return {
      id,
      title: clean(surface.title || surface.label || id, 100),
      description: clean(surface.description, 1000),
      kind: clean(surface.kind || "page", 40),
      commands: stringList(surface.commands, 30, 80),
    };
  });
  if (surfaces.length) return surfaces;
  return Object.entries(pages || {}).slice(0, 32).map(([id, page]) => ({
    id: moduleKey(id) || id,
    title: clean(page?.title || id, 100),
    description: clean(page?.description, 1000),
    kind: containsAgentWorkspace(page?.layout) ? "workspace" : "page",
    commands: [],
  }));
}

function normalizeStateSchema(value) {
  const raw = parseObject(value);
  const namespaces = parseObject(raw.namespaces);
  return {
    version: Number.isInteger(Number(raw.version)) && Number(raw.version) > 0 ? Number(raw.version) : 1,
    additionalNamespaces: raw.additionalNamespaces !== false,
    namespaces: Object.fromEntries(Object.entries(namespaces).slice(0, 80).map(([namespace, rawNamespace]) => {
      const item = parseObject(rawNamespace);
      return [clean(namespace, 80), {
        additionalKeys: item.additionalKeys !== false,
        keys: Object.fromEntries(Object.entries(parseObject(item.keys)).slice(0, 200).map(([key, schema]) => [
          clean(key, 200),
          normalizeInputSchema(schema),
        ])),
      }];
    }).filter(([namespace]) => Boolean(namespace))),
  };
}

export function normalizeProductBlueprint(value, options = {}) {
  const raw = parseObject(value);
  if (Buffer.byteLength(stableJson(raw)) > MAX_BLUEPRINT_BYTES) {
    throw new ApiError(`Product Blueprint 不能超过 ${MAX_BLUEPRINT_BYTES / 1024}KB`, 400);
  }
  const key = moduleKey(options.moduleKey || raw.product?.id || options.name || options.skill?.name);
  const product = parseObject(raw.product);
  const blueprint = {
    schemaVersion: 1,
    product: {
      id: key,
      name: clean(product.name || options.name || options.skill?.display_name || options.skill?.name || key, 100),
      description: clean(product.description || options.description || options.skill?.description, 1000),
      jobs: stringList(product.jobs || raw.jobs, 30, 300),
    },
    domain: {
      entities: stringList(raw.domain?.entities, 80, 100),
    },
    queries: stringList(raw.queries, 80, 100),
    commands: normalizeCommands(raw.commands),
    events: stringList(raw.events, 80, 100),
    surfaces: normalizeSurfaces(raw.surfaces, options.pages),
    capabilities: stringList(raw.capabilities, 100, 120),
    stateSchema: normalizeStateSchema(raw.stateSchema || raw.state_schema),
    acceptanceTests: stringList(raw.acceptanceTests || raw.acceptance_tests, 100, 500),
  };
  if (!blueprint.product.jobs.length && blueprint.product.description) {
    blueprint.product.jobs = [blueprint.product.description];
  }
  if (blueprint.commands.length && !blueprint.capabilities.includes("yiw.agent.invoke")) {
    blueprint.capabilities.push("yiw.agent.invoke");
  }
  const unknownHostCapabilities = blueprint.capabilities.filter((name) => name.startsWith("yiw.") && !MINIAPP_HOST_CAPABILITIES.has(name));
  if (unknownHostCapabilities.length) {
    throw new ApiError(`Product Blueprint 使用了不支持的宿主能力: ${unknownHostCapabilities.join(", ")}`, 400);
  }
  const commandNames = new Set(blueprint.commands.map((command) => command.name));
  for (const surface of blueprint.surfaces) {
    const unknown = surface.commands.filter((name) => !commandNames.has(name));
    if (unknown.length) throw new ApiError(`页面 ${surface.id} 引用了不存在的命令: ${unknown.join(", ")}`, 400);
  }
  return blueprint;
}

export function compileBlueprintAgentActions(blueprint, { productPermission } = {}) {
  const permission = clean(productPermission, 200);
  return Object.fromEntries((blueprint?.commands || []).map((command) => [command.action, {
    type: "agent.intent",
    command: command.name,
    title: command.title,
    intent: command.handler.intent,
    input_schema: command.inputSchema,
    permission,
  }]));
}

export function compileBlueprintPages(blueprint, { bindingId } = {}) {
  const commandByName = new Map((blueprint?.commands || []).map((command) => [command.name, command]));
  return Object.fromEntries((blueprint?.surfaces || []).map((surface) => {
    if (surface.kind === "workspace" || surface.kind === "agent") {
      return [surface.id, {
        id: surface.id,
        title: surface.title,
        layout: { type: "AgentWorkspace", bindingId },
      }];
    }
    const children = [
      { type: "Heading", level: 1, text: surface.title },
      ...(surface.description ? [{ type: "Text", text: surface.description }] : []),
    ];
    const buttons = surface.commands
      .map((name) => commandByName.get(name))
      .filter((command) => command && !(command.inputSchema?.required || []).length)
      .map((command) => ({
        type: "Button",
        label: command.title,
        onClick: { action: command.action, input: {} },
      }));
    if (buttons.length) children.push({ type: "Toolbar", children: buttons });
    return [surface.id, {
      id: surface.id,
      title: surface.title,
      layout: { type: "Stack", gap: "lg", children },
    }];
  }));
}

export function buildMiniAppPackage({
  blueprint,
  content,
  requirements,
  requirementSources,
  bindingId,
  skillSnapshot,
  skillFingerprint,
  projectId,
} = {}) {
  const normalizedBindingId = clean(bindingId, 200);
  const requirementBundle = normalizeRequirementBundle(requirements, {
    goal: blueprint?.product?.description || blueprint?.product?.name,
    sources: requirementSources,
  });
  const base = {
    packageVersion: MINIAPP_PACKAGE_VERSION,
    runtimeVersion: MINIAPP_RUNTIME_VERSION,
    compilerVersion: MINIAPP_COMPILER_VERSION,
    manifest: structuredClone(content?.manifest || {}),
    requirements: requirementBundle,
    agentExposure: normalizedBindingId ? "published" : "none",
    ...(normalizedBindingId ? {
      agent: {
        role: "primary",
        bindingId: normalizedBindingId,
        projectId: projectId || null,
        approvalPolicy: "ask",
        entryIntents: (blueprint?.commands || []).map((command) => command.title).slice(0, 30),
      },
      skill: {
        name: clean(skillSnapshot?.name, 100),
        runtime: clean(skillSnapshot?.source_runtime || skillSnapshot?.runtime || "prompt", 40),
        fingerprint: clean(skillFingerprint, 100),
        allowedTools: Array.isArray(skillSnapshot?.allowed_tools) ? [...skillSnapshot.allowed_tools] : [],
      },
    } : {}),
    pages: structuredClone(content?.pages || {}),
    commands: structuredClone(blueprint?.commands || []),
    capabilities: {
      version: 1,
      requested: [...(blueprint?.capabilities || [])],
    },
    actions: structuredClone(content?.actions || {}),
    stateSchema: structuredClone(blueprint?.stateSchema || normalizeStateSchema(null)),
    lifecycle: {
      version: 1,
      supported: ["install", "enable", "open", "suspend", "upgrade", "disable", "uninstall"],
    },
    tests: (blueprint?.acceptanceTests || []).map((description, index) => ({
      id: `acceptance-${index + 1}`,
      description,
      type: "agent-product",
    })),
    blueprintChecksum: checksum(blueprint || {}),
    contentChecksum: checksum({
      manifest: content?.manifest || {},
      pages: content?.pages || {},
      actions: content?.actions || {},
    }),
  };
  return { ...base, checksum: checksum(base) };
}

function validateSchemaDefinition(schema, errors, path = "schema", depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push(`${path} 层级超过 ${MAX_SCHEMA_DEPTH}`);
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  if (schema.type && !JSON_SCHEMA_TYPES.has(schema.type)) errors.push(`${path}.type 不支持 ${schema.type}`);
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    errors.push(`${path}.required 必须是字符串数组`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      errors.push(`${path}.properties 必须是对象`);
    } else {
      for (const [key, child] of Object.entries(schema.properties)) validateSchemaDefinition(child, errors, `${path}.properties.${key}`, depth + 1);
    }
  }
  if (schema.items !== undefined) validateSchemaDefinition(schema.items, errors, `${path}.items`, depth + 1);
}

export function validateMiniAppPackage(value, { content, blueprint } = {}) {
  const pkg = parseObject(value, null);
  const errors = [];
  if (!pkg) return { valid: false, errors: ["MiniApp Package 缺失"] };
  if (Number(pkg.packageVersion) !== MINIAPP_PACKAGE_VERSION) errors.push(`只支持 packageVersion=${MINIAPP_PACKAGE_VERSION}`);
  if (String(pkg.runtimeVersion) !== MINIAPP_RUNTIME_VERSION) errors.push(`只支持 runtimeVersion=${MINIAPP_RUNTIME_VERSION}`);
  if (String(pkg.compilerVersion) !== MINIAPP_COMPILER_VERSION) errors.push(`编译器版本不兼容: ${pkg.compilerVersion || "(空)"}`);
  const productBindingId = clean(content?.manifest?.product?.bindingId, 200);
  if (productBindingId && pkg.agent?.bindingId !== productBindingId) {
    errors.push("MiniApp Package 的 Agent bindingId 与 Skill Product 不一致");
  }
  if (!productBindingId && pkg.agentExposure === "none" && pkg.agent?.bindingId) {
    errors.push("普通 MiniApp Package 不应包含 Agent bindingId");
  }
  try {
    const normalizedRequirements = normalizeRequirementBundle(pkg.requirements);
    if (stableJson(normalizedRequirements) !== stableJson(pkg.requirements)) {
      errors.push("MiniApp Package 的 Requirement Bundle 不合法");
    }
  } catch (error) {
    errors.push(error?.message || "MiniApp Package 的 Requirement Bundle 不合法");
  }
  for (const capability of pkg.capabilities?.requested || []) {
    if (String(capability).startsWith("yiw.") && !MINIAPP_HOST_CAPABILITIES.has(capability)) {
      errors.push(`不支持宿主能力 ${capability}`);
    }
  }
  for (const command of pkg.commands || []) {
    validateSchemaDefinition(command.inputSchema, errors, `commands.${command.name}.inputSchema`);
    const action = pkg.actions?.[command.action];
    if (!action || action.type !== "agent.intent" || action.command !== command.name) {
      errors.push(`命令 ${command.name} 没有对应的 agent.intent 动作`);
    }
    if (action?.type === "agent.intent" && !pkg.agent?.bindingId) {
      errors.push(`命令 ${command.name} 尚未发布给 Agent，不能使用 agent.intent`);
    }
  }
  for (const [namespace, config] of Object.entries(pkg.stateSchema?.namespaces || {})) {
    for (const [key, schema] of Object.entries(config?.keys || {})) validateSchemaDefinition(schema, errors, `stateSchema.${namespace}.${key}`);
  }
  const expectedBase = { ...pkg };
  delete expectedBase.checksum;
  if (pkg.checksum !== checksum(expectedBase)) errors.push("MiniApp Package checksum 不匹配");
  if (content) {
    const expectedContent = checksum({ manifest: content.manifest || {}, pages: content.pages || {}, actions: content.actions || {} });
    if (pkg.contentChecksum !== expectedContent) errors.push("MiniApp Package 页面或命令已变化，需要重新编译");
  }
  if (blueprint && pkg.blueprintChecksum !== checksum(blueprint)) errors.push("MiniApp Package Product Blueprint 已变化，需要重新编译");
  return { valid: errors.length === 0, errors };
}

function valueMatchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateJsonValue(value, schema, errors, path = "input", depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) {
    errors.push(`${path} 层级过深`);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => stableJson(item) === stableJson(value))) {
    errors.push(`${path} 不在允许值中`);
    return;
  }
  if (schema.type && !valueMatchesType(value, schema.type)) {
    errors.push(`${path} 应为 ${schema.type}`);
    return;
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} 为必填项`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateJsonValue(child, schema.properties[key], errors, `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} 不允许出现`);
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateJsonValue(item, schema.items, errors, `${path}[${index}]`, depth + 1));
  }
}

export function validateMiniAppCommandInput(input, schema) {
  const errors = [];
  validateJsonValue(input, schema || { type: "object" }, errors);
  return { valid: errors.length === 0, errors };
}

export function assertMiniAppCommandInput(input, schema) {
  const result = validateMiniAppCommandInput(input, schema);
  if (!result.valid) throw new ApiError(`小程序命令输入不符合定义: ${result.errors.join("；")}`, 400);
  return input;
}

export function assertMiniAppStateValue(stateSchema, { namespace = "default", key, value } = {}) {
  const schema = parseObject(stateSchema);
  const namespaces = parseObject(schema.namespaces);
  const namespaceSchema = namespaces[namespace];
  if (!namespaceSchema) {
    if (schema.additionalNamespaces === false) throw new ApiError(`产品数据不允许 namespace ${namespace}`, 400);
    return value;
  }
  const keySchema = parseObject(namespaceSchema.keys)[key];
  if (!keySchema) {
    if (namespaceSchema.additionalKeys === false) throw new ApiError(`产品数据 ${namespace}.${key} 未在 state schema 中声明`, 400);
    return value;
  }
  const result = validateMiniAppCommandInput(value, keySchema);
  if (!result.valid) throw new ApiError(`产品数据 ${namespace}.${key} 不符合 state schema: ${result.errors.join("；")}`, 400);
  return value;
}
