import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import AppProviders from '@/providers/AppProviders'
import { router } from '@/router'
import { initApp } from '@/app-init'

// ── 全局样式与启动副作用 ──
import 'virtual:svg-icons-register'
import '@/theme/index.scss'
import '@/styles/index.scss'
import 'katex/dist/katex.min.css'
import 'nprogress/nprogress.css'

initApp()

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <AppProviders>
    <RouterProvider router={router} />
  </AppProviders>
)
