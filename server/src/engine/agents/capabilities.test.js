import test from 'node:test';
import assert from 'node:assert/strict';

import { probeCapabilities } from './capabilities.js';

test('metric configuration alone does not make QueryAgent available', async () => {
  const db = {
    query: async () => {
      throw new Error('QueryAgent capability probing must not query metric configuration');
    },
    queryOne: async () => {
      throw new Error('QueryAgent capability probing must not query metric configuration');
    },
  };

  const capabilities = await probeCapabilities(null, 'project_test', db);

  assert.deepEqual({ ...capabilities }, {
    has_structured: false,
    has_unstructured: false,
    has_web_search: false,
    has_any: false,
  });
});
