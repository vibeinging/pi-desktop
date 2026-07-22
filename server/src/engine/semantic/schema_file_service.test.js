import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSchemaSql, inspectSchemaSnapshot, loadSchemaSnapshot, writeSchemaSnapshot } from './schema_file_service.js';

test('buildSchemaSql writes complete table DDL without vectors', () => {
  const sql = buildSchemaSql({
    connection: { id: 'db-1', name: '订单库', db_type: 'POSTGRESQL' },
    tables: [{
      schema_name: 'public',
      table_name: 'orders',
      description: '订单主表',
      keywords: '交易,订单',
      columns: [
        { column_name: 'id', data_type: 'BIGINT', is_primary_key: true, is_nullable: false },
        { column_name: 'amount', data_type: 'DECIMAL(12,2)', is_nullable: true, description: '订单金额', example_values: '[99.5,199]' },
      ],
    }],
    relationships: [{
      source_schema: 'public', source_table: 'orders', source_column: 'customer_id',
      target_schema: 'public', target_table: 'customers', target_column: 'id',
      relationship_type: 'many-to-one',
    }],
  });

  assert.match(sql, /CREATE TABLE "public"\."orders"/);
  assert.match(sql, /"id" BIGINT PRIMARY KEY NOT NULL/);
  assert.match(sql, /"amount" DECIMAL\(12,2\)/);
  assert.match(sql, /Table description: 订单主表/);
  assert.match(sql, /Table keywords: 交易,订单/);
  assert.match(sql, /description=订单金额; examples=\[99\.5,199\]/);
  assert.match(sql, /Relationship: public\.orders\.customer_id -> public\.customers\.id; many-to-one/);
  assert.doesNotMatch(sql, /embedding|vector/i);
});

test('loadSchemaSnapshot rebuilds a stale SQL file before QueryAgent searches it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-schema-stale-'));
  process.env.YIW_PROJECTS_DIR = dir;
  let description = '旧描述';
  const ctx = {
    queryOne: async (sql) => sql.includes('MAX(')
      ? { updated_at: '2999-01-01T00:00:00.000Z' }
      : ({ id: 'db-1', project_id: 'project-1', name: '测试库', db_type: 'SQLITE' }),
    query: async (sql) => sql.includes('FROM relationship_metadata')
      ? []
      : sql.includes('FROM table_metadata')
        ? [{ id: 'table-1', schema_name: 'default', table_name: 'users', table_type: 'TABLE', description, is_view: false }]
        : [{ column_name: 'id', data_type: 'INTEGER', is_nullable: false, default_value: null, is_primary_key: true, is_unique: true }],
  };
  try {
    await writeSchemaSnapshot(ctx, { projectId: 'project-1', connectionId: 'db-1' });
    description = '新描述';
    const snapshot = await loadSchemaSnapshot(ctx, {
      projectId: 'project-1',
      connectionId: 'db-1',
      connection: { id: 'db-1', project_id: 'project-1', name: '测试库', db_type: 'SQLITE' },
    });
    assert.match(snapshot.sql, /Table description: 新描述/);
    assert.doesNotMatch(snapshot.sql, /旧描述/);
  } finally {
    delete process.env.YIW_PROJECTS_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('inspectSchemaSnapshot reports stale content without rebuilding it during online query', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-schema-inspect-'));
  process.env.YIW_PROJECTS_DIR = dir;
  let description = '离线旧描述';
  const ctx = {
    queryOne: async (sql) => sql.includes('MAX(')
      ? { updated_at: '2999-01-01T00:00:00.000Z' }
      : ({ id: 'db-1', project_id: 'project-1', name: '测试库', db_type: 'SQLITE' }),
    query: async (sql) => sql.includes('FROM relationship_metadata')
      ? []
      : sql.includes('FROM table_metadata')
        ? [{ id: 'table-1', schema_name: 'default', table_name: 'users', table_type: 'TABLE', description, is_view: false }]
        : [{ column_name: 'id', data_type: 'INTEGER', is_nullable: false, default_value: null, is_primary_key: true, is_unique: true }],
  };
  try {
    const written = await writeSchemaSnapshot(ctx, { projectId: 'project-1', connectionId: 'db-1' });
    description = '不应在线写入的新描述';
    const inspected = await inspectSchemaSnapshot(ctx, {
      projectId: 'project-1',
      connectionId: 'db-1',
      connection: { id: 'db-1', project_id: 'project-1', name: '测试库', db_type: 'SQLITE' },
    });
    assert.equal(inspected.status, 'stale');
    assert.match(inspected.sql, /离线旧描述/);
    assert.doesNotMatch(await readFile(written.path, 'utf8'), /不应在线写入的新描述/);
  } finally {
    delete process.env.YIW_PROJECTS_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeSchemaSnapshot stores the SQL file in the project workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-schema-'));
  process.env.YIW_PROJECTS_DIR = dir;
  const ctx = {
    queryOne: async () => ({ id: 'db-1', name: '测试库', db_type: 'SQLITE' }),
    query: async (sql) => sql.includes('FROM relationship_metadata')
      ? []
      : sql.includes('FROM table_metadata')
        ? [{ id: 'table-1', schema_name: 'default', table_name: 'users', table_type: 'TABLE', description: '', is_view: false }]
        : [{ column_name: 'id', data_type: 'INTEGER', description: '', is_nullable: false, default_value: null, is_primary_key: true, is_unique: true }],
  };
  try {
    const snapshot = await writeSchemaSnapshot(ctx, { projectId: 'project-1', connectionId: 'db-1' });
    assert.equal(snapshot.tableCount, 1);
    assert.match(snapshot.path, /project-1\/schemas\/db-1\.sql$/);
    assert.match(await readFile(snapshot.path, 'utf8'), /CREATE TABLE "users"/);
  } finally {
    delete process.env.YIW_PROJECTS_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
