// L1 应用/用例层 — 表/列元数据维护 + 离线内容准备。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:tables 删/改/high-recall / columns 改 / 批量列改 /
//       batch_sync_example_values / generate-columns-descriptions / relationships /
//       entity_mapping_configs(GET/POST)
//
// 注:app/datasource/ 比 routes/ 深一层 → engine 用 ../../。
import { PluginRegistry } from "../../engine/datasources/plugins/index.js";
import { populateExampleValues } from "../../engine/semantic/schema_enrichment_service.js";
import { generateColumnsDescriptions } from "../../engine/semantic/column_description.js";
import { generateTableDescriptions } from "../../engine/semantic/table_description.js";
import { SchemaRetrievalService } from "../../engine/semantic/schema_retrieval_service.js";
import { DatabaseEntityService } from "../../engine/semantic/entity_service.js";
import { DatabaseDataSource } from "../../engine/datasources/database_data_source.js";
import { ApiError } from "../../errors.js";
import { writeSchemaSnapshot } from "../../engine/semantic/schema_file_service.js";

// plugin 配置塑形(连接信息子集)
const pluginConfig = (o) => ({
  db_type: o.db_type, host: o.host, port: o.port,
  username: o.username, password: o.password, database: o.database,
});

// DELETE /api/projects/:pid/databases/:cid/tables/:tid — 删除缓存表(软删除)
export async function deleteTable(ctx, input) {
  const { pid, cid, tid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM table_metadata WHERE id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`,
    [tid, cid],
  );
  if (!existing) throw new ApiError("表不存在", 404);
  await ctx.query(`UPDATE table_metadata SET deleted_at=now() WHERE id=$1`, [tid]);
  await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: cid });
  return { data: null, message: "删除表成功" };
}

// PUT /api/projects/:pid/databases/:cid/tables/:tid — 更新表描述
export async function updateTable(ctx, input) {
  const { pid, cid, tid } = input.params;
  const { description, keywords } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM table_metadata WHERE id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`,
    [tid, cid],
  );
  if (!existing) throw new ApiError("表不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }
  if (keywords !== undefined)    { sets.push(`keywords=$${i++}`); vals.push(keywords); }

  if (sets.length > 1) {
    vals.push(tid);
    await ctx.query(`UPDATE table_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals);
  }
  await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: cid });

  const row = await ctx.queryOne(
    `SELECT id, database_connection_id, schema_name, table_name, table_type,
            description, keywords, row_count, is_view, is_high_recall, created_at, updated_at
       FROM table_metadata WHERE id=$1`,
    [tid],
  );
  return { data: row, message: "更新表描述成功" };
}

// PUT /api/projects/:pid/databases/:cid/tables/:tid/high-recall — 更新表高召回
export async function updateTableHighRecall(ctx, input) {
  const { cid, tid } = input.params;
  const { is_high_recall } = input.body || {};
  if (is_high_recall === undefined) throw new ApiError("is_high_recall 为必填项", 400);

  const existing = await ctx.queryOne(
    `SELECT id FROM table_metadata WHERE id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`,
    [tid, cid],
  );
  if (!existing) throw new ApiError("表不存在", 404);

  await ctx.query(
    `UPDATE table_metadata SET is_high_recall=$1, updated_at=now() WHERE id=$2`,
    [!!is_high_recall, tid],
  );
  return { data: { id: tid, is_high_recall: !!is_high_recall }, message: "更新表高召回成功" };
}

// PUT /api/projects/:pid/databases/:cid/columns/:colid — 更新单列描述/高召回/示例值
export async function updateColumn(ctx, input) {
  const { pid, cid, colid } = input.params;
  const { description, is_high_recall, example_values, enum_mappings } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT c.id FROM column_metadata c JOIN table_metadata t ON c.table_id=t.id
      WHERE c.id=$1 AND t.database_connection_id=$2
        AND c.deleted_at IS NULL AND t.deleted_at IS NULL`,
    [colid, cid],
  );
  if (!existing) throw new ApiError("列不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (description !== undefined)   { sets.push(`description=$${i++}`); vals.push(description); }
  if (is_high_recall !== null && is_high_recall !== undefined) {
    sets.push(`is_high_recall=$${i++}`); vals.push(!!is_high_recall);
  }
  if (example_values !== null && example_values !== undefined) {
    sets.push(`example_values=$${i++}`); vals.push(JSON.stringify(example_values));
  }
  if (enum_mappings !== null && enum_mappings !== undefined && enum_mappings !== "") {
    // column_metadata 有 enum_mappings 列:持久化码值映射(对象→JSON 文本;字符串原样存)。
    const em = typeof enum_mappings === "string" ? enum_mappings : JSON.stringify(enum_mappings);
    sets.push(`enum_mappings=$${i++}`); vals.push(em);
  }

  if (sets.length > 1) {
    vals.push(colid);
    await ctx.query(`UPDATE column_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals);
  }
  await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: cid });

  const row = await ctx.queryOne(
    `SELECT id, table_id, column_name, data_type, is_nullable, is_primary_key,
            description, keywords, example_values, is_high_recall, created_at, updated_at
       FROM column_metadata WHERE id=$1`,
    [colid],
  );
  return { data: row, message: "更新列描述成功" };
}

// PUT /api/projects/:pid/databases/:cid/tables/:tid/columns — 批量更新列
export async function updateColumnsBatch(ctx, input) {
  const { pid, cid } = input.params;
  const { columns } = input.body || {};
  if (!Array.isArray(columns)) throw new ApiError("columns 必须为数组", 400);

  const requestedIds = columns.map((column) => column?.column_id).filter(Boolean);
  const existingColumns = requestedIds.length
    ? await ctx.query(
        `SELECT c.id FROM column_metadata c JOIN table_metadata t ON c.table_id=t.id
          WHERE t.database_connection_id=$1 AND c.id::text = ANY($2::text[])
            AND c.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [cid, requestedIds],
      )
    : [];
  const allowedColumnIds = new Set(existingColumns.map((column) => column.id));

  const updated = [];
  for (const col of columns) {
    const { column_id, description, keywords, is_high_recall } = col;
    if (!column_id || !allowedColumnIds.has(column_id)) continue;
    const sets = ["updated_at=now()"];
    const vals = [];
    let i = 1;
    if (description !== undefined)   { sets.push(`description=$${i++}`); vals.push(description); }
    if (keywords !== undefined)      { sets.push(`keywords=$${i++}`); vals.push(keywords); }
    if (is_high_recall !== undefined && is_high_recall !== null) {
      sets.push(`is_high_recall=$${i++}`); vals.push(!!is_high_recall);
    }
    if (sets.length > 1) {
      vals.push(column_id);
      await ctx.query(`UPDATE column_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals);
    }
    updated.push(column_id);
  }
  if (updated.length) await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: cid });
  return { data: { updated_count: updated.length, updated_ids: updated }, message: "批量更新列成功" };
}

// POST .../databases/:cid/tables/batch_sync_example_values — 离线采样列示例值。
export async function batchSyncExampleValues(ctx, input) {
  const { pid, cid } = input.params;
  const limit = Number(input.body?.limit) > 0 ? Number(input.body.limit) : 3;
  const conn = await ctx.queryOne(
    `SELECT id, db_type, host, port, username, password, database FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!conn) throw new ApiError("数据库连接不存在", 404);
  const plugin = PluginRegistry.get(conn.db_type);
  if (!plugin) throw new ApiError(`暂不支持的数据库类型: ${conn.db_type}`, 400);
  const r = await populateExampleValues(cid, plugin, pluginConfig(conn), { limit, onlyEmpty: false });
  const snapshot = await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: cid, connection: conn });
  r.schema_file = snapshot.path;
  return { data: r, message: "示例值同步完成" };
}

export async function syncTableExampleValues(ctx, input) {
  const tableId = input.params?.tid;
  input.body = { ...(input.body || {}), table_ids: tableId ? [tableId] : undefined };
  return batchSyncExampleValues(ctx, input);
}

// POST .../databases/generate-columns-descriptions — LLM 生成列描述 + 表描述(迁移补全)。
// body: { connection_id, table_ids?, only_pending?, extra_notes? }
export async function generateColumnsDescriptionsUseCase(ctx, input) {
  const { pid } = input.params;
  const connId = input.body?.connection_id || input.body?.cid;
  if (!connId) throw new ApiError("connection_id 为必填项", 400);
  const tableIds = Array.isArray(input.body?.table_ids) ? input.body.table_ids : null;
  const onlyEmpty = input.body?.only_pending !== false;
  const extraNotes = input.body?.extra_notes || null;
  try {
    const cols = await generateColumnsDescriptions(connId, { projectId: pid, tableIds, onlyEmpty, extraNotes });
    const tbls = await generateTableDescriptions(connId, { projectId: pid, tableIds, onlyEmpty });
    await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: connId });
    return {
      data: {
        generated: cols.columns || 0,
        columns: cols.columns || 0,
        tables: tbls.tables || 0,
        columns_generated: cols.columns || 0,
        tables_generated: tbls.tables || 0,
      },
      message: "列/表描述生成完成",
    };
  } catch (e) {
    throw new ApiError("描述生成失败: " + (e?.message || String(e)), 500);
  }
}

// POST .../databases/generate-table-description — 单表描述生成兼容入口。
export async function generateTableDescriptionUseCase(ctx, input) {
  const { pid } = input.params;
  const connId = input.body?.connection_id || input.body?.cid;
  const tableId = input.body?.table_id;
  if (!connId || !tableId) throw new ApiError("connection_id 和 table_id 为必填项", 400);
  const tableIds = [tableId];
  const onlyEmpty = input.body?.only_pending !== false;
  const extraNotes = input.body?.extra_notes || null;
  try {
    const cols = await generateColumnsDescriptions(connId, { projectId: pid, tableIds, onlyEmpty, extraNotes });
    const tbls = await generateTableDescriptions(connId, { projectId: pid, tableIds, onlyEmpty });
    const table = await ctx.queryOne(
      `SELECT id, description FROM table_metadata WHERE id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`,
      [tableId, connId],
    ).catch(() => null);
    await writeSchemaSnapshot(ctx, { projectId: pid, connectionId: connId });
    return {
      data: {
        columns_generated: cols.columns || 0,
        table_description_generated: tbls.tables || 0,
        table_description: table?.description || "",
      },
      message: "表描述生成完成",
    };
  } catch (e) {
    throw new ApiError("表描述生成失败: " + (e?.message || String(e)), 500);
  }
}

export async function generateDatabaseDescription(ctx, input) {
  const { pid, cid } = input.params;
  const conn = await ctx.queryOne(
    `SELECT id, name, db_type, database AS db_name, description
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  ).catch(() => null);
  if (!conn) throw new ApiError("数据库连接不存在", 404);
  const tables = await ctx.query(
    `SELECT schema_name, table_name, description, row_count
       FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name
      LIMIT 20`,
    [cid],
  ).catch(() => []);
  const described = tables.filter((table) => table.description && String(table.description).trim()).length;
  const tableSummary = tables.slice(0, 8).map((table) => {
    const name = table.schema_name && table.schema_name !== "default"
      ? `${table.schema_name}.${table.table_name}`
      : table.table_name;
    return table.description ? `${name}: ${table.description}` : name;
  }).join("；");
  const description = [
    `${conn.name || conn.db_name || "数据库"} 是一个 ${conn.db_type || "数据库"} 数据源。`,
    `当前已同步 ${tables.length} 张表，其中 ${described} 张表已有业务描述。`,
    tableSummary ? `主要表包括：${tableSummary}。` : "",
  ].filter(Boolean).join("");
  return { data: { connection_id: cid, description }, message: "数据库描述生成完成" };
}

export async function searchRelevantTables(ctx, input) {
  const { pid, cid } = input.params;
  const question = input.body?.question || input.body?.query || "";
  if (!String(question).trim()) throw new ApiError("question 不能为空", 400);
  const limit = Number(input.body?.limit || input.body?.top_k || 5);
  const items = await SchemaRetrievalService.search_relevant_tables_with_columns(
    { query: ctx.query, queryOne: ctx.queryOne },
    cid,
    String(question),
    { project_id: pid, limit },
  );
  return { data: { items, count: items.length }, message: "召回完成" };
}

function isReadOnlySql(sql) {
  const text = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!text) return false;
  if (!/^(select|with|pragma)\b/i.test(text)) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|replace|merge|attach|detach|copy|vacuum)\b/i.test(text);
}

export async function executeMetadataQuery(ctx, input) {
  const { pid, cid } = input.params;
  const sql = String(input.body?.sql || "").trim();
  if (!isReadOnlySql(sql)) throw new ApiError("仅支持只读 SELECT/WITH 查询", 400);
  const limit = Math.min(1000, Math.max(1, Number(input.body?.limit || 200)));
  const started = Date.now();
  const ds = new DatabaseDataSource(null, pid, cid);
  const result = await ds.query(sql, { project_id: pid });
  const rows = (result.data || []).slice(0, limit);
  return {
    data: {
      success: result.success,
      columns: result.columns || (rows.length ? Object.keys(rows[0]) : []),
      rows,
      row_count: result.row_count ?? rows.length,
      cost_time: Date.now() - started,
      error: result.success ? null : result.message,
    },
    message: result.success ? "查询完成" : "查询失败",
  };
}

export async function clearSyncPending(_ctx, _input) {
  return { data: { cleared: true }, message: "已清除待处理状态" };
}

// POST .../databases/:cid/relationships — 创建表间外键关系(best-effort;失败不阻断 eval)。
export async function createRelationship(ctx, input) {
  const { cid } = input.params;
  const { source_table_id, target_table_id, source_column, target_column, relationship_type, description, constraint_name } = input.body || {};
  try {
    const id = crypto.randomUUID();
    await ctx.query(
      `INSERT INTO relationship_metadata
         (id, database_connection_id, source_table_id, target_table_id, source_column, target_column,
          relationship_type, constraint_name, description, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
      [
        id, cid, source_table_id || null, target_table_id || null,
        source_column || null, target_column || null, relationship_type || "many_to_one",
        constraint_name || null, description || null,
      ],
    );
    return { data: { id }, message: "创建关系成功" };
  } catch (e) {
    return { data: { id: null, warning: "关系创建跳过: " + (e?.message || String(e)) }, message: "关系创建跳过" };
  }
}

export async function updateRelationship(ctx, input) {
  const { cid, rid } = input.params;
  const {
    source_table_id, target_table_id, source_column, target_column,
    relationship_type, description, constraint_name,
  } = input.body || {};
  const existing = await ctx.queryOne(
    `SELECT id FROM relationship_metadata WHERE id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`,
    [rid, cid],
  ).catch(() => null);
  if (!existing) throw new ApiError("关系不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };
  if (source_table_id !== undefined) push("source_table_id", source_table_id || null);
  if (target_table_id !== undefined) push("target_table_id", target_table_id || null);
  if (source_column !== undefined) push("source_column", source_column || null);
  if (target_column !== undefined) push("target_column", target_column || null);
  if (relationship_type !== undefined) push("relationship_type", relationship_type || "many_to_one");
  if (description !== undefined) push("description", description || null);
  if (constraint_name !== undefined) push("constraint_name", constraint_name || null);
  vals.push(rid, cid);
  await ctx.query(
    `UPDATE relationship_metadata SET ${sets.join(",")} WHERE id=$${i} AND database_connection_id=$${i + 1}`,
    vals,
  );
  return { data: { id: rid }, message: "更新关系成功" };
}

export async function deleteRelationship(ctx, input) {
  const { cid, rid } = input.params;
  await ctx.query(
    `UPDATE relationship_metadata SET deleted_at=now(), updated_at=now()
      WHERE id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`,
    [rid, cid],
  );
  return { data: { id: rid }, message: "删除关系成功" };
}

function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[_\-\s]/g, "");
}

function singular(name) {
  const n = normalizeName(name);
  if (n.endsWith("ies")) return n.slice(0, -3) + "y";
  if (n.endsWith("s")) return n.slice(0, -1);
  return n;
}

async function buildRelationshipCandidates(ctx, cid) {
  const tables = await ctx.query(
    `SELECT id, schema_name, table_name FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [cid],
  ).catch(() => []);
  const columns = await ctx.query(
    `SELECT c.table_id, c.column_name, c.is_primary_key
       FROM column_metadata c
       JOIN table_metadata t ON t.id = c.table_id
      WHERE t.database_connection_id=$1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL`,
    [cid],
  ).catch(() => []);
  const existing = await ctx.query(
    `SELECT source_table_id, target_table_id, source_column, target_column
       FROM relationship_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [cid],
  ).catch(() => []);
  const existingKeys = new Set(existing.map((r) => `${r.source_table_id}:${r.source_column}->${r.target_table_id}:${r.target_column}`));
  const byTable = new Map(tables.map((table) => [table.id, { ...table, columns: [] }]));
  for (const col of columns) {
    const table = byTable.get(col.table_id);
    if (table) table.columns.push(col);
  }

  const tableByName = new Map();
  for (const table of tables) {
    tableByName.set(normalizeName(table.table_name), table);
    tableByName.set(singular(table.table_name), table);
  }

  const candidates = [];
  for (const table of byTable.values()) {
    for (const col of table.columns) {
      const colName = String(col.column_name || "");
      if (!/_?id$/i.test(colName) || /^id$/i.test(colName)) continue;
      const base = colName.replace(/_?id$/i, "");
      const target = tableByName.get(normalizeName(base)) || tableByName.get(singular(base));
      if (!target || target.id === table.id) continue;
      const targetTable = byTable.get(target.id);
      const targetPk = targetTable?.columns?.find((c) => c.is_primary_key) || targetTable?.columns?.find((c) => /^id$/i.test(c.column_name));
      const targetColumn = targetPk?.column_name || "id";
      const key = `${table.id}:${colName}->${target.id}:${targetColumn}`;
      if (existingKeys.has(key)) continue;
      candidates.push({
        source_table_id: table.id,
        target_table_id: target.id,
        source_table_name: table.table_name,
        target_table_name: target.table_name,
        source_column: colName,
        target_column: targetColumn,
        relationship_type: "many_to_one",
        score: 0.78,
        reasoning: `${colName} 看起来指向 ${target.table_name}.${targetColumn}`,
        signals: { name_pattern: `${colName} -> ${target.table_name}` },
      });
    }
  }
  return candidates;
}

export async function discoverRelationships(ctx, input) {
  const { cid } = input.params;
  const candidates = await buildRelationshipCandidates(ctx, cid);
  return {
    data: {
      candidates,
      stats: { total_analyzed: candidates.length, new_candidates: candidates.length, already_existing: 0, low_score_filtered: 0 },
      skipped_existing: [],
      skipped_low_score: [],
    },
    message: "关系发现完成",
  };
}

export async function batchCreateRelationships(ctx, input) {
  const candidates = Array.isArray(input.body?.candidates) ? input.body.candidates : [];
  let created = 0;
  const results = [];
  for (const candidate of candidates) {
    const res = await createRelationship(ctx, { ...input, body: candidate });
    if (res?.data?.id) created++;
    results.push(res?.data || null);
  }
  return { data: { created, results }, message: "批量创建关系完成" };
}

export async function aiSuggestRelationships(ctx, input) {
  const candidates = await buildRelationshipCandidates(ctx, input.params.cid);
  const hint = String(input.body?.hint || "").toLowerCase();
  const suggestions = hint
    ? candidates.filter((c) => {
        const text = `${c.source_table_name} ${c.target_table_name} ${c.source_column} ${c.target_column}`.toLowerCase();
        return hint.split(/\s+/).filter(Boolean).some((token) => text.includes(token));
      })
    : candidates;
  return { data: { suggestions: suggestions.slice(0, 20) }, message: "关系建议完成" };
}

// ── 数据源级实体映射配置(迁移对齐:列值实体抽取,消歧基础)──
// GET .../databases/:cid/entity_mapping_configs — 列出实体配置(含 entity_count/vector_count)
export async function listEntityMappingConfigs(ctx, input) {
  const { pid, cid } = input.params;
  const tableName = input.query?.table_name || null;
  try {
    const items = await DatabaseEntityService.get_entity_mapping_configs({ query: ctx.query, queryOne: ctx.queryOne }, cid, pid, tableName);
    const list = items || [];
    return { data: { items: list, total: list.length }, message: "获取实体配置成功" };
  } catch (e) {
    throw new ApiError("获取实体配置失败: " + (e?.message || String(e)), 500);
  }
}

// POST .../databases/:cid/entity_mapping_configs — 离线抽取某列的值实体。
export async function createEntityMappingConfig(ctx, input) {
  const { pid, cid } = input.params;
  const { table_id, column_name, metadata_fields, rule, business_id } = input.body || {};
  if (!table_id || !column_name) throw new ApiError("table_id 和 column_name 为必填项", 400);
  try {
    // 注入 dataSource:抽取需读目标库 distinct 值(_fetch_distinct_values 依赖它)。
    const dataSource = new DatabaseDataSource(business_id || null, pid, cid);
    const svcCtx = { query: ctx.query, queryOne: ctx.queryOne, dataSource };
    const result = await DatabaseEntityService.extract_column_value_entities(
      svcCtx, cid, "database", table_id, column_name, pid, { metadata_fields, rule, business_id },
    );
    return { data: result, message: result?.message || "实体抽取完成" };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("实体抽取失败: " + (e?.message || String(e)), 500);
  }
}

export async function updateEntityMappingConfig(ctx, input) {
  const { pid, cid, configId } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM entity_mapping_configs
      WHERE id=$1 AND source_id=$2 AND source_type='database' AND deleted_at IS NULL`,
    [configId, cid],
  ).catch(() => null);
  if (!existing) throw new ApiError("实体配置不存在", 404);
  const { rule, is_active } = input.body || {};
  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (rule !== undefined) { sets.push(`rule=$${i++}`); vals.push(rule); }
  if (is_active !== undefined) { sets.push(`is_active=$${i++}`); vals.push(!!is_active); }
  vals.push(configId, cid);
  await ctx.query(
    `UPDATE entity_mapping_configs SET ${sets.join(",")}
      WHERE id=$${i} AND source_id=$${i + 1} AND source_type='database'`,
    vals,
  );
  const row = await ctx.queryOne(
    `SELECT id, table_name, column_name, schema_name, rule, is_active
       FROM entity_mapping_configs WHERE id=$1`,
    [configId],
  );
  await DatabaseEntityService._invalidate_business_entity_cache(pid).catch(() => {});
  return { data: row, message: "实体配置更新成功" };
}

export async function deleteEntityMappingConfig(ctx, input) {
  const { pid, cid, configId } = input.params;
  await ctx.query(
    `UPDATE entity_mapping_configs SET deleted_at=now(), updated_at=now()
      WHERE id=$1 AND source_id=$2 AND source_type='database' AND deleted_at IS NULL`,
    [configId, cid],
  );
  await ctx.query(`UPDATE entity_mappings SET deleted_at=now() WHERE config_id=$1`, [configId]).catch(() => {});
  await DatabaseEntityService._invalidate_business_entity_cache(pid).catch(() => {});
  return { data: { id: configId }, message: "实体配置删除成功" };
}

export async function suggestEntityColumns(ctx, input) {
  const { cid } = input.params;
  const tableIds = Array.isArray(input.body?.table_ids) ? input.body.table_ids : null;
  const minScore = Number(input.body?.min_score || 0.4);
  const params = [cid];
  let tableFilter = "";
  if (tableIds?.length) {
    params.push(tableIds);
    tableFilter = ` AND t.id::text = ANY($${params.length}::text[])`;
  }
  const rows = await ctx.query(
    `SELECT t.id AS table_id, t.table_name, t.schema_name, c.column_name, c.description, c.data_type
       FROM table_metadata t
       JOIN column_metadata c ON c.table_id = t.id
      WHERE t.database_connection_id=$1 AND t.deleted_at IS NULL AND c.deleted_at IS NULL${tableFilter}
      ORDER BY t.table_name, c.column_name`,
    params,
  ).catch(() => []);
  const existing = await ctx.query(
    `SELECT table_name, schema_name, column_name FROM entity_mapping_configs
      WHERE source_id=$1 AND source_type='database' AND deleted_at IS NULL`,
    [cid],
  ).catch(() => []);
  const existingKeys = new Set(existing.map((item) => `${item.schema_name || ""}.${item.table_name}.${item.column_name}`));

  const items = rows.map((row) => {
    const name = String(row.column_name || "").toLowerCase();
    let score = 0;
    if (/(name|title|label|email|phone|mobile|code|number|no|sku|city|country|user|customer|client|supplier|product|brand)/i.test(name)) score += 0.55;
    if (!/(^id$|_id$|date|time|created|updated|count|amount|price|total|rate|flag|status)/i.test(name)) score += 0.2;
    if (row.description) score += 0.15;
    score = Math.min(0.95, score);
    const key = `${row.schema_name || ""}.${row.table_name}.${row.column_name}`;
    return {
      table_id: row.table_id,
      table_name: row.table_name,
      schema_name: row.schema_name,
      column_name: row.column_name,
      column_description: row.description || "",
      data_type: row.data_type,
      score,
      already_exists: existingKeys.has(key),
    };
  }).filter((item) => item.score >= minScore);

  return { data: { items, total: items.length }, message: "实体列推荐完成" };
}

export async function batchCreateEntityConfigs(ctx, input) {
  const columns = Array.isArray(input.body?.columns) ? input.body.columns : [];
  const results = [];
  for (const column of columns) {
    try {
      const res = await createEntityMappingConfig(ctx, {
        ...input,
        body: {
          table_id: column.table_id,
          column_name: column.column_name,
          metadata_fields: column.metadata_fields,
          rule: column.rule ?? input.body?.rule,
        },
      });
      results.push({ success: true, ...res.data });
    } catch (e) {
      results.push({ success: false, table_id: column.table_id, column_name: column.column_name, error: e?.message || String(e) });
    }
  }
  return { data: { results, created: results.filter((r) => r.success).length }, message: "批量创建实体配置完成" };
}

export async function searchEntities(ctx, input) {
  const { cid } = input.params;
  const q = String(input.query?.query || input.body?.query || "").trim();
  const limit = Math.min(100, Math.max(1, Number(input.query?.limit || input.body?.limit || 10)));
  if (!q) return { data: { items: [], total: 0 }, message: "请输入搜索内容" };
  const rows = await ctx.query(
    `SELECT em.id, em.name, em.entity_type, em.meta_data, em.config_id,
            cfg.table_name, cfg.column_name, cfg.schema_name
       FROM entity_mappings em
       LEFT JOIN entity_mapping_configs cfg ON cfg.id = em.config_id
      WHERE em.source_id=$1 AND em.source_type='database' AND em.deleted_at IS NULL
        AND (em.name LIKE $2 OR cfg.table_name LIKE $2 OR cfg.column_name LIKE $2)
      LIMIT $3`,
    [cid, `%${q}%`, limit],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length }, message: "实体搜索完成" };
}
