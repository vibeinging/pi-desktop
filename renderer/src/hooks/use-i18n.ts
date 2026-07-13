import { useTranslation } from 'react-i18next'
import i18n from '@/lang'

/**
 * 基于 react-i18next 的 i18n hook。
 * 组件内：const { t } = useI18n()
 */
export const useI18n = () => useTranslation()

/** 便捷翻译方法(非组件可用) */
export const t = (key: string) => i18n.t(key)
