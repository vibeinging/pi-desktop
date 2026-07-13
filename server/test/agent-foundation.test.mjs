import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { agentChat } from '../src/app/chat/agent_chat.js';
import { pendingDecisions } from '../src/app/chat/agent_misc.js';
import {
  createProjectModel,
  deleteProjectModel,
  updateProjectModel,
} from '../src/app/models/index.js';
import { promptAgentWithSignal, WorkspaceAgent } from '../src/engine/agents/workspace_agent.js';
import { ModelConfigResolver } from '../src/engine/core/llm.js';
import { createDbModelConfigProvider } from '../src/engine/core/model_config_provider.js';

const root = resolve(import.meta.dirname, '..', '..');

function createChatCtx(signal = null) {
  const state = {
    session: { id: 's1', project_id: 'p1' },
    messages: [],
    runs: new Map(),
  };
  return {
    state,
    signal,
    async queryOne(sql, params) {
      if (sql.includes('FROM sessions')) return state.session;
      if (sql.includes('MAX(sequence_number)')) {
        return { seq: Math.max(0, ...state.messages.map((item) => item.sequence_number)) };
      }
      return null;
    },
    async query(sql, params) {
      if (sql.includes('INSERT INTO session_messages')) {
        state.messages.push({
          id: params[0],
          session_id: params[1],
          role: params[2],
          content_items: params[3],
          message_metadata: params[4],
          sequence_number: params[5],
        });
        return [];
      }
      if (sql.includes('INSERT INTO agent_runs')) {
        state.runs.set(params[0], { id: params[0], status: params[3] });
        return [];
      }
      if (sql.includes('SELECT role,content_items FROM session_messages')) {
        return state.messages
          .filter((item) => item.session_id === params[0] && item.id !== params[1])
          .sort((a, b) => a.sequence_number - b.sequence_number)
          .map(({ role, content_items }) => ({ role, content_items }));
      }
      if (sql.includes('UPDATE agent_runs SET status=')) {
        const runId = params.at(-1);
        const run = state.runs.get(runId);
        if (run) run.status = params[0];
        return [];
      }
      return [];
    },
  };
}

test('通用 Agent 的项目、会话、Skill、MCP 和失败历史可持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-agent-'));
  const dbPath = join(dir, 'local.db');
  const source = `
    const db = await import('./server/src/db.js');
    const projects = await import('./server/src/app/projects/index.js');
    const sessions = await import('./server/src/app/session/index.js');
    const misc = await import('./server/src/app/chat/agent_misc.js');
    const mcp = await import('./server/src/app/integrations/mcp.js');
    const { agentChat } = await import('./server/src/app/chat/agent_chat.js');
    const { ensureDbModelConfigProvider } = await import('./server/src/engine/core/model_config_provider.js');
    ensureDbModelConfigProvider({ queryOne: db.queryOne });
    const ctx = { query: db.query, queryOne: db.queryOne, db: { query: db.query, queryOne: db.queryOne } };
    const project = await projects.createProject(ctx, { body: { name: '通用项目' } });
    const session = await sessions.createSession(ctx, { params: { pid: project.id }, body: { title: '测试会话' } });
    const skillResult = await misc.createAppAgentSkill(ctx, { body: {
      name: 'summarize_files', description: '整理工作区文件', instructions: '读取文件并给出摘要', allowed_tools: ['read', 'find']
    } });
    const providerResult = await mcp.createAppMcpProvider(ctx, { body: {
      provider_name: 'local_tools', transport: 'stdio', command: 'node', args: ['server.js'], default_enabled: false
    } });
    const events = [];
    let failed = false;
    try {
      await agentChat(ctx, { params: { pid: project.id, sid: session.id }, body: { message: '你好' } }, (event) => events.push(event));
    } catch { failed = true; }
    const sessionList = await sessions.listSessions(ctx, { params: { pid: project.id }, query: {} });
    const messages = await sessions.listMessages(ctx, { params: { pid: project.id, sid: session.id } });
    const runs = await db.query('SELECT status FROM agent_runs WHERE session_id=$1', [session.id]);
    console.log(JSON.stringify({
      project: project.name,
      sessionIds: sessionList.items.map((item) => item.id),
      latestRunStatus: sessionList.items[0]?.latest_run_status,
      skill: skillResult.data.name,
      provider: providerResult.data.provider_name,
      failed,
      roles: messages.items.map((item) => item.role),
      runStatus: runs[0]?.status,
      eventTypes: events.map((event) => event.type)
    }));
    db.closeDb();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root,
      env: { ...process.env, HOME: dir, PI_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.project, '通用项目');
    assert.equal(output.sessionIds.length, 1);
    assert.equal(output.latestRunStatus, 'failed');
    assert.equal(output.skill, 'summarize_files');
    assert.equal(output.provider, 'local_tools');
    assert.equal(output.failed, true);
    assert.deepEqual(output.roles, ['user']);
    assert.equal(output.runStatus, 'failed');
    assert.ok(output.eventTypes.includes('run.started'));
    assert.ok(output.eventTypes.includes('run.failed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('首轮完整调用链在 JSONL 中只写入一次用户消息', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-first-turn-'));
  const dbPath = join(dir, 'local.db');
  const source = `
    const db = await import('./server/src/db.js');
    const projects = await import('./server/src/app/projects/index.js');
    const sessions = await import('./server/src/app/session/index.js');
    const { agentChat } = await import('./server/src/app/chat/agent_chat.js');
    const { WorkspaceAgent } = await import('./server/src/engine/agents/workspace_agent.js');
    const { loadTranscript } = await import('./server/src/engine/agents/sessionStore.js');
    const { ModelConfigResolver } = await import('./server/src/engine/core/llm.js');

    class FakeAgent {
      constructor(options) {
        this.state = { messages: [...(options.initialState?.messages || [])] };
      }
      subscribe() { return () => {}; }
      abort() {}
      async prompt(text) {
        this.state.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
        this.state.messages.push({
          role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now()
        });
      }
    }

    ModelConfigResolver.setProvider(async () => ({
      id: 'm1', model_name: 'fake-model', api_base: 'https://example.test/v1', api_key: 'key',
      api_format: 'chat_completions', is_enabled: true, extra_config: {}
    }));
    WorkspaceAgent.create = async () => new WorkspaceAgent({ AgentClass: FakeAgent });
    const ctx = { query: db.query, queryOne: db.queryOne, db: { query: db.query, queryOne: db.queryOne } };
    const project = await projects.createProject(ctx, { body: { name: 'first-turn' } });
    const session = await sessions.createSession(ctx, { params: { pid: project.id }, body: { title: 'first' } });
    await agentChat(ctx, {
      params: { pid: project.id, sid: session.id },
      body: { message: '读取附件', attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }] }
    }, () => {});
    const transcript = loadTranscript(session.id);
    console.log(JSON.stringify({
      userCount: transcript.filter((item) => item.role === 'user').length,
      total: transcript.length,
      prompt: transcript.find((item) => item.role === 'user')?.content?.[0]?.text || ''
    }));
    db.closeDb();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root,
      env: { ...process.env, HOME: dir, PI_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(output.userCount, 1);
    assert.equal(output.total, 2);
    assert.match(output.prompt, /\/tmp\/a\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent 消息会持久化附件并且首轮不会重复注入当前消息', async () => {
  const originalCreate = WorkspaceAgent.create;
  const ctx = createChatCtx();
  const events = [];
  let observed;
  WorkspaceAgent.create = async () => ({
    execute: async (context) => {
      observed = {
        input: context.input_data,
        history: await context.loadHistory(),
      };
      return { success: true };
    },
  });
  try {
    await agentChat(ctx, {
      params: { pid: 'p1', sid: 's1' },
      body: {
        message: '请总结',
        attachments: [
          { filePath: '/tmp/report.md', filename: 'report.md' },
          { path: '/tmp/source', name: 'source', isDir: true },
          { name: '无路径附件' },
        ],
      },
    }, (event) => events.push(event));

    assert.deepEqual(observed.history, [], '初始化 JSONL 时必须排除本轮已写入 SQLite 的消息');
    assert.deepEqual(observed.input.attachments, [
      { path: '/tmp/report.md', name: 'report.md', is_dir: false },
      { path: '/tmp/source', name: 'source', is_dir: true },
    ]);
    assert.match(observed.input.user_message, /\/tmp\/report\.md/);
    assert.match(observed.input.user_message, /\/tmp\/source/);

    const persisted = JSON.parse(ctx.state.messages[0].content_items);
    assert.deepEqual(persisted.map((item) => item.type), ['attachment', 'attachment', 'text']);
    assert.equal(persisted[0].metadata.path, '/tmp/report.md');
    assert.equal(JSON.parse(ctx.state.messages[0].message_metadata).attachments.length, 2);
    assert.equal([...ctx.state.runs.values()][0].status, 'completed');
    assert.ok(events.some((event) => event.type === 'run.completed'));
  } finally {
    WorkspaceAgent.create = originalCreate;
  }
});

test('取消信号会调用 pi Agent.abort 并阻止后续工具链', async () => {
  const controller = new AbortController();
  let releasePrompt;
  let markStarted;
  let abortCount = 0;
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  const fakeAgent = {
    state: { messages: [] },
    async prompt() {
      markStarted();
      await new Promise((resolvePrompt) => { releasePrompt = resolvePrompt; });
      this.state.messages.push({ role: 'assistant', stopReason: 'aborted', content: [] });
    },
    abort() {
      abortCount += 1;
      releasePrompt?.();
    },
  };

  const pending = promptAgentWithSignal(fakeAgent, '执行工具', controller.signal);
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(abortCount, 1);
  assert.equal(result.cancelled, true);
});

test('停止 Agent 时会立即取消审批等待并将 run 记为 cancelled', async () => {
  const originalCreate = WorkspaceAgent.create;
  const controller = new AbortController();
  const ctx = createChatCtx(controller.signal);
  const events = [];
  let decisionId;
  WorkspaceAgent.create = async () => ({
    execute: async (context) => {
      decisionId = 'tool-approval-1';
      const allowed = await context.awaitDecision({ id: decisionId, name: 'bash', arguments: { command: 'echo unsafe' } });
      return { success: false, cancelled: context.signal.aborted, allowed };
    },
  });
  try {
    const running = agentChat(ctx, {
      params: { pid: 'p1', sid: 's1' },
      body: { message: '需要审批', approval: 'ask' },
    }, (event) => events.push(event));
    for (let i = 0; i < 20 && !pendingDecisions.has(decisionId || ''); i += 1) {
      await new Promise((resolveWait) => setImmediate(resolveWait));
    }
    assert.equal(pendingDecisions.has(decisionId), true);
    controller.abort();
    const result = await running;

    assert.equal(result.cancelled, true);
    assert.equal(pendingDecisions.has(decisionId), false);
    assert.equal([...ctx.state.runs.values()][0].status, 'cancelled');
    assert.ok(events.some((event) => event.type === 'run.cancelled'));
    assert.ok(!events.some((event) => event.type === 'run.completed'));
  } finally {
    pendingDecisions.delete(decisionId);
    WorkspaceAgent.create = originalCreate;
  }
});

test('模型 resolver 只选启用模型并拒绝 provider 返回的停用模型', async () => {
  let capturedSql = '';
  const provider = createDbModelConfigProvider({
    queryOne: async (sql) => {
      capturedSql = sql;
      return {
        id: 'm1', model_name: 'enabled', api_base: 'https://example.test/v1', api_key: 'key',
        category: 'PRIMARY', api_format: 'chat_completions', extra_config: '{}', is_enabled: 1,
      };
    },
  });
  const config = await provider({ project_id: 'p1', category: 'PRIMARY' });
  assert.match(capturedSql, /is_enabled\s*=\s*1/);
  assert.equal(config.is_enabled, true);

  ModelConfigResolver.setProvider(async () => ({
    model_name: 'disabled', api_base: 'https://example.test/v1', api_key: 'key', is_enabled: false,
  }));
  await assert.rejects(
    ModelConfigResolver.resolve({ project_id: 'p-disabled', category: 'PRIMARY' }),
    { name: 'ModelNotFoundError' },
  );
});

test('模型创建、修改和删除后会立即失效 resolver 缓存', async () => {
  const rows = [{
    id: 'global', model_name: 'global-model', display_name: 'global-model', category: 'PRIMARY',
    api_base: 'https://example.test/v1', api_key: 'global-key', api_format: 'chat_completions',
    is_enabled: 1, extra_config: '{}', project_id: null, deleted_at: null,
  }];
  const findEffective = (projectId) => rows.find((row) => !row.deleted_at && row.is_enabled && row.project_id === projectId)
    || rows.find((row) => !row.deleted_at && row.is_enabled && row.project_id == null);
  let providerCalls = 0;
  ModelConfigResolver.setProvider(async ({ project_id }) => {
    providerCalls += 1;
    return findEffective(project_id);
  });
  const ctx = {
    async queryOne(sql, params) {
      if (sql.includes('SELECT id FROM llm_models WHERE category=')) {
        return rows.find((row) => row.category === params[0] && row.project_id === params[1] && !row.deleted_at) || null;
      }
      if (sql.includes('SELECT * FROM llm_models WHERE id=')) {
        return rows.find((row) => row.id === params[0] && !row.deleted_at) || null;
      }
      return null;
    },
    async query(sql, params) {
      if (sql.includes('INSERT INTO llm_models')) {
        rows.push({
          id: params[0], model_name: params[1], display_name: params[2], category: params[3],
          api_base: params[4], api_key: params[5], api_format: params[6], is_enabled: params[7],
          extra_config: params[8], project_id: params[9], deleted_at: null,
        });
      } else if (sql.includes('UPDATE llm_models SET model_name=')) {
        const row = rows.find((item) => item.id === params[8]);
        Object.assign(row, {
          model_name: params[0], display_name: params[1], category: params[2], api_base: params[3],
          api_key: params[4], api_format: params[5], extra_config: params[6], is_enabled: params[7],
        });
      } else if (sql.includes('UPDATE llm_models SET deleted_at=')) {
        rows.find((row) => row.id === params[0]).deleted_at = new Date().toISOString();
      }
      return [];
    },
  };

  const before = await ModelConfigResolver.resolve({ project_id: 'p1', category: 'PRIMARY' });
  assert.equal(before.model_name, 'global-model');
  const created = await createProjectModel(ctx, {
    params: { pid: 'p1' },
    body: { model_name: 'project-model', api_base: 'https://example.test/v1', api_key: 'project-key' },
  });
  const afterCreate = await ModelConfigResolver.resolve({ project_id: 'p1', category: 'PRIMARY' });
  assert.equal(afterCreate.model_name, 'project-model');

  await updateProjectModel(ctx, {
    body: { id: created.id, model_name: 'project-model-v2', api_base: 'https://example.test/v1' },
  });
  const afterUpdate = await ModelConfigResolver.resolve({ project_id: 'p1', category: 'PRIMARY' });
  assert.equal(afterUpdate.model_name, 'project-model-v2');

  await deleteProjectModel(ctx, { body: { model_id: created.id } });
  const afterDelete = await ModelConfigResolver.resolve({ project_id: 'p1', category: 'PRIMARY' });
  assert.equal(afterDelete.model_name, 'global-model');
  assert.equal(providerCalls, 4);
});
