import { useEffect, useMemo, useState } from 'react'
import { Badge, Box, Code, Divider, Group, Loader, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core'
import { getAgentSessionTraces, type AgentTraceRun, type AgentTraceSpan } from '@/api/agent'

export type ToolWhere = 'cloud' | 'local'
export type StepState = 'done' | 'running' | 'todo'
export type ArtifactKind = 'file' | 'table' | 'code' | 'image'

export interface PlanStep { title: string; detail?: string; state: StepState }
export interface ToolCall { name: string; where: ToolWhere; status: 'ok' | 'running' | 'pending' | 'error'; args?: string; result?: string }
export interface Artifact { name: string; meta?: string; kind: ArtifactKind }
export interface SkillTrace { name: string; runtime?: string | null; status?: string | null; reason?: string | null }

export interface WorkstationProps {
  projectId?: string
  sessionId?: string | null
  running?: boolean
  plan?: PlanStep[]
  tools?: ToolCall[]
  skills?: SkillTrace[]
  artifacts?: Artifact[]
  onCollapse?: () => void
  hideHeader?: boolean
}

function spanDuration(span: AgentTraceSpan) {
  const duration = Number(span.durMs || 0)
  if (duration >= 1000) return `${(duration / 1000).toFixed(duration >= 10_000 ? 1 : 2)}s`
  return `${Math.round(duration)}ms`
}

function spanColor(span: AgentTraceSpan) {
  if (span.status === 'error') return 'red'
  if (span.kind === 'llm') return 'violet'
  if (span.kind === 'tool') return 'blue'
  if (span.kind === 'agent') return 'teal'
  return 'gray'
}

export default function Workstation({ projectId, sessionId, running, plan = [], tools = [], skills = [], artifacts = [], hideHeader = false }: WorkstationProps) {
  const [traceRuns, setTraceRuns] = useState<AgentTraceRun[]>([])
  const [traceLoading, setTraceLoading] = useState(false)
  const [selectedSpanId, setSelectedSpanId] = useState('')

  useEffect(() => {
    if (!projectId || !sessionId) {
      setTraceRuns([])
      setSelectedSpanId('')
      return undefined
    }
    let cancelled = false
    setTraceLoading(true)
    void getAgentSessionTraces(projectId, sessionId, { limit: 10, resolveTrace: true })
      .then((res: any) => {
        if (cancelled) return
        const payload = res?.data || res || { items: [] }
        setTraceRuns(Array.isArray(payload.items) ? payload.items : [])
      })
      .catch(() => {
        if (!cancelled) setTraceRuns([])
      })
      .finally(() => {
        if (!cancelled) setTraceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId, running])

  const latestTrace = useMemo(
    () => traceRuns.find((run) => run.trace?.spans?.length)?.trace || null,
    [traceRuns]
  )
  const selectedSpan = useMemo(
    () => latestTrace?.spans.find((span) => span.id === selectedSpanId || span.externalSpanId === selectedSpanId) || null,
    [latestTrace, selectedSpanId]
  )

  return (
    <Stack h="100%" gap={0}>
      {!hideHeader && <Box p="sm"><Text fw={600}>Agent 工作台</Text></Box>}
      <ScrollArea style={{ flex: 1 }} p="sm">
        <Stack gap="lg">
          <section>
            <Group justify="space-between" mb="xs"><Text size="sm" fw={600}>计划</Text>{running && <Badge size="xs">运行中</Badge>}</Group>
            {plan.length ? plan.map((step, index) => <Text key={`${step.title}-${index}`} size="sm" c={step.state === 'done' ? 'dimmed' : undefined}>{step.state === 'done' ? '✓' : step.state === 'running' ? '●' : '○'} {step.title}</Text>) : <Text size="sm" c="dimmed">暂无计划</Text>}
          </section>
          <section>
            <Text size="sm" fw={600} mb="xs">工具</Text>
            {tools.length ? tools.map((tool, index) => <Group key={`${tool.name}-${index}`} justify="space-between"><Text size="sm">{tool.name}</Text><Badge size="xs" color={tool.status === 'error' ? 'red' : tool.status === 'running' ? 'blue' : 'gray'}>{tool.status}</Badge></Group>) : <Text size="sm" c="dimmed">暂无工具调用</Text>}
          </section>
          <section>
            <Group justify="space-between" mb="xs">
              <Text size="sm" fw={600}>Trace</Text>
              {latestTrace && <Badge size="xs" variant="light">{latestTrace.spanCount} spans</Badge>}
            </Group>
            {traceLoading ? (
              <Group gap="xs"><Loader size={12} /><Text size="xs" c="dimmed">读取运行记录</Text></Group>
            ) : latestTrace ? (
              <Stack gap={4}>
                {latestTrace.spans.slice(0, 100).map((span) => (
                  <UnstyledButton
                    key={`${span.id}-${span.order || 0}`}
                    onClick={() => setSelectedSpanId(String(span.externalSpanId || span.id))}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '6px 8px',
                      paddingLeft: `${8 + Math.min(8, Number(span.depth || 0)) * 12}px`,
                      borderRadius: 6,
                      background: selectedSpan === span ? 'var(--mantine-color-default-hover)' : undefined
                    }}
                  >
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Badge size="xs" color={spanColor(span)} variant="dot">{span.kind}</Badge>
                        <Text size="xs" truncate>{span.name}</Text>
                      </Group>
                      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{spanDuration(span)}</Text>
                    </Group>
                  </UnstyledButton>
                ))}
                {selectedSpan && (
                  <Box mt="xs">
                    <Divider mb="xs" />
                    <Group gap="xs" mb={6}>
                      <Text size="xs" fw={600}>{selectedSpan.name}</Text>
                      {!!selectedSpan.model && <Badge size="xs" variant="outline">{selectedSpan.model}</Badge>}
                      {!!(selectedSpan.inTok || selectedSpan.outTok) && (
                        <Text size="xs" c="dimmed">{selectedSpan.inTok || 0} / {selectedSpan.outTok || 0} tokens</Text>
                      )}
                    </Group>
                    {!!selectedSpan.input && <><Text size="xs" c="dimmed" mb={3}>输入</Text><Code block mb="xs" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{selectedSpan.input}</Code></>}
                    {!!selectedSpan.output && <><Text size="xs" c="dimmed" mb={3}>输出</Text><Code block style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{selectedSpan.output}</Code></>}
                  </Box>
                )}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed">完成一次对话后显示 Trace</Text>
            )}
          </section>
          {!!skills.length && <section><Text size="sm" fw={600} mb="xs">Skills</Text>{skills.map((skill) => <Text key={skill.name} size="sm">{skill.name}</Text>)}</section>}
          {!!artifacts.length && <section><Text size="sm" fw={600} mb="xs">产物</Text>{artifacts.map((artifact) => <Text key={artifact.name} size="sm">{artifact.name}</Text>)}</section>}
        </Stack>
      </ScrollArea>
    </Stack>
  )
}
