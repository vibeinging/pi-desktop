import { type RouteObject, redirect } from 'react-router-dom'
import RouteGuard from './RouteGuard'

export interface RouteMeta {
  title?: string
  public?: boolean
  [key: string]: unknown
}

export const constantRoutes = [
  { path: '/', name: 'Home', meta: { title: 'PI Desktop' } },
  { path: '/agent', name: 'Agent', meta: { title: 'PI Desktop' } },
  { path: '/401', name: 'Unauthorized', meta: { public: true } },
  { path: '/404', name: 'NotFound', meta: { public: true } }
]

export const routeObjects: RouteObject[] = [
  {
    element: <RouteGuard />,
    children: [
      { index: true, loader: () => redirect('/agent') },
      { path: 'agent', lazy: async () => ({ Component: (await import('@/views/agent')).default }) },
      { path: '401', lazy: async () => ({ Component: (await import('@/views/error-page/401')).default }) },
      { path: '404', lazy: async () => ({ Component: (await import('@/views/error-page/404')).default }) },
      { path: '*', loader: () => redirect('/agent') }
    ]
  }
]
