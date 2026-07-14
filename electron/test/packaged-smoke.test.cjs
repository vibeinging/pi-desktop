const assert = require('node:assert/strict');
const test = require('node:test');
const { runPackagedSmoke } = require('../packaged-smoke.cjs');

function success(data, status = 200) {
  return { status, json: { success: status < 400, data, message: status < 400 ? 'ok' : 'not found' } };
}

function agentStream() {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    body: 'data: {"type":"message.delta","payload":{"content":"packaged smoke agent reply"}}\n\ndata: {"type":"run.completed"}\n\ndata: [DONE]\n\n',
  };
}

function persistedMessages() {
  return {
    items: [
      { content_items: [{ type: 'text', content: 'persist across packaged backend restart' }] },
      { content_items: [{ type: 'text', content: 'Reply with the packaged smoke response.' }] },
      { content_items: [{ type: 'markdown', content: 'packaged smoke agent reply' }] },
    ],
  };
}

function persistedTraces() {
  return {
    items: [{
      runId: 'r1',
      trace: {
        spanCount: 2,
        spans: [
          { kind: 'agent', name: 'Agent Run' },
          { kind: 'llm', name: 'LLM workspace_agent' },
        ],
      },
    }],
  };
}

test('打包 smoke 覆盖 Renderer、IPC、SQLite、配置、附件、重启恢复和删除', async () => {
  const calls = [];
  let restarted = false;
  let modelDeleted = false;
  let skillDeleted = false;
  let providerDeleted = false;
  const attachment = {
    path: '/tmp/pasted-text.txt',
    name: 'pasted-text.txt',
    size: Buffer.byteLength('persist attachment across packaged backend restart', 'utf8'),
  };
  const result = await runPackagedSmoke({
    inspectRenderer: async () => ({
      readyState: 'complete', hasRoot: true, hasElectronApi: true, bootScreenVisible: false,
    }),
    restartBackend: async () => { restarted = true; },
    modelBaseUrl: 'http://127.0.0.1:12345/v1',
    saveTextAttachment: async () => attachment,
    inspectAttachment: async () => ({
      exists: true,
      content: 'persist attachment across packaged backend restart',
    }),
    request: async ({ method, url }) => {
      calls.push(`${method} ${url}`);
      if (method === 'POST' && url === '/api/projects') return success({ id: 'p1' });
      if (method === 'POST' && url === '/api/projects/p1/sessions') return success({ id: 's1' });
      if (method === 'POST' && url.endsWith('/messages')) return success({ id: 'm1' });
      if (method === 'POST' && url === '/api/llm_model/create') {
        return success({ id: 'model1', model_name: 'packaged-smoke-model', api_key: '' });
      }
      if (method === 'POST' && url === '/api/agent/skills') {
        return success({ name: 'packaged-smoke-prompt', runtime: 'prompt' });
      }
      if (method === 'POST' && url === '/api/agent/mcp_providers') {
        return success({ provider_name: 'packaged-smoke-mcp', transport: 'stdio' });
      }
      if (method === 'POST' && url === '/api/agent/projects/p1/sessions/s1/chat') return agentStream();
      if (method === 'GET' && url.endsWith('/messages')) {
        return success(persistedMessages());
      }
      if (method === 'GET' && url.endsWith('/traces')) return success(persistedTraces());
      if (method === 'GET' && url === '/api/llm_model/detail?model_id=model1') {
        return modelDeleted
          ? success(null, 404)
          : success({ id: 'model1', model_name: 'packaged-smoke-model' });
      }
      if (method === 'GET' && url === '/api/agent/skills/packaged-smoke-prompt') {
        return skillDeleted
          ? success(null, 404)
          : success({ name: 'packaged-smoke-prompt', instructions: 'Return a short smoke-test response.' });
      }
      if (method === 'GET' && url === '/api/agent/mcp_providers/packaged-smoke-mcp') {
        return providerDeleted
          ? success(null, 404)
          : success({ provider_name: 'packaged-smoke-mcp', command: 'pi-smoke-mcp' });
      }
      if (method === 'POST' && url === '/api/llm_model/delete') {
        modelDeleted = true;
        return success(null);
      }
      if (method === 'DELETE' && url === '/api/agent/skills/packaged-smoke-prompt') {
        skillDeleted = true;
        return success({ name: 'packaged-smoke-prompt' });
      }
      if (method === 'DELETE' && url === '/api/agent/mcp_providers/packaged-smoke-mcp') {
        providerDeleted = true;
        return success({ provider_name: 'packaged-smoke-mcp' });
      }
      if (method === 'DELETE' && url === '/api/projects/p1/sessions/s1') return success({ id: 's1' });
      if (method === 'GET' && url === '/api/projects/p1/sessions/s1') return success(null, 404);
      if (method === 'DELETE' && url === '/api/projects/p1') return success({ id: 'p1' });
      throw new Error(`unexpected request: ${method} ${url}`);
    },
  });

  assert.equal(restarted, true);
  assert.equal(result.messageCount, 3);
  assert.equal(result.attachmentName, 'pasted-text.txt');
  assert.equal(result.traceSpanCount, 2);
  assert.equal(calls.filter((item) => item.endsWith('/messages')).length, 3);
});

test('打包 smoke 在 Renderer 不完整时明确失败', async () => {
  await assert.rejects(
    runPackagedSmoke({
      inspectRenderer: async () => ({
        readyState: 'complete', hasRoot: false, hasElectronApi: true, bootScreenVisible: false,
      }),
      restartBackend: async () => {},
      modelBaseUrl: 'http://127.0.0.1:12345/v1',
      saveTextAttachment: async () => null,
      inspectAttachment: async () => null,
      request: async () => success(null),
    }),
    /Renderer 根节点不存在/,
  );
});

test('打包 smoke 会发现后端重启后的 SQLite 数据丢失', async () => {
  let restarted = false;
  await assert.rejects(
    runPackagedSmoke({
      inspectRenderer: async () => ({
        readyState: 'complete', hasRoot: true, hasElectronApi: true, bootScreenVisible: false,
      }),
      restartBackend: async () => { restarted = true; },
      modelBaseUrl: 'http://127.0.0.1:12345/v1',
      saveTextAttachment: async () => ({
        path: '/tmp/pasted-text.txt',
        name: 'pasted-text.txt',
        size: Buffer.byteLength('persist attachment across packaged backend restart', 'utf8'),
      }),
      inspectAttachment: async () => ({
        exists: true,
        content: 'persist attachment across packaged backend restart',
      }),
      request: async ({ method, url }) => {
        if (method === 'POST' && url === '/api/projects') return success({ id: 'p1' });
        if (method === 'POST' && url === '/api/projects/p1/sessions') return success({ id: 's1' });
        if (method === 'POST' && url.endsWith('/messages')) return success({ id: 'm1' });
        if (method === 'POST' && url === '/api/llm_model/create') {
          return success({ id: 'model1', model_name: 'packaged-smoke-model', api_key: '' });
        }
        if (method === 'POST' && url === '/api/agent/skills') {
          return success({ name: 'packaged-smoke-prompt', runtime: 'prompt' });
        }
        if (method === 'POST' && url === '/api/agent/mcp_providers') {
          return success({ provider_name: 'packaged-smoke-mcp', transport: 'stdio' });
        }
        if (method === 'POST' && url === '/api/agent/projects/p1/sessions/s1/chat') return agentStream();
        if (method === 'GET' && url.endsWith('/messages')) {
          return success(restarted ? { items: [] } : persistedMessages());
        }
        if (method === 'GET' && url.endsWith('/traces')) return success(persistedTraces());
        throw new Error(`unexpected request: ${method} ${url}`);
      },
    }),
    /后端重启后会话消息没有恢复/,
  );
});

test('打包 smoke 会发现后端重启后的文本附件丢失', async () => {
  await assert.rejects(
    runPackagedSmoke({
      inspectRenderer: async () => ({
        readyState: 'complete', hasRoot: true, hasElectronApi: true, bootScreenVisible: false,
      }),
      restartBackend: async () => {},
      modelBaseUrl: 'http://127.0.0.1:12345/v1',
      saveTextAttachment: async () => ({
        path: '/tmp/pasted-text.txt',
        name: 'pasted-text.txt',
        size: Buffer.byteLength('persist attachment across packaged backend restart', 'utf8'),
      }),
      inspectAttachment: async () => ({ exists: false, content: '' }),
      request: async ({ method, url }) => {
        if (method === 'POST' && url === '/api/projects') return success({ id: 'p1' });
        if (method === 'POST' && url === '/api/projects/p1/sessions') return success({ id: 's1' });
        if (method === 'POST' && url.endsWith('/messages')) return success({ id: 'm1' });
        if (method === 'POST' && url === '/api/llm_model/create') {
          return success({ id: 'model1', model_name: 'packaged-smoke-model', api_key: '' });
        }
        if (method === 'POST' && url === '/api/agent/skills') {
          return success({ name: 'packaged-smoke-prompt', runtime: 'prompt' });
        }
        if (method === 'POST' && url === '/api/agent/mcp_providers') {
          return success({ provider_name: 'packaged-smoke-mcp', transport: 'stdio' });
        }
        if (method === 'POST' && url === '/api/agent/projects/p1/sessions/s1/chat') return agentStream();
        if (method === 'GET' && url.endsWith('/messages')) {
          return success(persistedMessages());
        }
        if (method === 'GET' && url.endsWith('/traces')) return success(persistedTraces());
        throw new Error(`unexpected request: ${method} ${url}`);
      },
    }),
    /后端重启后文本附件不存在/,
  );
});
