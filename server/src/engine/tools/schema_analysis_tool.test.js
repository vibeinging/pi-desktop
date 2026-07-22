import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('SchemaAnalysisTool gives NL2SQL the generated whole-database SQL file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-schema-tool-'));
  process.env.DB_SQLITE_PATH = join(dir, 'local.db');
  process.env.YIW_PROJECTS_DIR = join(dir, 'projects');
  try {
    const { sqlite } = await import('../../db.js');
    const { SchemaAnalysisTool } = await import('./schema_analysis_tool.js');
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO database_connections (id, project_id, name, db_type, database, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('db-1', 'project-1', '订单库', 'SQLITE', 'orders.db', now, now);
    sqlite.prepare(
      `INSERT INTO table_metadata (id, database_connection_id, schema_name, table_name, description, created_at, updated_at)
       VALUES (?, ?, 'default', ?, ?, ?, ?)`,
    ).run('table-1', 'db-1', 'orders', '订单主表', now, now);
    sqlite.prepare(
      `INSERT INTO column_metadata (id, table_id, column_name, data_type, is_nullable, is_primary_key, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    ).run('column-1', 'table-1', 'id', 'INTEGER', '订单编号', now, now);

    const result = await new SchemaAnalysisTool().execute(
      { project_id: 'project-1' },
      { database_id: 'db-1', user_message: '查询订单' },
    );
    const data = result.toDict().data;
    assert.equal(data.tables_found, 1);
    assert.match(data.schema_file, /project-1\/schemas\/db-1\.sql$/);
    assert.match(data.schema_info, /CREATE TABLE "orders"/);
    assert.match(data.schema_info, /Table description: 订单主表/);
    assert.match(data.schema_info, /description=订单编号/);
  } finally {
    delete process.env.DB_SQLITE_PATH;
    delete process.env.YIW_PROJECTS_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
