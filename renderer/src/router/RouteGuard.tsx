import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom'
import { progressClose, progressStart } from '@/hooks/use-permission'
import { useBasicStore } from '@/store/basic'
import { useProjectStore } from '@/store/project'
import { getUserProfileReq, builtinLoginReq } from '@/api/user'
import { getMyProjectsReq, getProjectDetailReq } from '@/api/project'
import { permissionManager } from '@/permission/index'
import type { RouteMeta } from './routes'

const WHITE_LIST = ['/agent', '/404', '/401']

const isWhitelisted = (path: string) => {
  if (WHITE_LIST.includes(path)) return true
  return false
}

interface NavTarget {
  path: string
  meta: RouteMeta
  params: Record<string, string | undefined>
}

let desktopBuiltinLoginPromise: Promise<boolean> | null = null

function applyBuiltinIdentity(res: any) {
  if (!res?.success || !res.data?.access_token) return false
  const basic = useBasicStore.getState()
  const ui = res.data.user_info || {}
  basic.setToken(res.data.access_token)
  basic.setUserInfo({
    userInfo: {
      userId: ui.user_id,
      username: ui.username,
      email: ui.email,
      avatar: ui.avatar_url,
      is_admin: ui.is_admin || false,
      can_create_project: ui.can_create_project || false
    }
  })
  return true
}

async function ensureDesktopBuiltinIdentity() {
  if (!(window as any).electronAPI?.apiRequest) return false
  if (!desktopBuiltinLoginPromise) {
    desktopBuiltinLoginPromise = builtinLoginReq()
      .then(applyBuiltinIdentity)
      .catch(() => {
        desktopBuiltinLoginPromise = null
        return false
      })
  }
  return desktopBuiltinLoginPromise
}

/**
 * 全局路由守卫(对齐原 permission.js 的 router.beforeEach)。
 * 通过 useMatches 取目标路由 meta，跑权限流程：未通过 → navigate(replace) 到目标；通过 → 渲染 <Outlet/>。
 */
async function resolveGuard(to: NavTarget): Promise<string | null> {
  // 公开页面直接放行
  if (to.meta?.public || to.path.startsWith('/share/')) return null

  const basic = useBasicStore.getState()

  basic.setFilterAsyncRoutes([])

  // 桌面版始终刷新成固定的内置用户。不能只检查持久化 token 是否为空：
  // 老版本可能留下仍然有效的随机用户 token，导致 Agent 安装成功后当前界面看不到模块。
  const desktopBuiltinReady = await ensureDesktopBuiltinIdentity()

  // 浏览器开发环境保持原来的免登录回退。
  if (!desktopBuiltinReady && !basic.token) {
    try {
      const res: any = await builtinLoginReq()
      applyBuiltinIdentity(res)
    } catch {
      /* 内置登录失败时继续由主界面处理空状态 */
    }
  }

  // 1. 白名单(setToken 后 basic 快照已过期,重新读最新 token)
  if (!useBasicStore.getState().token) {
    return isWhitelisted(to.path) ? null : '/agent'
  }

  // 2. 加载用户信息
  if (!basic.userInfo?.username) {
    try {
      const res: any = await getUserProfileReq()
      if (res.success && res.data) {
        basic.setUserInfo({
          userInfo: {
            userId: res.data.user_id,
            username: res.data.username,
            email: res.data.email,
            avatar: res.data.avatar_url,
            is_admin: res.data.is_admin || false,
            can_create_project: res.data.can_create_project || false
          }
        })
      } else {
        basic.resetStateAndToLogin()
        return '/agent'
      }
    } catch {
      basic.resetStateAndToLogin()
      return '/agent'
    }
  }

  // 3. 管理员权限检查
  if (to.meta?.requireAdmin && !permissionManager.isAdmin()) return '/401'

  // 4. 项目上下文检查
  const needProject = to.meta?.requireProject !== false
  if (needProject) {
    let project = useProjectStore.getState()
    if (project.projects.length === 0) {
      try {
        const res: any = await getMyProjectsReq()
        useProjectStore.getState().setProjects(res.data?.items || res.data || [])
      } catch {
        return '/agent'
      }
    }

    project = useProjectStore.getState()
    const urlProjectId = to.params?.projectId
    if (urlProjectId && urlProjectId !== (project.currentProject?.id || null)) {
      const target = project.projects.find((p) => p.id === urlProjectId)
      if (target) {
        useProjectStore.getState().setCurrentProject(target)
      } else {
        try {
          const res: any = await getProjectDetailReq(urlProjectId)
          if (res.data) useProjectStore.getState().setCurrentProject(res.data)
          else return '/agent'
        } catch {
          return '/agent'
        }
      }
    }

    project = useProjectStore.getState()
    const lastProject = project.currentProject
    if (lastProject) {
      const validProject = project.projects.find((p) => p.id === lastProject.id)
      if (!validProject) {
        if (Date.now() - project.lastDetailFetchedAt < 5000) {
          const deduped = project.projects.filter((p) => p.id !== lastProject.id)
          useProjectStore.getState().setProjects([lastProject, ...deduped])
        } else {
          try {
            const res: any = await getMyProjectsReq()
            const freshProjects = res.data?.items || res.data || []
            useProjectStore.getState().setProjects(freshProjects)
            if (!freshProjects.find((p: any) => p.id === lastProject.id)) {
              useProjectStore.getState().clearProject()
              return '/agent'
            }
          } catch {
            useProjectStore.getState().clearProject()
            return '/agent'
          }
        }
      }
    } else {
      return '/agent'
    }
  }

  // 5. 项目权限检查
  const requirePerm = to.meta?.requirePermission
  if (requirePerm) {
    const hasPerm = Array.isArray(requirePerm)
      ? permissionManager.hasAnyPermission(requirePerm)
      : permissionManager.hasPermission(requirePerm)
    if (!hasPerm) return '/agent'
  }

  return null
}

export default function RouteGuard() {
  const location = useLocation()
  const navigate = useNavigate()
  const matches = useMatches()
  // 首次校验通过后保持 true:之后导航仍跑校验(失败则 redirect),但**不再卸载** <Outlet/>,
  // 否则每次导航都会把整个 Layout(及侧栏/引导等有状态组件)卸载重挂。
  const [ready, setReady] = useState(false)
  const runIdRef = useRef(0)

  const navKey = location.pathname + location.search

  useEffect(() => {
    const runId = ++runIdRef.current
    progressStart()

    // 取最深层 match 的 meta + params
    const deepest = matches[matches.length - 1] as any
    const meta: RouteMeta = (deepest?.handle?.meta as RouteMeta) || {}
    const params: Record<string, string | undefined> = deepest?.params || {}
    const to: NavTarget = { path: location.pathname, meta, params }

    resolveGuard(to)
      .then((redirectTo) => {
        if (runId !== runIdRef.current) return
        if (redirectTo && redirectTo !== location.pathname) {
          navigate(redirectTo, { replace: true })
        } else {
          setReady(true)
        }
      })
      .finally(() => {
        if (runId === runIdRef.current) progressClose()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey])

  return ready ? <Outlet /> : null
}
