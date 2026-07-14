import { projectRoutes } from './registry.projects.js';
import { sessionRoutes } from './registry.session.js';
import { chatRoutes } from './registry.chat.js';
import { modelRoutes } from './registry.models.js';
import { mcpRoutes } from './registry.mcp.js';
import { skillRoutes } from './registry.skills.js';
import { credentialRoutes } from './registry.credentials.js';
import { observabilityRoutes } from './registry.observability.js';

export const ROUTES = [...projectRoutes, ...sessionRoutes, ...modelRoutes, ...mcpRoutes, ...skillRoutes, ...credentialRoutes, ...observabilityRoutes, ...chatRoutes];
