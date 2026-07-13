import { createTheme, type MantineColorsTuple } from '@mantine/core'

// pi-purple 主色调(默认主题)。具体配色仍由 theme/*/ SCSS 的 --el-* 变量驱动，
// 这里给 Mantine 组件一个对齐的主色,避免组件默认蓝与整体紫不一致。
const piPurple: MantineColorsTuple = [
  '#f3f0ff',
  '#e5dbff',
  '#c9b8ff',
  '#ac8fff',
  '#9469fe',
  '#8451fe',
  '#7c45fe',
  '#6a36e3',
  '#5e2ecb',
  '#5025b2'
]

export const mantineTheme = createTheme({
  primaryColor: 'pi',
  colors: {
    pi: piPurple
  },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
  defaultRadius: 'md',
  cursorType: 'pointer'
})
