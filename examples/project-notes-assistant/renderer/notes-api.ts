import axiosReq from '@/utils/axios-req'

export type ProjectNote = {
  id: string
  project_id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

export const listProjectNotes = (projectId: string) =>
  axiosReq<ProjectNote[]>({ url: `/api/projects/${projectId}/notes`, method: 'get' })

export const createProjectNote = (projectId: string, data: Pick<ProjectNote, 'title' | 'content'>) =>
  axiosReq<ProjectNote>({ url: `/api/projects/${projectId}/notes`, method: 'post', data })

export const deleteProjectNote = (projectId: string, noteId: string) =>
  axiosReq({ url: `/api/projects/${projectId}/notes/${noteId}`, method: 'delete' })
