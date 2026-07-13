import { createProject, deleteProject, getProject, listProjects, updateProject } from '../app/projects/index.js';

export const projectRoutes = [
  { m: 'GET', p: '/api/projects', fn: listProjects },
  { m: 'POST', p: '/api/projects', fn: createProject },
  { m: 'GET', p: '/api/projects/:pid', fn: getProject },
  { m: 'PUT', p: '/api/projects/:pid', fn: updateProject },
  { m: 'DELETE', p: '/api/projects/:pid', fn: deleteProject },
];
