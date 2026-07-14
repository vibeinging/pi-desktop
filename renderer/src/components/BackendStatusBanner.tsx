import { useEffect, useState } from 'react'
import { Alert, Button, Group, Text } from '@mantine/core'

type BackendState = {
  status: 'stopped' | 'starting' | 'ready' | 'unhealthy' | 'restarting' | 'failed' | 'stopping'
  attempt?: number
  retry_in_ms?: number
  error?: string | null
}

export default function BackendStatusBanner() {
  const [state, setState] = useState<BackendState | null>(null)
  const api = (window as any).electronAPI

  useEffect(() => {
    if (!api?.getBackendStatus || !api?.onBackendState) return
    let active = true
    api.getBackendStatus().then((value: BackendState) => {
      if (active) setState(value)
    }).catch(() => {})
    const dispose = api.onBackendState((value: BackendState) => {
      if (active) setState(value)
    })
    return () => {
      active = false
      dispose?.()
    }
  }, [api])

  if (!state || state.status === 'ready') return null

  const failed = state.status === 'failed'
  const message = failed
    ? `本地服务恢复失败${state.error ? `：${state.error}` : ''}`
    : state.status === 'restarting'
      ? `本地服务正在恢复（第 ${state.attempt || 1} 次）…`
      : state.status === 'starting'
        ? '本地服务正在启动…'
        : '本地服务正在关闭…'

  return (
    <Alert
      color={failed ? 'red' : 'yellow'}
      style={{ position: 'fixed', zIndex: 10000, top: 12, left: '50%', transform: 'translateX(-50%)', minWidth: 340, maxWidth: 'calc(100vw - 32px)' }}
    >
      <Group gap="sm" justify="space-between" wrap="nowrap">
        <Text size="sm">{message}</Text>
        {failed && (
          <Button size="xs" color="red" variant="light" onClick={() => api.restartBackend?.().catch(() => {})}>
            重新启动
          </Button>
        )}
      </Group>
    </Alert>
  )
}
