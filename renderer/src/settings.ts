/**
 * Renderer 全局设置。
 */
import { appConfig } from '@/generated/app-config'
export interface AppSettings {
  title: string
  sidebarLogo: boolean
  showNavbarTitle: boolean
  ShowDropDown: boolean
  showHamburger: boolean
  showLeftMenu: boolean
  showTagsView: boolean
  tagsViewNum: number
  showTopNavbar: boolean
  mainNeedAnimation: boolean
  delWindowHeight: string
  viteBasePath: string
  defaultLanguage: 'zh' | 'en'
  defaultTheme: string
  defaultSize: 'large' | 'default' | 'small'
  plateFormId: number
  enableDocs: boolean
}

export const settings: AppSettings = {
  title: appConfig.productName,
  sidebarLogo: true,
  showNavbarTitle: false,
  ShowDropDown: true,
  showHamburger: true,
  showLeftMenu: true,
  showTagsView: true,
  tagsViewNum: 6,
  showTopNavbar: true,
  mainNeedAnimation: false,
  delWindowHeight: '210px',
  viteBasePath: '/',
  defaultLanguage: appConfig.defaultLocale,
  defaultTheme: appConfig.defaultTheme,
  defaultSize: 'default',
  plateFormId: 2,
  enableDocs: true
}

export default settings
