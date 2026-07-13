// pi-desktop 占位首页。作为通用底座默认入口,后续按需替换为业务页面。
// 窗口背景透明 + 毛玻璃:内容区用半透明卡片承载,保证文字可读;
// 整窗可拖拽(透明窗口需要 -webkit-app-region: drag 才能移动)。
import { Center, Stack, Text, Title } from '@mantine/core'
import classes from './home.module.scss'

export default function HomePage() {
  return (
    <div className={classes.root}>
      <Center h="100vh" w="100vw">
        <Stack align="center" gap="xs" className={classes.card}>
          <Title order={1} size="h1">
            PI Desktop
          </Title>
          <Text c="dimmed" size="lg">
            pi-desktop 桌面框架底座 · Electron + React + 本地后端
          </Text>
        </Stack>
      </Center>
    </div>
  )
}
