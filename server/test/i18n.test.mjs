import assert from 'node:assert/strict';
import test from 'node:test';

import { t } from '../src/engine/utils/i18n.js';

test('服务端通用错误文案按顺序填充参数', () => {
  assert.equal(t('请求 {} 失败: {}', 'chat', 429), '请求 chat 失败: 429');
  assert.equal(t('保留未填充参数: {}'), '保留未填充参数: {}');
});
