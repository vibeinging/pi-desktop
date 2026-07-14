import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const notes = []
const server = new McpServer({ name: 'project-notes-example', version: '0.1.0' })

server.tool('list_notes', '列出本次 MCP 进程中的项目笔记', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }],
}))

server.tool('add_note', '新增一条项目笔记', {
  title: z.string().min(1),
  content: z.string(),
}, async ({ title, content }) => {
  const note = { id: randomUUID(), title: title.trim(), content, created_at: new Date().toISOString() }
  notes.push(note)
  return { content: [{ type: 'text', text: JSON.stringify(note) }] }
})

await server.connect(new StdioServerTransport())
