import { useEffect, useState } from 'react'
import { Button, Card, Group, Stack, TextInput, Textarea, Title } from '@mantine/core'
import { createProjectNote, deleteProjectNote, listProjectNotes, type ProjectNote } from './notes-api'

export default function ProjectNotesPage({ projectId }: { projectId: string }) {
  const [notes, setNotes] = useState<ProjectNote[]>([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const refresh = () => listProjectNotes(projectId).then((response: any) => setNotes(response.data?.data || response.data || []))
  useEffect(() => { refresh().catch(() => {}) }, [projectId])

  const create = async () => {
    await createProjectNote(projectId, { title, content })
    setTitle('')
    setContent('')
    await refresh()
  }

  return (
    <Stack p="lg">
      <Title order={2}>项目笔记</Title>
      <TextInput label="标题" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
      <Textarea label="内容" value={content} onChange={(event) => setContent(event.currentTarget.value)} />
      <Button onClick={create} disabled={!title.trim()}>保存笔记</Button>
      {notes.map((note) => (
        <Card key={note.id} withBorder>
          <Group justify="space-between">
            <strong>{note.title}</strong>
            <Button color="red" variant="subtle" onClick={async () => { await deleteProjectNote(projectId, note.id); await refresh() }}>
              删除
            </Button>
          </Group>
          <div>{note.content}</div>
        </Card>
      ))}
    </Stack>
  )
}
