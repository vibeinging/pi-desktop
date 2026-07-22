// 迁移自 agenticdata_kernel/data_analyze/planner/dbagents/tools/schema_analysis_tool.py
/**
 * Schema Analysis Tool - 数据库 Schema 分析工具。
 * 从项目工作区读取数据库 Schema SQL 文件。
 */
import { BaseTool, Result } from '../core/base_tool.js';
import { loadSchemaSnapshot } from '../semantic/schema_file_service.js';
import { t } from '../utils/i18n.js';
import { query, queryOne } from '../../db.js';

const logger = {
  info: (...a) => console.info('[SchemaAnalysis]', ...a),
  debug: (...a) => console.debug('[SchemaAnalysis]', ...a),
  warning: (...a) => console.warn('[SchemaAnalysis]', ...a),
  error: (...a) => console.error('[SchemaAnalysis]', ...a),
};

export class SchemaAnalysisTool extends BaseTool {
  constructor() {
    super('schema_analysis', '读取数据库 Schema SQL 文件', {
      supported_task_types: ['nl2sql', 'schema_analysis'], version: '1.0.0', author: 'System',
    });
  }

  /** @param {import('../core/agent_context.js').AgentContext} context */
  async execute(context, kwargs = {}) {
    try {
      const database_id = kwargs.database_id;
      if (!database_id) return Result.createError('缺少database_id参数');

      const ctx = { query, queryOne };
      const db_connection = await this._get_database_connection(ctx, database_id);
      if (!db_connection) return Result.createError(`数据库连接不存在: ${database_id}`);

      const projectId = context?.project_id || kwargs.project_id || db_connection.project_id;
      const snapshot = await loadSchemaSnapshot(ctx, {
        projectId,
        connectionId: database_id,
        connection: db_connection,
      });
      const schema_info = snapshot.sql;
      const relevant_tables = [];
      const relationships = [];
      logger.info(`从 SQL 文件加载 Schema: ${snapshot.path} (${snapshot.tableCount} 个表)`);
      return Result.create(
        { schema_info, schema_file: snapshot.path, tables_found: snapshot.tableCount, tables: relevant_tables, relationships },
        t('成功加载{}个表的Schema SQL', snapshot.tableCount),
      );
    } catch (e) {
      logger.error(`Schema分析失败: ${e?.message ?? e}`);
      return Result.createError(`Schema分析失败: ${e?.message ?? e}`);
    }
  }

  async _get_database_connection(ctx, database_id) {
    return ctx.queryOne(
      `SELECT id, project_id, db_type, schema_config, extra_config, database, host FROM database_connections WHERE id = $1 AND deleted_at IS NULL`,
      [database_id],
    ).catch(() => null);
  }

  validate_params(kwargs = {}) {
    const database_id = kwargs.database_id;
    return typeof database_id === 'string' && database_id.length > 0;
  }
}

export default SchemaAnalysisTool;
