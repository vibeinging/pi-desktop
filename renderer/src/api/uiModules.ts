import request from '@/utils/axios-req'

export interface UiModuleSummary {
  id: string
  module_key: string
  name: string
  description?: string
  icon?: string
  status: 'active' | 'disabled' | 'error' | 'incompatible' | string
  agent_exposure?: 'none' | 'draft' | 'published' | 'needs_review' | 'suspended' | string
  sidebar?: { visible?: boolean; group?: string; order?: number }
  current_version?: { id: string; version: string; schema_version?: number } | null
}

export interface UiModuleContent {
  manifest: Record<string, any>
  pages: Record<string, any>
  actions: Record<string, any>
}

export interface UiModuleStateSnapshot {
  module_id: string
  version_id: string
  state: Record<string, any>
  items: Array<{
    namespace: string
    key: string
    value: any
    revision: number
    updated_at?: string
  }>
  event_cursor?: { id: string; created_at: string } | null
}

export interface UiModuleDetail extends UiModuleSummary {
  version: {
    id: string
    version: string
    manifest: Record<string, any>
    pages: Record<string, any>
    actions: Record<string, any>
    blueprint?: Record<string, any> | null
    requirements?: Record<string, any> | null
    miniapp_package?: Record<string, any> | null
    compiler_version?: string | null
    runtime_version?: string | null
    state_schema?: Record<string, any> | null
  }
  granted_permissions?: string[]
  provider_bindings?: Record<string, any>
  agent_skill_exports?: Array<{
    id: string
    skill_name: string
    export_version: string
    status: 'draft' | 'ready' | 'published' | 'needs_review' | 'suspended' | string
    module_version_id: string
    contract?: Record<string, any>
  }>
  skill_product?: {
    id: string
    skill_name: string
    display_name?: string
    description?: string
    project_id?: string | null
    fingerprint: string
    permission: string
    status: string
    execution_mode?: 'interactive' | string
    automatic_safe?: boolean
  } | null
  skill_product_sessions?: Array<{
    id: string
    title: string
    status?: string
    message_count?: number
    created_at?: string
    updated_at?: string
    last_run_at?: string
  }>
}

export interface UiModuleDraft {
  id: string
  module_id?: string | null
  module_key: string
  revision: number
  status: string
  content: UiModuleContent
  validation_hash?: string | null
}

export const listUiModules = (status?: string) =>
  request({ url: '/api/ui-modules', method: 'get', params: status ? { status } : undefined, ignoreMsg: true })

export const getUiModule = (moduleId: string) =>
  request({ url: `/api/ui-modules/${encodeURIComponent(moduleId)}`, method: 'get' })

export const getUiModuleDraft = (draftId: string) =>
  request({ url: `/api/ui-module-drafts/${encodeURIComponent(draftId)}`, method: 'get' })

export const createUiSkillProductDraft = (data: Record<string, any>) =>
  request({ url: '/api/ui-skill-products/drafts', method: 'post', data })

export const previewUiModuleDraft = (draftId: string, data: Record<string, any>) =>
  request({ url: `/api/ui-module-drafts/${encodeURIComponent(draftId)}/preview`, method: 'post', data })

export const runUiModuleAction = (moduleId: string, actionName: string, data: Record<string, any>) =>
  request({
    url: `/api/ui-modules/${encodeURIComponent(moduleId)}/actions/${encodeURIComponent(actionName)}`,
    method: 'post',
    data
  })

export const getUiModuleState = (moduleId: string, versionId: string) =>
  request({
    url: `/api/ui-modules/${encodeURIComponent(moduleId)}/state`,
    method: 'get',
    params: { version_id: versionId },
    ignoreMsg: true
  })

export const createMiniAppAgentExport = (moduleId: string, data: Record<string, any>) =>
  request({ url: `/api/ui-modules/${encodeURIComponent(moduleId)}/agent-exports`, method: 'post', data })

export const validateMiniAppAgentExport = (exportId: string) =>
  request({ url: `/api/ui-module-agent-exports/${encodeURIComponent(exportId)}/validate`, method: 'post' })

export const publishMiniAppAgentExport = (exportId: string, validationHash: string) =>
  request({
    url: `/api/ui-module-agent-exports/${encodeURIComponent(exportId)}/publish`,
    method: 'post',
    data: { validation_hash: validationHash }
  })

export const suspendMiniAppAgentExport = (exportId: string) =>
  request({ url: `/api/ui-module-agent-exports/${encodeURIComponent(exportId)}/suspend`, method: 'post' })
