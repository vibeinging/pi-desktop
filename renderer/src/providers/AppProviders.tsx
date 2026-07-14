import type { ReactNode } from 'react'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/lang'
import { mantineTheme } from '@/theme/mantineTheme'
import BackendStatusBanner from '@/components/BackendStatusBanner'

// Mantine 样式入口(全局,一次性引入)
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

/**
 * 全局 Provider 聚合：
 * - MantineProvider 提供主题和组件上下文
 * - Notifications 提供全局通知
 * - ModalsProvider 提供全局对话框
 * - I18nextProvider 提供多语言上下文
 */
export default function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <MantineProvider theme={mantineTheme} defaultColorScheme="light">
        <Notifications position="top-center" />
        <ModalsProvider>
          <BackendStatusBanner />
          {children}
        </ModalsProvider>
      </MantineProvider>
    </I18nextProvider>
  )
}
