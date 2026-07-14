CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  title TEXT NOT NULL DEFAULT '新对话',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  session_config TEXT,
  session_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
  ON sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project_status_deleted_updated
  ON sessions(project_id, status, deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content_items TEXT NOT NULL DEFAULT '[]',
  message_metadata TEXT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  parent_message_id TEXT REFERENCES session_messages(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_sequence
  ON session_messages(session_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_session_messages_active_sequence
  ON session_messages(session_id, deleted_at, sequence_number);

CREATE TABLE IF NOT EXISTS agent_transcript_messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  message_json TEXT NOT NULL CHECK (json_valid(message_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_agent_transcript_session_sequence
  ON agent_transcript_messages(session_id, sequence_number);

CREATE TABLE IF NOT EXISTS agent_transcript_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  source_sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (source_sequence_number >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  skill_name TEXT,
  mode TEXT,
  checkpoint_json TEXT,
  metadata_json TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created
  ON agent_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated
  ON agent_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_pending_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE,
  input_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  response_json TEXT,
  resume_handle_json TEXT,
  resume_expires_at TEXT,
  record_expires_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_pending_inputs_run_status
  ON agent_pending_inputs(run_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS llm_models (
  id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  display_name TEXT,
  category TEXT NOT NULL DEFAULT 'PRIMARY' CHECK (category IN ('PRIMARY', 'SECONDARY', 'EMBEDDING')),
  api_key TEXT,
  api_base TEXT,
  api_format TEXT NOT NULL DEFAULT 'chat_completions' CHECK (api_format IN ('anthropic', 'chat_completions', 'responses')),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  extra_config TEXT,
  project_id TEXT REFERENCES projects(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS project_model_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('PRIMARY', 'SECONDARY', 'EMBEDDING')),
  llm_model_id TEXT NOT NULL REFERENCES llm_models(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, category)
);

CREATE INDEX IF NOT EXISTS idx_project_model_configs_model
  ON project_model_configs(llm_model_id);

CREATE TABLE IF NOT EXISTS app_skills (
  id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  default_enabled INTEGER NOT NULL DEFAULT 1 CHECK (default_enabled IN (0, 1)),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  runtime TEXT,
  description TEXT,
  config TEXT,
  instructions TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_skills_active_name
  ON app_skills(is_active, skill_name);

CREATE TABLE IF NOT EXISTS project_skills (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  skill_name TEXT NOT NULL,
  skill_id TEXT REFERENCES app_skills(id) ON UPDATE CASCADE ON DELETE SET NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  enabled_override INTEGER CHECK (enabled_override IS NULL OR enabled_override IN (0, 1)),
  config TEXT,
  config_override TEXT,
  skill_template TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE(project_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_project_skills_project_enabled
  ON project_skills(project_id, is_enabled, skill_name);

CREATE TABLE IF NOT EXISTS app_mcp_providers (
  id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL,
  command TEXT,
  args TEXT,
  env TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  default_enabled INTEGER NOT NULL DEFAULT 1 CHECK (default_enabled IN (0, 1)),
  tool_cache TEXT,
  last_discovered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_mcp_providers_active_name
  ON app_mcp_providers(is_active, provider_name);

CREATE TABLE IF NOT EXISTS project_mcp_providers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  provider_name TEXT NOT NULL,
  provider_id TEXT REFERENCES app_mcp_providers(id) ON UPDATE CASCADE ON DELETE SET NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  enabled_override INTEGER CHECK (enabled_override IS NULL OR enabled_override IN (0, 1)),
  config TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  UNIQUE(project_id, provider_name)
);

CREATE INDEX IF NOT EXISTS idx_project_mcp_providers_project_enabled
  ON project_mcp_providers(project_id, is_enabled, provider_name);
CREATE INDEX IF NOT EXISTS idx_project_mcp_providers_provider
  ON project_mcp_providers(provider_id);
