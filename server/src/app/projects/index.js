import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';

export async function listProjects(ctx) {
  return ctx.query('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC');
}

export async function createProject(ctx, input) {
  const name = String(input.body?.name || '').trim();
  if (!name) throw new ApiError('工作区名称不能为空');
  const id = randomUUID();
  await ctx.query(
    'INSERT INTO projects (id,name,description) VALUES ($1,$2,$3)',
    [id, name, String(input.body?.description || '')],
  );
  return ctx.queryOne('SELECT * FROM projects WHERE id=$1', [id]);
}

export async function getProject(ctx, input) {
  const row = await ctx.queryOne('SELECT * FROM projects WHERE id=$1 AND deleted_at IS NULL', [input.params.pid]);
  if (!row) throw new ApiError('工作区不存在', 404);
  return row;
}

export async function updateProject(ctx, input) {
  await getProject(ctx, input);
  const name = input.body?.name;
  const description = input.body?.description;
  if (name !== undefined) {
    const value = String(name).trim();
    if (!value) throw new ApiError('工作区名称不能为空');
    await ctx.query('UPDATE projects SET name=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [value, input.params.pid]);
  }
  if (description !== undefined) {
    await ctx.query('UPDATE projects SET description=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [String(description), input.params.pid]);
  }
  return getProject(ctx, input);
}

export async function deleteProject(ctx, input) {
  await getProject(ctx, input);
  await ctx.query('UPDATE projects SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [input.params.pid]);
  await ctx.query('UPDATE sessions SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE project_id=$1 AND deleted_at IS NULL', [input.params.pid]);
  return { id: input.params.pid };
}
