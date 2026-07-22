import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbModelConfigProvider } from '../../engine/core/model_config_provider.js';

test('图片处理指定模型时按模型 ID 精确读取配置', async () => {
  let captured = null;
  const provider = createDbModelConfigProvider({
    queryOne: async (sql, params) => {
      captured = { sql, params };
      return { id: 'vision-1', model_name: 'vision-model', api_base: 'https://example.test/v1', api_key: 'key', category: 'SECONDARY' };
    },
  });

  const config = await provider({ model_id: 'vision-1', project_id: 'project-1', category: 'SECONDARY' });
  assert.deepEqual(captured.params, ['vision-1']);
  assert.match(captured.sql, /WHERE id=\$1/);
  assert.equal(config.model_name, 'vision-model');
});

test('未指定图片模型时只读取 SECONDARY 模型', async () => {
  let captured = null;
  const provider = createDbModelConfigProvider({
    queryOne: async (sql, params) => {
      captured = { sql, params };
      return { id: 'secondary-1', model_name: 'secondary-model', api_base: 'https://example.test/v1', api_key: 'key', category: 'SECONDARY' };
    },
  });

  await provider({ project_id: 'project-1', category: 'SECONDARY' });
  assert.deepEqual(captured.params, ['project-1', 'SECONDARY']);
  assert.match(captured.sql, /AND category = \$2/);
});
