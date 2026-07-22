// 结构化数据的离线准备工具。
// 这里只负责补充可读的 Schema 内容，不做向量生成，也不参与在线问答。

import { query } from '../../db.js';

/**
 * 用数据源插件采样列示例值，并写入 column_metadata.example_values。
 * @param {string} connectionId
 * @param {object} plugin
 * @param {object} config
 * @param {{limit?:number, onlyEmpty?:boolean}} [opts]
 * @returns {Promise<{tables:number, columns:number, skipped?:string}>}
 */
export async function populateExampleValues(
  connectionId,
  plugin,
  config,
  { limit = 3, onlyEmpty = true } = {},
) {
  if (!plugin || typeof plugin.getExampleValues !== 'function') {
    return { tables: 0, columns: 0, skipped: '插件不支持 getExampleValues' };
  }

  const tableSql = onlyEmpty
    ? `SELECT DISTINCT t.id, t.schema_name, t.table_name
         FROM table_metadata t JOIN column_metadata c ON c.table_id = t.id
        WHERE t.database_connection_id = $1 AND t.deleted_at IS NULL AND c.deleted_at IS NULL
          AND (c.example_values IS NULL OR c.example_values = '')`
    : `SELECT id, schema_name, table_name FROM table_metadata
        WHERE database_connection_id = $1 AND deleted_at IS NULL`;
  const tables = await query(tableSql, [connectionId]).catch(() => []);
  let tableCount = 0;
  let columnCount = 0;

  for (const table of tables) {
    let examples;
    try {
      examples = await plugin.getExampleValues(config, table.table_name, {
        schemaName: table.schema_name,
        limit,
      });
    } catch (error) {
      console.warn(`[example_values] 表 ${table.table_name} 采样失败: ${error?.message ?? error}`);
      continue;
    }
    if (!examples || typeof examples !== 'object') continue;

    tableCount += 1;
    for (const [columnName, values] of Object.entries(examples)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      const blank = onlyEmpty ? "AND (example_values IS NULL OR example_values = '')" : '';
      await query(
        `UPDATE column_metadata SET example_values = $1, updated_at = now()
          WHERE table_id = $2 AND column_name = $3 AND deleted_at IS NULL ${blank}`,
        [JSON.stringify(values), table.id, columnName],
      );
      columnCount += 1;
    }
  }

  return { tables: tableCount, columns: columnCount };
}
