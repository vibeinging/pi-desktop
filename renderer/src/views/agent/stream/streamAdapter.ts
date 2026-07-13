import type { AgentBlock, AgentMessage } from './types'

export function parseSseJsonLine(line: string): any | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

export function isCompletedRunEvent(event: any) {
  return event?.v === 1 && event?.type === 'run.completed' && (!event?.payload?.status || event.payload.status === 'completed')
}

export function isFailedRunEvent(event: any) {
  return event?.v === 1 && event?.type === 'run.failed'
}

export function isTerminalRunEvent(event: any) {
  if (event?.v !== 1) return false
  return ['run.completed', 'run.failed', 'run.suspended', 'run.cancelled', 'run.expired'].includes(String(event.type || ''))
}

export function mapServerMessage(m: any): AgentMessage {
  let ci = m.content_items
  if (typeof ci === 'string') {
    try {
      ci = JSON.parse(ci)
    } catch {
      ci = []
    }
  }
  if (!Array.isArray(ci)) ci = []
  const allBlocks = ci.map((it: any, idx: number): AgentBlock => ({
    id: it.id || `b${idx}`,
    type: it.type || 'text',
    content: typeof it.content === 'string' ? it.content : JSON.stringify(it.content ?? ''),
    title: it.title,
    display_type: it.display_type,
    metadata: it.metadata
  }))
  return {
    role: m.role === 'user' ? 'user' : 'assistant',
    blocks: allBlocks.filter((it: AgentBlock) => it?.metadata?.display !== false && it?.type !== 'skill_invocation' && it?.type !== 'workspace_event'),
    workstationBlocks: allBlocks
  }
}
