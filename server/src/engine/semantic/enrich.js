// 统一连接语义富化编排(迁移补全 P8)。
// DB 连接同步 与 结构化文件导入 两条路径共用同一函数,消除语义增强不一致(24% 掉分的结构性根因)。
//
// 固定顺序:示例值 → 去重值/枚举 → 列描述 → 表描述 → 更新 Schema SQL 文件。

import { query, queryOne } from '../../db.js';
import { PluginRegistry } from '../datasources/plugins/index.js';
import { populateExampleValues } from './schema_enrichment_service.js';
import { populateDistinctAndEnum } from './distinct_enum.js';
import { generateColumnsDescriptions } from './column_description.js';
import { generateTableDescriptions } from './table_description.js';
import { writeSchemaSnapshot } from './schema_file_service.js';

function pluginConfigOf(conn) {
  return {
    db_type: conn.db_type, host: conn.host, port: conn.port,
    username: conn.username, password: conn.password, database: conn.database,
  };
}

/**
 * 为某连接做完整离线准备。各步独立记录结果，由外层任务统一判断成功或失败。
 * @param {string} connectionId
 * @param {{projectId?:string|null, extraNotes?:string|null, descriptions?:boolean, force?:boolean}} [opts]
 *   descriptions=false 时跳过 LLM 描述生成，只做本地采样和 SQL 文件更新。
 * @returns {Promise<object>} 各步统计
 */
export async function enrichConnection(connectionId, { projectId = null, extraNotes = null, descriptions = true, force = false } = {}) {
  const conn = await queryOne(
    `SELECT id, project_id, name, db_type, host, port, username, password, database
       FROM database_connections WHERE id=$1 AND deleted_at IS NULL`,
    [connectionId],
  ).catch(() => null);
  if (!conn) return { skipped: '连接不存在' };

  const plugin = PluginRegistry.get(conn.db_type);
  if (!plugin) return { skipped: `无插件: ${conn.db_type}` };
  const config = pluginConfigOf(conn);
  const stats = {};

  // 1. 列示例值采样
  try { stats.example = await populateExampleValues(connectionId, plugin, config); }
  catch (e) { stats.example = { error: String(e?.message ?? e) }; }

  // 2. 去重值 + 自动枚举(低基数列)
  try { stats.distinct = await populateDistinctAndEnum(connectionId, plugin, config); }
  catch (e) { stats.distinct = { error: String(e?.message ?? e) }; }

  // 3. 列描述(LLM)—— 依赖示例值已就位
  if (descriptions) {
    try { stats.columns = await generateColumnsDescriptions(connectionId, { projectId, extraNotes }); }
    catch (e) { stats.columns = { error: String(e?.message ?? e) }; }
    // 4. 表描述(LLM)—— 依赖列描述已就位
    try { stats.tables = await generateTableDescriptions(connectionId, { projectId }); }
    catch (e) { stats.tables = { error: String(e?.message ?? e) }; }
  }

  // 5. 更新项目工作区里的 Schema SQL 文件。
  try {
    stats.schema_file = await writeSchemaSnapshot({ query, queryOne }, {
      projectId: projectId || conn.project_id,
      connectionId,
      connection: conn,
    });
  } catch (e) { stats.schema_file = { error: String(e?.message ?? e) }; }

  console.info(`[enrich] 连接 ${connectionId}:`, JSON.stringify(stats));
  return stats;
}
