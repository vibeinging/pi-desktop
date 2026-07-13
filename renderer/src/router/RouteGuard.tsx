import { Outlet } from 'react-router-dom'

/** 桌面版无需登录,直接放行到子路由。 */
export default function RouteGuard() {
  return <Outlet />
}
