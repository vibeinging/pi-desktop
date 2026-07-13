import * as models from '../app/models/index.js';

export const modelRoutes = [
  { m: 'GET', p: '/api/llm_model/llm_models', fn: models.listModels },
  { m: 'GET', p: '/api/llm_model/active', fn: models.listActiveModels },
  { m: 'GET', p: '/api/llm_model/detail', fn: models.getModelDetail },
  { m: 'POST', p: '/api/llm_model/create', fn: models.createModel },
  { m: 'POST', p: '/api/llm_model/update', fn: models.updateModel },
  { m: 'POST', p: '/api/llm_model/delete', fn: models.deleteModel },
  { m: 'POST', p: '/api/llm_model/test-config', fn: models.testModelConfig },
  { m: 'GET', p: '/api/projects/:pid/models', fn: models.listProjectModels },
  { m: 'POST', p: '/api/projects/:pid/models', fn: models.createProjectModel },
  { m: 'PUT', p: '/api/projects/:pid/models', fn: models.updateProjectModel },
  { m: 'DELETE', p: '/api/projects/:pid/models/:modelId', fn: models.deleteProjectModel },
];
