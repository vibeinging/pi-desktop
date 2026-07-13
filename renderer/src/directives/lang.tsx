/**
 * 按 i18n key/title 生成文本，并在语言切换时自动刷新。
 * 使用方式：
 * <Lang title="menu.home" />               // 渲染翻译后的文本
 * const text = useLang('menu.home')        // 取翻译后的文本(随语言响应)
 *
 * 说明：react-i18next 的 useTranslation 会在 i18n.changeLanguage 时触发 re-render，
 * langTitle 会遍历 zh 顶层 key 拼 `${key}.${title}` 查找译文，未命中时返回原文。
 */

import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { langTitle } from '@/lang'

// 记录常见组件文本属性，供调用方统一处理 label/placeholder。
const componentToProps = {
  ElInput: 'placeholder',
  ElTableColumn: 'label'
}

/**
 * 语言 hook - 返回按当前语言翻译后的文本。
 */
export function useLang(title?: string): string {
  // 订阅语言变化：语言切换时 useTranslation 触发 re-render，langTitle 重新求值
  useTranslation()
  return langTitle(title)
}

interface LangProps {
  // 待翻译的 i18n key/title；不传则取 children 文本
  title?: string
  children?: ReactNode
}

/**
 * 语言文本组件 - 渲染按当前语言翻译后的文本。
 */
export function Lang({ title, children }: LangProps) {
  // title 优先；否则把 children 当作原始文本/title 传入 langTitle
  const raw = title ?? (typeof children === 'string' ? children : undefined)
  const text = useLang(raw)
  return <>{text}</>
}

// 同时提供默认导出和具名导出，方便不同调用方式复用。
export default Lang

// componentToProps 仅作语义参考，组件直接使用各自的 label/placeholder。
export { componentToProps }
