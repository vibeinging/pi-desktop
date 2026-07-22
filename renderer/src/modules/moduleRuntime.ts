import type { UiModuleContent } from '@/api/uiModules'

export function modulePageData(content: UiModuleContent | null, pageId: string, previewMode = false) {
  const page = content?.pages?.[pageId]
  const initial = previewMode ? (page?.mockData || page?.data || {}) : (page?.data || page?.mockData || {})
  return initial && typeof initial === 'object' && !Array.isArray(initial) ? initial : {}
}

export function initialModuleData(content: UiModuleContent | null, previewMode = false) {
  const manifest = content?.manifest || {}
  const entryPage = manifest.entryPage || Object.keys(content?.pages || {})[0]
  return modulePageData(content, entryPage, previewMode)
}

export function initialModuleDataByPage(content: UiModuleContent | null, previewMode = false) {
  return Object.fromEntries(
    Object.keys(content?.pages || {}).map((pageId) => [pageId, modulePageData(content, pageId, previewMode)])
  )
}

export function setModuleDataPath(current: Record<string, any>, target: string, value: any) {
  const path = String(target || '').replace(/^\$data\./, '').split('.').filter(Boolean)
  if (!path.length) return current
  const root = { ...current }
  let output: Record<string, any> = root
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      output[key] = value
      break
    }
    const child = output[key]
    output[key] = child && typeof child === 'object' && !Array.isArray(child) ? { ...child } : {}
    output = output[key]
  }
  return root
}

export function moduleStateFromItems(items: Array<{ namespace?: string; key?: string; value?: any }> = []) {
  const state: Record<string, any> = {}
  for (const item of items) {
    const namespace = String(item?.namespace || 'default')
    const key = String(item?.key || '')
    if (!key) continue
    if (namespace === 'default') state[key] = item.value
    else state[namespace] = { ...(state[namespace] || {}), [key]: item.value }
  }
  return state
}

export function setModuleStateEntry(
  current: Record<string, any>,
  entry: { namespace?: string; key?: string; value?: any }
) {
  const namespace = String(entry?.namespace || 'default')
  const key = String(entry?.key || '')
  if (!key) return current
  if (namespace === 'default') return { ...current, [key]: entry.value }
  return {
    ...current,
    [namespace]: { ...(current[namespace] || {}), [key]: entry.value }
  }
}
