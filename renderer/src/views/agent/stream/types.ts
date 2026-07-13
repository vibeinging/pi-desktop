import type { Artifact, PlanStep, SkillTrace, ToolCall } from '@/layout/workstation/Workstation'

export interface AgentBlock {
  id: string
  type: string
  content: string
  title?: string
  display_type?: string
  metadata?: any
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  blocks: AgentBlock[]
  workstationBlocks?: AgentBlock[]
}

export interface AgentStreamEventV1 {
  v: 1
  type: string
  run_id?: string | null
  session_id?: string | null
  message_id?: string | null
  seq?: number
  ts?: string
  visibility?: 'primary' | 'secondary' | 'hidden' | 'action'
  payload?: any
}

export interface WorkstationPatch {
  plan?: PlanStep[]
  tool?: { id: string; value: ToolCall }
  toolResult?: { id: string; result: string }
  artifact?: { id: string; value: Artifact }
  skill?: { id: string; value: SkillTrace }
}

export interface AgentStreamPatch {
  block?: AgentBlock
  workstation?: WorkstationPatch
  scrollDelayMs?: number
  ignored?: boolean
}

export interface WorkstationDraft {
  tools: Map<string, ToolCall>
  artifacts: Map<string, Artifact>
  skills: Map<string, SkillTrace>
  plan: PlanStep[]
}

export type { Artifact, PlanStep, SkillTrace, ToolCall }
