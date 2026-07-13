import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Skill 和 MCP 删除后可同名重建，项目绑定也可重新启用', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pi-desktop-soft-delete-'));
  process.env.PI_DB_PATH = join(home, 'local.db');

  const db = await import('../src/db.js');
  const skills = await import('../src/engine/agents/pi_skill_registry.js');
  const mcp = await import('../src/app/integrations/mcp.js');
  const ctx = { query: db.query, queryOne: db.queryOne };

  t.after(() => {
    db.closeDb();
    rmSync(home, { recursive: true, force: true });
  });

  await db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', ['p1', 'workspace']);

  const firstSkill = await skills.createAppSkill(ctx, {
    name: 'review-files',
    description: 'Review local files',
    instructions: 'Read the selected files and summarize them.',
  });
  await skills.deleteAppSkill(ctx, firstSkill.name);
  const restoredSkill = await skills.createAppSkill(ctx, {
    name: 'review-files',
    description: 'Review local files again',
    instructions: 'Read files and report risks.',
  });
  assert.equal(restoredSkill.id, firstSkill.id);
  assert.equal(restoredSkill.description, 'Review local files again');

  await skills.setPiSkillEnabled(ctx, 'p1', restoredSkill.name, false);
  await skills.deletePiSkill(ctx, 'p1', restoredSkill.name);
  const reboundSkill = await skills.setPiSkillEnabled(ctx, 'p1', restoredSkill.name, true);
  assert.equal(reboundSkill.effective_enabled, true);
  const skillBindingCount = await db.queryOne(
    'SELECT COUNT(*) AS count FROM project_skills WHERE project_id=$1 AND skill_name=$2 AND deleted_at IS NULL',
    ['p1', restoredSkill.name],
  );
  assert.equal(skillBindingCount.count, 1);

  const firstMcp = await mcp.createAppMcpProvider(ctx, {
    body: { provider_name: 'local-example', command: 'node', args: ['--version'] },
  });
  await mcp.deleteAppMcpProvider(ctx, { params: { providerName: 'local-example' } });
  const restoredMcp = await mcp.createAppMcpProvider(ctx, {
    body: { provider_name: 'local-example', command: 'node', args: ['--help'] },
  });
  assert.equal(restoredMcp.data.id, firstMcp.data.id);
  assert.deepEqual(restoredMcp.data.args, ['--help']);

  await mcp.updateMcpProvider(ctx, {
    params: { pid: 'p1', providerName: 'local-example' },
    body: { enabled_override: false },
  });
  await mcp.deleteMcpProvider(ctx, {
    params: { pid: 'p1', providerName: 'local-example' },
  });
  const reboundMcp = await mcp.updateMcpProvider(ctx, {
    params: { pid: 'p1', providerName: 'local-example' },
    body: { enabled_override: true },
  });
  assert.equal(reboundMcp.data.effective_enabled, true);
  const mcpBindingCount = await db.queryOne(
    'SELECT COUNT(*) AS count FROM project_mcp_providers WHERE project_id=$1 AND provider_name=$2 AND deleted_at IS NULL',
    ['p1', 'local-example'],
  );
  assert.equal(mcpBindingCount.count, 1);
});
