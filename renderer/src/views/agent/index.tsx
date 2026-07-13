// agent 桌面入口(顶级路由 /agent,layout:false,自带外壳)。
// PI Desktop Agent 入口。
// 主题支持亮色、暗色和跟随系统。
import { useEffect, useMemo, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import AgentShell from './AgentShell'
import { applyAgentZoom, loadAgentSettings } from './AgentSettings'
import { AgentThemeContext, type AgentScheme, type AgentThemeMode } from './themeContext'
import './agent-theme.scss'

const STORAGE_KEY = 'agent-theme'
const systemScheme = (): AgentScheme =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

export default function AgentPage() {
  const [mode, setMode] = useState<AgentThemeMode>(
    () => (localStorage.getItem(STORAGE_KEY) as AgentThemeMode) || 'dark'
  )
  const [sysScheme, setSysScheme] = useState<AgentScheme>(systemScheme)

  // 跟随系统:监听 prefers-color-scheme 变化
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSysScheme(mq.matches ? 'dark' : 'light')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  // 应用上次保存的界面缩放(设置页可调,刷新后续用)
  useEffect(() => {
    applyAgentZoom(loadAgentSettings().zoom)
  }, [])

  const scheme: AgentScheme = mode === 'system' ? sysScheme : mode

  // resize 时露白:给 html 设主题底色(= app 外缘色),让拖拽暴露的区域不再是默认白。
  // 同时把 Mantine 配色方案挂到 <html>:body 上的传送门弹层(Select 下拉等)逃出了
  // 嵌套 MantineProvider 的暗色作用域,只有挂到根才会跟着变暗。
  // 仅 Agent 路由期间生效，卸载即还原。
  useEffect(() => {
    const el = document.documentElement
    const prevBg = el.style.backgroundColor
    const prevScheme = el.getAttribute('data-mantine-color-scheme')
    el.style.backgroundColor = scheme === 'dark' ? '#36313f' : 'var(--el-color-primary-light-9, #f1ecf6)'
    el.setAttribute('data-mantine-color-scheme', scheme)
    return () => {
      el.style.backgroundColor = prevBg
      if (prevScheme) el.setAttribute('data-mantine-color-scheme', prevScheme)
      else el.removeAttribute('data-mantine-color-scheme')
    }
  }, [scheme])
  const ctx = useMemo(() => ({ mode, scheme, setMode }), [mode, scheme])

  return (
    <AgentThemeContext.Provider value={ctx}>
      <MantineProvider forceColorScheme={scheme}>
        <div className="agent-root" data-theme={scheme}>
          {/* 拖拽区 + 外框 padding 在 .agent-root(不缩放);缩放只作用于 .agent-zoom 内的内容 */}
          <div className="agent-dragbar" />
          <div className="agent-dragbar-side" />
          <div className="agent-zoom">
            <AgentShell />
          </div>
        </div>
      </MantineProvider>
    </AgentThemeContext.Provider>
  )
}
