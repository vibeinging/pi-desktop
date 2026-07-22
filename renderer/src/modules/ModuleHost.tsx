import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { IconAlertTriangle, IconArrowLeft, IconRefresh } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import {
  getUiModule,
  getUiModuleDraft,
  getUiModuleState,
  runUiModuleAction,
  type UiModuleContent,
  type UiModuleDetail
} from '@/api/uiModules'
import YiWConversation from '@/views/agent/YiWConversation'
import SchemaRenderer, { resolveModuleValue, type ModuleActionBinding } from './SchemaRenderer'
import {
  initialModuleDataByPage,
  moduleStateFromItems,
  setModuleDataPath,
  setModuleStateEntry
} from './moduleRuntime'
import styles from './modules.module.scss'

class ModuleErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* 错误只限制在模块区域 */ }
  render() {
    if (!this.state.error) return this.props.children
    return <div className={styles.hostState}><IconAlertTriangle size={28} /><strong>这个模块暂时无法显示</strong><span>{this.state.error.message}</span><button onClick={() => { this.setState({ error: null }); this.props.onReset() }}>重新加载</button></div>
  }
}

interface ModuleHostProps {
  moduleId?: string | null
  draftId?: string | null
  previewContent?: UiModuleContent | null
  initialPageId?: string | null
  onBack?: () => void
}

function responseData(value: any) {
  return value?.data ?? value
}

function moduleRequestId() {
  return globalThis.crypto?.randomUUID?.() || `ui-module-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function resolveInput(value: any, data: Record<string, any>, state: Record<string, any>, event: Record<string, any>): any {
  if (Array.isArray(value)) return value.map((item) => resolveInput(item, data, state, event))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, data, state, event)]))
  }
  return resolveModuleValue(value, data, state, event)
}

type AgentIntentRequest = {
  id: string
  actionName: string
  command: string
  title: string
  input: Record<string, any>
}

function containsComponent(value: any, type: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsComponent(item, type))
  if (!value || typeof value !== 'object') return false
  if (value.type === type) return true
  return Object.values(value).some((item) => containsComponent(item, type))
}

function ProductAgentWorkspace({
  moduleId,
  detail,
  preview,
  intentRequest,
  onIntentConsumed,
  onStateChanged
}: {
  moduleId?: string | null
  detail: UiModuleDetail | null
  preview: boolean
  intentRequest: AgentIntentRequest | null
  onIntentConsumed: (id: string) => void
  onStateChanged: () => void
}) {
  const product = detail?.skill_product
  const versionId = detail?.version?.id
  const storageKey = moduleId && versionId ? `yiw-skill-product-session:${moduleId}:${versionId}` : ''
  const productSessions = detail?.skill_product_sessions || []
  const productSessionIds = productSessions.map((item) => item.id).join(',')
  const resolveStoredSession = () => {
    if (!storageKey) return null
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored && productSessions.some((item) => item.id === stored)) return stored
    } catch { /* 使用服务端记录兜底 */ }
    return productSessions[0]?.id || null
  }
  const [sessionId, setSessionId] = useState<string | null>(resolveStoredSession)
  const activeStorageKeyRef = useRef(storageKey)

  useEffect(() => {
    setSessionId(resolveStoredSession())
  }, [storageKey, productSessionIds])

  useEffect(() => {
    if (!storageKey) return
    if (activeStorageKeyRef.current !== storageKey) {
      activeStorageKeyRef.current = storageKey
      return
    }
    try {
      if (sessionId) localStorage.setItem(storageKey, sessionId)
      else localStorage.removeItem(storageKey)
    } catch { /* 本地会话记忆失败不影响运行 */ }
  }, [sessionId, storageKey])

  if (preview) {
    return <div className={styles.agentPreview}><strong>专属 Agent 工作台</strong><span>安装后，这里会使用当前 Skill 快照持续对话、执行任务并保留结果。</span></div>
  }
  if (!moduleId || !versionId || !product?.id) {
    return <div className={styles.componentError}>Skill Product 执行绑定缺失，请重新安装这个版本</div>
  }
  const projectId = product.project_id || '__chat__'
  return (
    <div className={styles.agentWorkspace}>
      <YiWConversation
        projectId={projectId}
        selectedId={sessionId}
        onSessionCreated={setSessionId}
        conversations={productSessions.map((item) => ({ id: item.id, title: item.title }))}
        showThinking
        sessionKind="skill_product"
        fixedApproval="ask"
        onAfterComplete={onStateChanged}
        externalDispatch={intentRequest ? {
          id: intentRequest.id,
          message: `执行小程序命令：${intentRequest.title || intentRequest.command}`,
          displayMessage: intentRequest.title || intentRequest.command,
          extra: {
            miniapp_command: {
              action_name: intentRequest.actionName,
              request_id: intentRequest.id,
              input: intentRequest.input
            }
          }
        } : null}
        onExternalDispatchConsumed={onIntentConsumed}
        requestExtra={{
          module_id: moduleId,
          version_id: versionId,
          skill_binding_id: product.id
        }}
      />
    </div>
  )
}

export default function ModuleHost({ moduleId, draftId, previewContent, initialPageId, onBack }: ModuleHostProps) {
  const [content, setContent] = useState<UiModuleContent | null>(null)
  const [detail, setDetail] = useState<UiModuleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dataByPage, setDataByPage] = useState<Record<string, Record<string, any>>>({})
  const [state, setState] = useState<Record<string, any>>({})
  const [reloadKey, setReloadKey] = useState(0)
  const [activePageId, setActivePageId] = useState('')
  const [agentIntent, setAgentIntent] = useState<AgentIntentRequest | null>(null)
  const [stateRefreshKey, setStateRefreshKey] = useState(0)
  const pendingActionsRef = useRef(new Set<string>())

  const refreshModuleState = useCallback(async () => {
    if (!moduleId || draftId || !detail?.version?.id) return
    try {
      const snapshot = responseData(await getUiModuleState(moduleId, detail.version.id))
      setState(snapshot?.state || moduleStateFromItems(snapshot?.items || []))
      setStateRefreshKey((value) => value + 1)
    } catch {
      // 状态刷新失败不清空当前页面，用户仍可通过重新加载恢复。
    }
  }, [detail?.version?.id, draftId, moduleId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        if (draftId) {
          const draft = previewContent ? { content: previewContent } : responseData(await getUiModuleDraft(draftId))
          if (!alive) return
          const nextContent = draft.content as UiModuleContent
          setDetail(null)
          setContent(nextContent)
          setDataByPage(initialModuleDataByPage(nextContent, true))
          setState({})
        } else if (moduleId) {
          const module = responseData(await getUiModule(moduleId))
          if (!alive) return
          const nextContent = { manifest: module.version.manifest, pages: module.version.pages, actions: module.version.actions }
          setDetail(module)
          setContent(nextContent)
          setDataByPage(initialModuleDataByPage(nextContent))
          const snapshot = responseData(await getUiModuleState(moduleId, module.version.id).catch(() => null))
          if (!alive) return
          setState(snapshot?.state || moduleStateFromItems(snapshot?.items || []))
        } else {
          setContent(null)
          setDataByPage({})
          setState({})
        }
      } catch (reason: any) {
        if (alive) setError(reason?.message || reason?.msg || '模块加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [draftId, moduleId, previewContent, reloadKey])

  const manifest = content?.manifest || {}
  const entryPage = manifest.entryPage || Object.keys(content?.pages || {})[0]
  const navigation = Array.isArray(manifest.navigation) && manifest.navigation.length
    ? manifest.navigation
    : Object.keys(content?.pages || {}).map((pageId) => ({ page: pageId, label: content?.pages?.[pageId]?.title || pageId }))
  const resolvedPageId = activePageId && content?.pages?.[activePageId] ? activePageId : entryPage
  const page = content?.pages?.[resolvedPageId]
  const data = dataByPage[resolvedPageId] || {}

  useEffect(() => {
    const requestedPage = initialPageId && content?.pages?.[initialPageId] ? initialPageId : ''
    setActivePageId(requestedPage || entryPage || '')
  }, [content?.pages, draftId, entryPage, initialPageId, moduleId])

  const execute = useCallback(async (binding: ModuleActionBinding, event: Record<string, any> = {}) => {
    if (!binding?.action) return
    if (!moduleId || draftId) {
      notifications.show({ color: 'blue', message: '预览模式不会调用真实数据接口' })
      return
    }
    if (!detail?.version?.id) {
      notifications.show({ color: 'red', message: '模块版本信息缺失，请重新加载' })
      return
    }
    if (pendingActionsRef.current.has(binding.action)) return
    const rawInput = binding.input === undefined ? event : resolveInput(binding.input, data, state, event)
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : { value: rawInput }
    pendingActionsRef.current.add(binding.action)
    try {
      const requestId = moduleRequestId()
      const response = responseData(await runUiModuleAction(moduleId, binding.action, {
        input,
        version_id: detail.version.id,
        request_id: requestId
      }))
      const result = response?.data ?? response
      const action = content?.actions?.[binding.action]
      if (action?.type === 'state.set' && result?.key) {
        setState((current) => setModuleStateEntry(current, result))
      }
      for (const patch of response?.state_patch || []) {
        setState((current) => setModuleStateEntry(current, patch))
      }
      if (action?.type === 'agent.intent' && result?.kind === 'agent.intent') {
        setAgentIntent({
          id: requestId,
          actionName: result.action_name || binding.action,
          command: result.command || action.command || binding.action,
          title: result.title || action.title || result.command || binding.action,
          input: result.input && typeof result.input === 'object' ? result.input : input
        })
        const workspacePage = Object.entries(content?.pages || {})
          .find(([, candidate]) => containsComponent(candidate?.layout, 'AgentWorkspace'))?.[0]
        if (workspacePage) setActivePageId(workspacePage)
      }
      if (binding.target) {
        setDataByPage((current) => ({
          ...current,
          [resolvedPageId]: setModuleDataPath(current[resolvedPageId] || {}, binding.target!, result)
        }))
      }
    } catch (reason: any) {
      notifications.show({ color: 'red', message: reason?.message || reason?.msg || `动作 ${binding.action} 执行失败` })
    } finally {
      pendingActionsRef.current.delete(binding.action)
    }
  }, [content?.actions, content?.pages, data, detail?.version?.id, draftId, moduleId, resolvedPageId, state])

  const executeRef = useRef(execute)
  executeRef.current = execute

  const onLoadKey = useMemo(() => JSON.stringify(page?.onLoad || []), [page?.onLoad])
  useEffect(() => {
    if (!page || draftId || !moduleId) return
    const items = Array.isArray(page.onLoad) ? page.onLoad : page.onLoad ? [page.onLoad] : []
    let cancelled = false
    void (async () => {
      for (const item of items) {
        if (cancelled) return
        await executeRef.current(typeof item === 'string' ? { action: item } : item)
      }
    })()
    return () => { cancelled = true }
  }, [draftId, moduleId, onLoadKey, resolvedPageId, stateRefreshKey])

  if (loading) return <div className={styles.hostState}>正在加载模块…</div>
  if (error) return <div className={styles.hostState}><IconAlertTriangle size={28} /><strong>模块加载失败</strong><span>{error}</span><button onClick={() => setReloadKey((value) => value + 1)}><IconRefresh size={15} />重新加载</button></div>
  if (!content || !page?.layout) return <div className={styles.hostState}>模块没有可显示的页面</div>

  return (
    <ModuleErrorBoundary onReset={() => setReloadKey((value) => value + 1)}>
      <div className={styles.host} key={`${moduleId || draftId}-${reloadKey}`}>
        <header className={styles.hostHeader}>
          <div>
            {onBack && <button type="button" className={styles.back} onClick={onBack} aria-label="返回对话"><IconArrowLeft size={17} /></button>}
            <span className={styles.hostIcon}>{manifest.icon === 'chart-candlestick' ? '⌁' : '✦'}</span>
            <div><h1>{manifest.name || detail?.name || '模块'}</h1><p>{manifest.description || detail?.description || ''}</p></div>
          </div>
          <span className={styles.version}>{draftId ? '预览' : `v${detail?.version?.version || manifest.version || ''}`}</span>
        </header>
        {navigation.length > 1 && (
          <nav className={styles.productNav} aria-label={`${manifest.name || '产品'}页面`}>
            {navigation.map((item: any) => (
              <button
                key={item.page}
                type="button"
                data-active={resolvedPageId === item.page ? 'true' : undefined}
                onClick={() => setActivePageId(item.page)}
              >
                {item.label || content.pages?.[item.page]?.title || item.page}
              </button>
            ))}
          </nav>
        )}
        <main className={styles.modulePage}>
          <SchemaRenderer
            node={page.layout}
            data={data}
            state={state}
            onAction={execute}
            renderSpecial={(node) => node.type === 'AgentWorkspace'
              ? <ProductAgentWorkspace
                  moduleId={moduleId}
                  detail={detail}
                  preview={Boolean(draftId)}
                  intentRequest={agentIntent}
                  onIntentConsumed={(id) => setAgentIntent((current) => current?.id === id ? null : current)}
                  onStateChanged={() => { void refreshModuleState() }}
                />
              : null}
          />
        </main>
      </div>
    </ModuleErrorBoundary>
  )
}
