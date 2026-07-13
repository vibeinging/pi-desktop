import { describe, expect, it } from 'vitest'
import { mapServerMessage } from './streamAdapter'
import { applyWorkstationPatch, completeOpenPlanSteps, reduceStreamEvent } from './reducer'
import type { WorkstationDraft } from './types'

function draft(): WorkstationDraft {
  return { tools: new Map(), artifacts: new Map(), skills: new Map(), plan: [] }
}

describe('agent stream reducer', () => {
  it('maps answer and tool events to the chat and workstation', () => {
    const answer = reduceStreamEvent({
      v: 1,
      type: 'message.delta',
      visibility: 'primary',
      payload: { block_id: 'answer-1', channel: 'answer', format: 'markdown', content: 'hello' }
    })
    expect(answer.block).toMatchObject({ id: 'answer-1', type: 'markdown', content: 'hello' })

    const ws = draft()
    const tool = reduceStreamEvent({
      v: 1,
      type: 'tool.started',
      visibility: 'secondary',
      payload: { tool_call_id: 'tool-1', name: 'read', args_preview: '{"path":"README.md"}' }
    })
    applyWorkstationPatch(tool.workstation, ws)
    expect(ws.tools.get('tool-1')).toMatchObject({ name: 'read', where: 'local', status: 'running' })
  })

  it('maps persisted messages without exposing hidden runtime blocks', () => {
    const mapped = mapServerMessage({
      role: 'assistant',
      content_items: [
        { id: 'hidden', type: 'skill_invocation', content: '{}', metadata: { display: false } },
        { id: 'answer', type: 'markdown', content: '完成', metadata: { display: true } }
      ]
    })
    expect(mapped.blocks).toEqual([expect.objectContaining({ id: 'answer', content: '完成' })])
    expect(mapped.workstationBlocks).toHaveLength(2)
  })

  it('completes remaining plan steps after a successful run', () => {
    expect(completeOpenPlanSteps([
      { title: '读取文件', state: 'done' },
      { title: '整理结果', state: 'running' }
    ])).toEqual([
      { title: '读取文件', state: 'done' },
      { title: '整理结果', state: 'done' }
    ])
  })
})
