import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Project {
  id: string
  name?: string
  permissions?: string[]
  role?: string | null
  is_owner?: boolean
  [k: string]: any
}

export interface ProjectState {
  currentProject: Project | null
  projects: Project[]
  currentPermissions: string[]
  currentRole: string | null
  loading: boolean
  lastDetailFetchedAt: number

  setProjects: (projects: Project[]) => void
  setCurrentProject: (project: Project | null) => void
  hasPermission: (permission: string) => boolean
  hasAnyPermission: (permissions: string[]) => boolean
  hasAllPermissions: (permissions: string[]) => boolean
  clearProject: () => void
  resetState: () => void
  setLoading: (loading: boolean) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      currentProject: null,
      projects: [],
      currentPermissions: [],
      currentRole: null,
      loading: false,
      lastDetailFetchedAt: 0,

      setProjects: (projects) => set({ projects: projects || [] }),
      setCurrentProject: (project) => {
        if (project) {
          const projects = [...get().projects]
          const index = projects.findIndex((p) => p.id === project.id)
          if (index !== -1) projects[index] = { ...projects[index], ...project }
          set({
            currentProject: project,
            currentPermissions: project.permissions || [],
            currentRole: project.role || null,
            projects,
            lastDetailFetchedAt: Date.now()
          })
        } else {
          set({
            currentProject: null,
            currentPermissions: [],
            currentRole: null,
            lastDetailFetchedAt: Date.now()
          })
        }
      },
      hasPermission: (permission) => get().currentPermissions.includes(permission),
      hasAnyPermission: (permissions) => permissions.some((p) => get().hasPermission(p)),
      hasAllPermissions: (permissions) => permissions.every((p) => get().hasPermission(p)),
      clearProject: () => set({ currentProject: null, currentPermissions: [], currentRole: null }),
      resetState: () =>
        set({ currentProject: null, projects: [], currentPermissions: [], currentRole: null, loading: false }),
      setLoading: (loading) => set({ loading })
    }),
    {
      name: 'project',
      partialize: (s) => ({
        currentProject: s.currentProject,
        currentPermissions: s.currentPermissions,
        currentRole: s.currentRole
      })
    }
  )
)

/** 项目状态选择器 */
export const projectGetters = {
  hasProject: (s: ProjectState) => !!s.currentProject,
  currentProjectId: (s: ProjectState) => s.currentProject?.id || null,
  currentProjectName: (s: ProjectState) => s.currentProject?.name || ''
}
