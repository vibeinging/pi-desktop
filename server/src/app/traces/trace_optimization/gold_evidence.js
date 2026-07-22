import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { BusinessDataSources } from "../../../engine/datasources/business_data_sources.js";
import { inspectQueryWorkspace } from "../../../engine/agents/query_workspace_tools.js";
import { assertReadOnlySql } from "../../../engine/tools/readonly_sql.js";
import { array, object, text } from "./common.js";

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_ACTIONS = 4;
const MAX_FILE_CHARS = 600_000;
const MAX_RESULT_CHARS = 12_000;

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value, max = MAX_RESULT_CHARS) {
  const raw = typeof value === "string"
    ? value
    : JSON.stringify(value ?? {}, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
  return raw.length <= max ? raw : `${raw.slice(0, max)}\n...[truncated ${raw.length - max} chars]`;
}

function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
  } catch {
    return String(value ?? "");
  }
}

function unique(values) {
  return [...new Set(values.map((value) => text(value).trim()).filter(Boolean))];
}

function normalizedAnswerValue(value) {
  return compact(value).replace(/\*\*/g, "").toLowerCase();
}

function parseMarkdownAnswerTable(value) {
  const lines = String(value || "").split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const cells = (line) => String(line || "")
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    const header = cells(lines[index]);
    const separator = cells(lines[index + 1]);
    if (!header.length || separator.length !== header.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (!String(lines[rowIndex] || "").includes("|")) break;
      const row = cells(lines[rowIndex]);
      if (!row.length) break;
      rows.push(row.slice(0, header.length));
    }
    if (rows.length) return { header, rows };
  }
  return null;
}

function expectedAnswerShape(value) {
  const table = parseMarkdownAnswerTable(value);
  if (table) {
    return {
      rows: table.rows.map((row) => row.map(normalizedAnswerValue)),
      items: table.rows.flat().map(normalizedAnswerValue).filter(Boolean),
    };
  }
  return {
    rows: [],
    items: String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item && !/^\|?\s*:?-{3,}/.test(item))
    .map((item) => item.includes("|")
      ? item.split("|").map((cell) => cell.trim()).filter(Boolean).join(" | ")
      : item)
    .map(normalizedAnswerValue)
    .filter(Boolean),
  };
}

function rowValues(row) {
  return (Array.isArray(row) ? row : Object.values(object(row))).map(normalizedAnswerValue);
}

function columnSignature(values) {
  const signature = new Map();
  for (const value of values) signature.set(value, (signature.get(value) || 0) + 1);
  return [...signature.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function signaturesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matrixColumns(rows) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_unused, column) => rows.map((row) => row[column] || ""));
}

function matricesMatchByColumns(actualRows, expectedRows) {
  if (!actualRows.length || actualRows.length !== expectedRows.length) return false;
  const actualColumns = matrixColumns(actualRows).map(columnSignature);
  const expectedColumns = matrixColumns(expectedRows).map(columnSignature);
  if (actualColumns.length !== expectedColumns.length) return false;
  const used = new Set();
  return expectedColumns.every((expected) => {
    const index = actualColumns.findIndex((actual, candidate) => !used.has(candidate) && signaturesEqual(actual, expected));
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

function sqlProbeMatchesExpected(probe, expectedShape) {
  const rows = array(object(probe?.result).rows);
  if (expectedShape.rows.length) return matricesMatchByColumns(rows.map(rowValues), expectedShape.rows);
  const expectedItems = expectedShape.items;
  if (!expectedItems.length) return rows.length > 0;
  if (rows.length !== expectedItems.length) return false;
  const usedRows = new Set();
  for (const expected of expectedItems) {
    const rowIndex = rows.findIndex((row, index) => {
      if (usedRows.has(index)) return false;
      const values = Array.isArray(row) ? row : Object.values(object(row));
      return values.some((value) => normalizedAnswerValue(value) === expected);
    });
    if (rowIndex < 0) return false;
    usedRows.add(rowIndex);
  }
  return true;
}

function linkedProbeIds(evidenceSteps = [], crossSourceLinks = []) {
  return new Set(
    [...array(evidenceSteps), ...array(crossSourceLinks)]
      .flatMap((step) => array(object(step).probe_ids || object(step).probeIds))
      .map((probeId) => text(probeId))
      .filter(Boolean),
  );
}

export function validateGoldEvidenceProof({
  expectedAnswer = "",
  evidenceProbeIds = [],
  sourceProbes = [],
  evidenceSteps = [],
  crossSourceLinks = [],
} = {}) {
  const expectedShape = expectedAnswerShape(expectedAnswer);
  const expectedItems = expectedShape.items;
  const valid = new Map(
    array(sourceProbes)
      .filter((probe) => probe?.ok === true && probe?.evidence === true && probe?.probe_id)
      .map((probe) => [text(probe.probe_id), probe]),
  );
  const requested = unique(evidenceProbeIds);
  const missing = requested.filter((probeId) => !valid.has(probeId));
  if (!requested.length || missing.length) {
    return {
      proven: false,
      reason: missing.length
        ? `证据路径引用了未成功执行的探查: ${missing.join(", ")}`
        : "参考解没有引用成功执行的来源探查",
      answer_probe_id: "",
    };
  }
  const selected = requested.map((probeId) => valid.get(probeId)).filter(Boolean);
  const answerProbes = selected.filter((probe) => ["execute_sql", "search_documents", "read_document"].includes(probe.type));
  if (!answerProbes.length) {
    return { proven: false, reason: "只读 Schema 不能证明答案，必须查询数据或读取文档内容", answer_probe_id: "" };
  }

  const sqlProbes = answerProbes.filter((probe) => probe.type === "execute_sql");
  if (sqlProbes.length) {
    const matched = sqlProbes.find((probe) => sqlProbeMatchesExpected(probe, expectedShape));
    if (matched) return { proven: true, reason: "", answer_probe_id: text(matched.probe_id) };

    // 多源任务的最终文本可能来自文档，SQL 只提供对齐键或数值。
    // 至少要求 SQL 真实返回行，且文档证据逐项支持 expected_answer。
    const documentProbes = answerProbes.filter((probe) => probe.type !== "execute_sql");
    const sqlHasRows = sqlProbes.some((probe) => array(object(probe.result).rows).length > 0);
    const documentText = normalizedAnswerValue(documentProbes.map((probe) => JSON.stringify(probe.result ?? {})).join("\n"));
    if (sqlHasRows && documentProbes.length && expectedItems.every((item) => documentText.includes(item))) {
      return { proven: true, reason: "", answer_probe_id: text(documentProbes[documentProbes.length - 1]?.probe_id) };
    }

    // 跨数据库或数据库加文件的题无法用一条 SQL 得到最终行集。此时要求：
    // 1) 至少两个真实来源；2) expected 的每个值都出现在来源结果中；
    // 3) Gold 明确记录这些探查如何关联，不能只靠模型口头猜测。
    const sourceIds = new Set(answerProbes.flatMap((probe) => array(probe.source_refs)
      .map((ref) => text(object(ref).source_id || object(ref).sourceId || object(ref).name))
      .filter(Boolean)));
    const linkedIds = linkedProbeIds(evidenceSteps, crossSourceLinks);
    const linkedAnswerProbes = answerProbes.filter((probe) => linkedIds.has(text(probe.probe_id)));
    const combinedText = normalizedAnswerValue(answerProbes.map((probe) => JSON.stringify(probe.result ?? {})).join("\n"));
    if (
      sourceIds.size >= 2
      && linkedAnswerProbes.length >= 2
      && expectedItems.length
      && expectedItems.every((item) => combinedText.includes(item))
    ) {
      return { proven: true, reason: "", answer_probe_id: text(linkedAnswerProbes.at(-1)?.probe_id) };
    }
    return { proven: false, reason: "已执行 SQL 的最终行集与 expected_answer 不一致", answer_probe_id: "" };
  }

  if (expectedItems.length) {
    const evidenceText = normalizedAnswerValue(answerProbes.map((probe) => JSON.stringify(probe.result ?? {})).join("\n"));
    if (!expectedItems.every((item) => evidenceText.includes(item))) {
      return { proven: false, reason: "文档探查内容不能支持 expected_answer", answer_probe_id: "" };
    }
  }
  return { proven: true, reason: "", answer_probe_id: text(answerProbes[answerProbes.length - 1]?.probe_id) };
}

function normalizeActionType(value) {
  const raw = compact(value).replace(/^source[.:]/i, "").toLowerCase();
  const aliases = {
    list: "inventory",
    list_sources: "inventory",
    schema: "read_schema",
    grep: "search_documents",
    search: "search_documents",
    read: "read_document",
    sql: "execute_sql",
    query: "execute_sql",
  };
  return aliases[raw] || raw;
}

export function normalizeGoldSourceActions(payload, maxActions = DEFAULT_MAX_ACTIONS) {
  const src = object(payload);
  const raw = src.next_source_actions || src.nextSourceActions || src.source_actions || src.sourceActions || src.actions;
  return array(raw)
    .map((item) => {
      const action = object(item);
      return {
        type: normalizeActionType(action.type || action.action || action.tool || action.name),
        source_id: text(action.source_id || action.sourceId),
        document_id: text(action.document_id || action.documentId),
        sql: text(action.sql),
        query: text(action.query || action.pattern),
        line_start: Math.max(1, Number(action.line_start || action.lineStart || 1)),
        line_limit: Math.max(1, Math.min(160, Number(action.line_limit || action.lineLimit || 80))),
        reason: text(action.reason),
      };
    })
    .filter((action) => action.type)
    .slice(0, Math.max(1, Math.min(DEFAULT_MAX_ACTIONS, Number(maxActions || DEFAULT_MAX_ACTIONS))));
}

function inferDocumentModality(document) {
  const ext = text(document.file_ext || document.fileExt).replace(/^\./, "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "document";
  return "text";
}

function publicInventory(workspace = {}) {
  return {
    sources: array(workspace.sources).map((source) => ({
      source_id: text(source.source_id),
      name: text(source.name),
      type: text(source.type),
      dialect: text(source.dialect),
      path: text(source.path),
      raw_status: text(source.raw_status),
      content_status: text(source.content_status),
      note: text(source.note),
    })),
    documents: array(workspace.documents).map((document) => ({
      source_id: text(document.source_id),
      source_name: text(document.source_name),
      document_id: text(document.document_id),
      title: text(document.title),
      description: text(document.description),
      status: text(document.status),
      path: text(document.path),
      file_ext: text(document.file_ext || document.fileExt),
      content_format: text(document.content_format || document.contentFormat),
      modality: text(document.modality) || inferDocumentModality(document),
      error: text(document.error),
    })),
    warnings: array(workspace.warnings).map(String),
  };
}

export async function createGoldSourceContext(ctx, projectId, {
  createDataSources = (pid) => new BusinessDataSources(pid, pid),
  inspectWorkspace = inspectQueryWorkspace,
} = {}) {
  const bds = createDataSources(projectId);
  await bds.load_sources();
  let workspace;
  try {
    workspace = await inspectWorkspace({ projectId, bds, session: null });
  } catch (error) {
    workspace = {
      root: "",
      sources: [...(bds.data_sources?.values?.() || [])].map((source) => ({
        source_id: text(source.id),
        name: text(source.datasource_name || source.name || source.id),
        type: source.source_type === "database_connection" ? "database" : text(source.source_type),
        dialect: text(source.db_type || ""),
        raw_status: source.source_type === "database_connection" ? "queryable" : "registered",
        content_status: "unknown",
      })),
      documents: [],
      warnings: [`项目来源工作区暂不可读: ${error?.message || error}`],
    };
  }
  return {
    ctx,
    projectId,
    bds,
    workspace,
    inventory: publicInventory(workspace),
    sqlAttempts: new Set(),
  };
}

function safeWorkspacePath(root, relativePath) {
  const base = resolve(text(root));
  const candidate = resolve(base, text(relativePath));
  if (!root || !relativePath || isAbsolute(relativePath) || (candidate !== base && !candidate.startsWith(`${base}${sep}`))) {
    throw new Error("来源文件路径不在项目工作区内");
  }
  return candidate;
}

async function readWorkspaceFile(sourceContext, relativePath) {
  const path = safeWorkspacePath(sourceContext.workspace.root, relativePath);
  const content = await readFile(path, "utf8");
  return content.slice(0, MAX_FILE_CHARS);
}

function sourceRef(source, extra = {}) {
  return {
    source_id: text(source?.source_id || source?.id),
    name: text(source?.name || source?.source_name || source?.datasource_name),
    source_type: text(source?.type || source?.source_type),
    modality: text(source?.modality),
    ...extra,
  };
}

function failedProbe(probeId, action, error, extra = {}) {
  return {
    probe_id: probeId,
    type: action.type,
    ok: false,
    evidence: false,
    action,
    source_refs: [],
    locator: {},
    result: null,
    error: text(error?.message || error || "来源探查失败"),
    ...extra,
  };
}

export async function executeGoldSourceAction(sourceContext, action, probeId) {
  const inventory = sourceContext.inventory;
  try {
    if (action.type === "inventory") {
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: false,
        action,
        source_refs: [],
        locator: {},
        result: inventory,
        error: "",
      };
    }

    if (action.type === "read_schema") {
      const source = inventory.sources.find((item) => item.source_id === action.source_id);
      if (!source) return failedProbe(probeId, action, "source_id 不存在");
      if (!source.path) return failedProbe(probeId, action, "该数据源没有可读取的 Schema 文件");
      const content = await readWorkspaceFile(sourceContext, source.path);
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: true,
        action,
        source_refs: [sourceRef(source, { source_type: "database", location: source.path })],
        locator: { source_id: source.source_id, path: source.path },
        result: { schema: clip(content) },
        error: "",
      };
    }

    if (action.type === "execute_sql") {
      const sql = assertReadOnlySql(action.sql);
      const source = sourceContext.bds.get_data_source?.(action.source_id);
      if (!source || source.source_type !== "database_connection") {
        return failedProbe(probeId, action, "source_id 无效或不是可查询数据库");
      }
      const sqlKey = `${action.source_id}:${sql.replace(/\s+/g, " ").trim().toLowerCase()}`;
      sourceContext.sqlAttempts ||= new Set();
      if (sourceContext.sqlAttempts.has(sqlKey)) return failedProbe(probeId, action, "这条 SQL 已执行过，请根据结果调整探查");
      if (sourceContext.sqlAttempts.size >= 8) return failedProbe(probeId, action, "只读 SQL 探查次数已达到上限(8)");
      sourceContext.sqlAttempts.add(sqlKey);
      const result = await source.query(sql, {
        project_id: sourceContext.projectId,
        business_data_sources: sourceContext.bds,
      });
      if (!result?.success) return failedProbe(probeId, action, result?.message || "SQL 查询失败");
      const rows = jsonSafe(array(result.data).slice(0, 80));
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: true,
        action,
        source_refs: [sourceRef(source, { source_type: "database", modality: "structured" })],
        locator: { source_id: action.source_id, sql },
        result: {
          columns: jsonSafe(array(result.columns)),
          rows,
          row_count: Number(result.row_count ?? result.data?.length ?? rows.length),
          truncated: array(result.data).length > rows.length,
        },
        error: "",
      };
    }

    if (action.type === "search_documents") {
      const query = compact(action.query);
      if (!query) return failedProbe(probeId, action, "文档查找词不能为空");
      const documents = inventory.documents.filter((document) => !action.source_id || document.source_id === action.source_id);
      const matches = [];
      for (const document of documents.slice(0, 40)) {
        if (document.status !== "ready" || !document.path) continue;
        const content = await readWorkspaceFile(sourceContext, document.path).catch(() => "");
        if (!content) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < 40; index += 1) {
          if (!lines[index].toLowerCase().includes(query.toLowerCase())) continue;
          matches.push({
            document_id: document.document_id,
            title: document.title,
            path: document.path,
            line: index + 1,
            text: lines.slice(Math.max(0, index - 1), index + 2).join("\n").slice(0, 1200),
          });
        }
      }
      if (!matches.length) return failedProbe(probeId, action, `没有在可读 Markdown 中找到「${query}」`);
      const matchedDocs = unique(matches.map((item) => item.document_id))
        .map((id) => inventory.documents.find((item) => item.document_id === id))
        .filter(Boolean);
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: true,
        action,
        source_refs: matchedDocs.map((document) => sourceRef(document, {
          source_type: "document",
          modality: document.modality,
          location: document.path,
          document_id: document.document_id,
        })),
        locator: { source_id: action.source_id, query, matches: matches.map((item) => ({ document_id: item.document_id, line: item.line })) },
        result: { matches },
        error: "",
      };
    }

    if (action.type === "read_document") {
      const document = inventory.documents.find((item) => item.document_id === action.document_id);
      if (!document) return failedProbe(probeId, action, "document_id 不存在");
      if (document.status !== "ready" || !document.path) {
        return failedProbe(probeId, action, document.error || "文档尚无可读取的 Markdown", { failure_type: "source_parsing" });
      }
      const content = await readWorkspaceFile(sourceContext, document.path);
      const lines = content.split(/\r?\n/);
      const start = Math.min(lines.length, Math.max(1, action.line_start));
      const end = Math.min(lines.length, start - 1 + action.line_limit);
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: true,
        action,
        source_refs: [sourceRef(document, {
          source_type: "document",
          modality: document.modality,
          location: document.path,
          document_id: document.document_id,
        })],
        locator: { source_id: document.source_id, document_id: document.document_id, path: document.path, line_start: start, line_end: end },
        result: { text: lines.slice(start - 1, end).join("\n"), line_start: start, line_end: end, total_lines: lines.length },
        error: "",
      };
    }

    return failedProbe(probeId, action, `不支持的来源探查动作: ${action.type || "unknown"}`);
  } catch (error) {
    return failedProbe(probeId, action, error);
  }
}

function isFinalGold(payload) {
  const src = object(payload);
  return src.final === true || src.status === "final" || Boolean(
    src.evidence_path || src.evidencePath || src.evidence_probe_ids || src.evidenceProbeIds || src.output_shape || src.outputShape,
  );
}

function goldLoopInput(baseInput, { round, maxRounds, inventory, probes }) {
  return {
    ...baseInput,
    source_evidence: {
      round,
      max_rounds: maxRounds,
      allowed_actions: ["read_schema", "execute_sql", "search_documents", "read_document"],
      inventory,
      probes,
      instruction: [
        "先独立读取原始来源，再形成正确解法；当前输入不包含错误回答和 Trace。",
        "证据不足时只输出 next_source_actions。",
        "只读 Schema 不能完成参考解；结构化数据必须执行最终 SQL，其返回行集必须与 expected_answer 一致。",
        "完成后输出 sources、steps、cross_source_links、output_shape、evidence_probe_ids 和兼容字段。",
        "evidence_probe_ids 只能引用 probes 中 ok=true 且 evidence=true 的 probe_id。",
      ].join("\n"),
    },
  };
}

export async function runGoldEvidenceLoop({
  baseInput,
  inventory,
  runStep,
  executeAction,
  maxRounds = DEFAULT_MAX_ROUNDS,
  maxActionsPerRound = DEFAULT_MAX_ACTIONS,
} = {}) {
  const probes = [];
  let lastResult = null;
  let probeIndex = 0;
  const rounds = Math.max(1, Number(maxRounds || DEFAULT_MAX_ROUNDS));
  for (let round = 1; round <= rounds; round += 1) {
    const result = await runStep(goldLoopInput(baseInput, { round, maxRounds: rounds, inventory, probes }));
    const data = object(result?.data || result);
    lastResult = result;
    const actions = normalizeGoldSourceActions(data, maxActionsPerRound);
    if (isFinalGold(data)) {
      try {
        const normalized = normalizeGoldEvidencePayload(data, probes, baseInput);
        if (normalized.evidence_status === "proven") {
          return { skill: result?.skill, data, probes, rounds: round };
        }
        probes.push({
          probe_id: `validation_${round}`,
          type: "evidence_validation",
          ok: false,
          evidence: false,
          action: {},
          source_refs: [],
          locator: {},
          result: null,
          error: normalized.warnings.at(-1) || "参考解证据不能支持 expected_answer",
        });
      } catch (error) {
        probes.push({
          probe_id: `validation_${round}`,
          type: "evidence_validation",
          ok: false,
          evidence: false,
          action: {},
          source_refs: [],
          locator: {},
          result: null,
          error: text(error?.message || error),
        });
      }
      continue;
    }
    if (!actions.length) {
      return { skill: result?.skill, data, probes, rounds: round };
    }
    for (const action of actions) {
      probeIndex += 1;
      probes.push(await executeAction(action, `probe_${probeIndex}`));
    }
  }
  return {
    skill: lastResult?.skill,
    data: object(lastResult?.data || lastResult),
    probes,
    rounds,
    warnings: ["来源探查达到轮数上限，参考解可能不完整。"],
  };
}

function normalizePathStep(item, index) {
  if (typeof item === "string") return { id: `step_${index + 1}`, type: "process", description: item, probe_ids: [] };
  const row = object(item);
  return {
    id: text(row.id || `step_${index + 1}`),
    type: text(row.type || row.operation || "process"),
    description: text(row.description || row.detail || row.operation || row.summary),
    probe_ids: unique(array(row.probe_ids || row.probeIds)),
  };
}

function normalizeSource(item, index) {
  if (typeof item === "string") {
    return { id: `source_${index + 1}`, source_id: "", name: item, source_type: "unknown", modality: "", location: {}, purpose: "", probe_ids: [] };
  }
  const row = object(item);
  return {
    id: text(row.id || `source_${index + 1}`),
    source_id: text(row.source_id || row.sourceId),
    name: text(row.name || row.title || row.source_name || row.sourceName),
    source_type: text(row.source_type || row.sourceType || row.type || "unknown"),
    modality: text(row.modality),
    location: object(row.location || row.locator),
    purpose: text(row.purpose || row.usage),
    probe_ids: unique(array(row.probe_ids || row.probeIds)),
  };
}

function inferredSources(probes) {
  const rows = [];
  for (const probe of probes) {
    for (const ref of array(probe.source_refs)) {
      const row = normalizeSource({
        ...ref,
        location: probe.locator,
        probe_ids: [probe.probe_id],
      }, rows.length);
      const existing = rows.find((item) => item.source_id && item.source_id === row.source_id && item.name === row.name);
      if (existing) existing.probe_ids = unique([...existing.probe_ids, ...row.probe_ids]);
      else rows.push(row);
    }
  }
  return rows;
}

export function normalizeGoldEvidencePayload(payload, probes = [], fallback = {}) {
  const src = object(payload);
  const evidenceProbes = array(probes).filter((probe) => probe?.ok && probe?.evidence && probe?.probe_id);
  const byId = new Map(evidenceProbes.map((probe) => [text(probe.probe_id), probe]));
  let sources = array(src.sources).map(normalizeSource);
  const steps = array(src.steps || src.reference_steps || src.referenceSteps).map(normalizePathStep);
  let requestedIds = unique([
    ...array(src.evidence_probe_ids || src.evidenceProbeIds),
    ...sources.flatMap((source) => source.probe_ids),
    ...steps.flatMap((step) => step.probe_ids),
  ]);
  if (!requestedIds.length && evidenceProbes.length) requestedIds = evidenceProbes.map((probe) => text(probe.probe_id));
  const missingIds = requestedIds.filter((id) => !byId.has(id));
  if (missingIds.length) throw new Error(`证据路径引用了未成功执行的探查: ${missingIds.join(", ")}`);
  const selectedProbes = requestedIds.map((id) => byId.get(id)).filter(Boolean);
  const crossSourceLinks = array(src.cross_source_links || src.crossSourceLinks).map((item, index) => normalizePathStep(item, index));
  const proof = validateGoldEvidenceProof({
    expectedAnswer: fallback.expected_answer,
    evidenceProbeIds: requestedIds,
    sourceProbes: probes,
    evidenceSteps: steps,
    crossSourceLinks,
  });
  const inferred = inferredSources(selectedProbes);
  if (!sources.length) sources = inferred;
  else {
    for (const source of sources) {
      const match = inferred.find((item) => item.source_id && item.source_id === source.source_id)
        || inferred.find((item) => item.name && item.name === source.name);
      if (match) {
        source.probe_ids = unique([...source.probe_ids, ...match.probe_ids]);
        if (!source.modality) source.modality = match.modality;
        if (!Object.keys(source.location).length) source.location = match.location;
      }
    }
    for (const item of inferred) {
      if (!sources.some((source) => source.source_id && source.source_id === item.source_id && source.name === item.name)) sources.push(item);
    }
  }
  const warnings = unique([
    ...array(src.warnings),
    ...(proof.proven ? [] : [proof.reason || "没有真实来源探查支持当前参考解，必须人工补充证据后再确认。"]),
  ]);
  const outputShapeRaw = src.output_shape || src.outputShape;
  const outputShape = typeof outputShapeRaw === "string" ? { description: outputShapeRaw } : object(outputShapeRaw);
  const referenceSteps = array(src.reference_steps || src.referenceSteps).map(String);
  const sqlProbe = selectedProbes.find((probe) => text(probe.probe_id) === proof.answer_probe_id && probe.type === "execute_sql")
    || selectedProbes.find((probe) => probe.type === "execute_sql");
  return {
    question: text(fallback.question),
    expected_behavior: text(fallback.expected_behavior),
    expected_answer: text(fallback.expected_answer),
    intent_summary: text(src.intent_summary || src.intentSummary),
    sources,
    steps,
    cross_source_links: crossSourceLinks,
    output_shape: outputShape,
    evidence_probe_ids: requestedIds,
    source_probes: array(probes),
    evidence_status: proof.proven ? "proven" : "unproven",
    data_sources: array(src.data_sources || src.dataSources).map(String).length
      ? array(src.data_sources || src.dataSources).map(String)
      : sources.map((source) => source.name || source.source_id).filter(Boolean),
    filters: object(src.filters),
    metric_definition: text(src.metric_definition || src.metricDefinition),
    reference_steps: referenceSteps.length ? referenceSteps : steps.map((step) => step.description).filter(Boolean),
    reference_sql: text(sqlProbe?.action?.sql || src.reference_sql || src.referenceSql),
    intermediate_expectations: array(src.intermediate_expectations || src.intermediateExpectations),
    final_answer_contract: text(src.final_answer_contract || src.finalAnswerContract || outputShape.description),
    trace_diff_summary: "",
    warnings,
    assumptions: array(src.assumptions).map(String),
    status: "drafted",
  };
}

export default {
  createGoldSourceContext,
  executeGoldSourceAction,
  normalizeGoldSourceActions,
  normalizeGoldEvidencePayload,
  runGoldEvidenceLoop,
};
