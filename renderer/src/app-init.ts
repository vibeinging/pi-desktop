/**
 * 应用启动初始化：
 * - 初始化主题(html className) + 语言
 */
import settings from '@/settings'
import i18n from '@/lang'
import { useConfigStore } from '@/store/config'
import { toggleHtmlClass } from '@/theme/utils'

export function initApp() {
  const config = useConfigStore.getState()

  // 主题
  toggleHtmlClass(config.theme)

  // 语言
  i18n.changeLanguage(config.language)
  document.title = settings.title
}
