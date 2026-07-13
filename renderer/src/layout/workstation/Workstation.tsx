import { Badge, Box, Group, ScrollArea, Stack, Text } from '@mantine/core'

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

export default function Workstation({ running, plan = [], tools = [], skills = [], artifacts = [], hideHeader = false }: WorkstationProps) {
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
          {!!skills.length && <section><Text size="sm" fw={600} mb="xs">Skills</Text>{skills.map((skill) => <Text key={skill.name} size="sm">{skill.name}</Text>)}</section>}
          {!!artifacts.length && <section><Text size="sm" fw={600} mb="xs">产物</Text>{artifacts.map((artifact) => <Text key={artifact.name} size="sm">{artifact.name}</Text>)}</section>}
        </Stack>
      </ScrollArea>
    </Stack>
  )
}
