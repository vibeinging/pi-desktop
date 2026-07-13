import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function createModel(api = 'openai-completions', provider = 'gateway') {
  return {
    id: 'contract-model',
    name: 'contract-model',
    api,
    provider,
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function createAssistantMessage(text = 'ok') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'gateway',
    model: 'contract-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function createDoneStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: 'stop', message };
    },
    async result() {
      return message;
    },
  };
}

test('pi v0.80 的兼容 API 从 /compat 导出，核心类型仍从根入口导出', async () => {
  const [compat, core, runtime] = await Promise.all([
    import('@earendil-works/pi-ai/compat'),
    import('@earendil-works/pi-ai'),
    import('../src/engine/agents/pi_runtime.js'),
  ]);

  assert.equal(typeof compat.streamSimple, 'function');
  assert.equal(typeof compat.registerBuiltInApiProviders, 'function');
  assert.equal(typeof compat.getApiProvider, 'function');
  assert.equal(typeof core.Type?.Object, 'function');
  assert.equal('streamSimple' in core, false, '旧的全局 streamSimple 不应再依赖根入口');
  assert.equal(typeof runtime.ensurePiProviders, 'function');
});

test('pi Agent 的构造、订阅、prompt 和状态接口保持可用', async () => {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const events = [];
  const message = createAssistantMessage('升级正常');
  const agent = new Agent({
    initialState: {
      systemPrompt: '测试系统提示',
      model: createModel(),
      tools: [],
      messages: [],
    },
    streamFn: () => createDoneStream(message),
  });
  const unsubscribe = agent.subscribe((event) => events.push(event.type));

  await agent.prompt('你好');
  unsubscribe();

  assert.equal(typeof agent.abort, 'function');
  assert.equal(typeof agent.waitForIdle, 'function');
  assert.equal(agent.state.isStreaming, false);
  assert.equal(agent.state.messages[0]?.role, 'user');
  assert.equal(agent.state.messages.at(-1)?.role, 'assistant');
  assert.equal(agent.state.messages.at(-1)?.content?.[0]?.text, '升级正常');
  assert.ok(events.includes('agent_start'));
  assert.ok(events.includes('turn_end'));
  assert.equal(events.at(-1), 'agent_end');
});

test('WorkspaceAgent 仍装配七个 coding tools，并使用新版 edit 参数结构', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-desktop-tools-'));
  const sessionId = `upgrade-tools-${Date.now()}`;
  const transcriptPath = join(homedir(), '.pi-desktop', 'agent-sessions', `${sessionId}.jsonl`);
  const projectId = `folder:${Buffer.from(cwd).toString('base64url')}`;
  const [{ WorkspaceAgent }, { ModelConfigResolver }] = await Promise.all([
    import('../src/engine/agents/workspace_agent.js'),
    import('../src/engine/core/llm.js'),
  ]);
  let capturedOptions;

  class CapturingAgent {
    constructor(options) {
      capturedOptions = options;
      this.state = { messages: [...(options.initialState?.messages || [])] };
    }

    subscribe() {
      return () => {};
    }

    abort() {}

    async prompt(text) {
      this.state.messages.push({ role: 'user', content: text, timestamp: Date.now() });
      this.state.messages.push(createAssistantMessage());
    }
  }

  ModelConfigResolver.setProvider(async () => ({
    id: 'contract-model',
    model_name: 'contract-model',
    api_base: 'https://example.test/v1',
    api_key: 'test-key',
    api_format: 'chat_completions',
    is_enabled: true,
    extra_config: {},
  }));

  try {
    const result = await new WorkspaceAgent({ AgentClass: CapturingAgent }).execute({
      project_id: projectId,
      session_id: sessionId,
      input_data: { user_message: '检查工具' },
      approval: 'full',
      settings: {},
      loadHistory: async () => [],
    }, async () => {});

    assert.equal(result.success, true);
    const tools = capturedOptions?.initialState?.tools || [];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['update_plan', 'read', 'grep', 'ls', 'find', 'write', 'edit', 'bash'],
    );
    for (const tool of tools.slice(1)) {
      assert.equal(typeof tool.description, 'string', `${tool.name} 缺少 description`);
      assert.equal(typeof tool.parameters, 'object', `${tool.name} 缺少 parameters`);
      assert.equal(typeof tool.execute, 'function', `${tool.name} 缺少 execute`);
    }
    const editTool = tools.find((tool) => tool.name === 'edit');
    assert.ok(editTool?.parameters?.properties?.edits, 'v0.80.6 edit 应使用 edits 数组');
  } finally {
    ModelConfigResolver.setProvider(null);
    rmSync(transcriptPath, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('三种模型 API 会映射到正确的 pi API 和内置 provider', async () => {
  const [runtime, compat] = await Promise.all([
    import('../src/engine/agents/pi_runtime.js'),
    import('@earendil-works/pi-ai/compat'),
  ]);
  runtime.ensurePiProviders();

  const cases = [
    { apiFormat: 'chat_completions', api: 'openai-completions', provider: 'gateway' },
    { apiFormat: 'responses', api: 'openai-responses', provider: 'openai' },
    { apiFormat: 'anthropic', api: 'anthropic-messages', provider: 'anthropic' },
  ];

  for (const item of cases) {
    const model = runtime.buildPiModel({
      model_name: 'contract-model',
      api_base: 'https://example.test/v1',
      api_format: item.apiFormat,
      extra_config: {},
    });
    assert.equal(model.api, item.api);
    assert.equal(model.provider, item.provider);
    assert.equal(typeof compat.getApiProvider(item.api)?.streamSimple, 'function');

    let captured;
    const expectedStream = { api: item.api };
    const streamFn = runtime.createPiStreamFn({
      apiKey: 'test-key',
      timeoutMs: 1234,
      extraConfig: { cache_retention: 'long' },
      baseStreamFn: (receivedModel, context, options) => {
        captured = { receivedModel, context, options };
        return expectedStream;
      },
    });
    assert.equal(await streamFn(model, { systemPrompt: '', messages: [] }, {}), expectedStream);
    assert.equal(captured.receivedModel.api, item.api);
    assert.equal(captured.options.apiKey, 'test-key');
    assert.equal(captured.options.timeoutMs, 1234);
    assert.equal(captured.options.cacheRetention, 'long');
    assert.equal(typeof captured.options.onPayload, 'function');
  }
});

test('pi usage 保留 reasoning 和缓存用量，reasoning 不重复计入 total', async () => {
  const { normalizePiUsageForTrace } = await import('../src/engine/agents/pi_runtime.js');
  const usage = normalizePiUsageForTrace({
    input: 50,
    output: 30,
    cacheRead: 20,
    cacheWrite: 10,
    reasoning: 12,
    totalTokens: 110,
    cost: {
      input: 0.05,
      output: 0.15,
      cacheRead: 0.01,
      cacheWrite: 0.02,
      total: 0.23,
    },
  });

  assert.equal(usage.prompt_tokens, 80);
  assert.equal(usage.completion_tokens, 30);
  assert.equal(usage.cached_tokens, 20);
  assert.equal(usage.cache_write_tokens, 10);
  assert.equal(usage.reasoning_tokens, 12);
  assert.equal(usage.total_tokens, 110, 'reasoning 已包含在 output 中，不能再次累加');
  assert.equal(usage.cost_usd, 0.23);
});
