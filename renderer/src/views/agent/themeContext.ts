// agent 主题上下文:亮 / 暗 / 跟随系统。
// 入口(index.tsx)持有状态并应用到 .agent-root[data-theme] 与 MantineProvider;
// 左栏底部的三态开关通过 useAgentTheme() 读取与切换。
import { createContext, useContext } from 'react'

export type AgentThemeMode = 'light' | 'dark' | 'system'
export type AgentScheme = 'light' | 'dark'

export interface AgentThemeCtx {
  mode: AgentThemeMode
  scheme: AgentScheme // 实际生效(system 已解析)
  setMode: (m: AgentThemeMode) => void
}

export const AgentThemeContext = createContext<AgentThemeCtx>({
  mode: 'system',
  scheme: 'light',
  setMode: () => {}
})

export const useAgentTheme = () => useContext(AgentThemeContext)
