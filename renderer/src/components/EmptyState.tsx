import type { ReactNode } from 'react'
import { Center, Stack, Text, Title } from '@mantine/core'

export default function EmptyState({ icon, title, description, actions }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; [key: string]: unknown }) {
  return <Center mih={240}><Stack align="center" gap="sm">{icon}<Title order={3}>{title}</Title>{description && <Text c="dimmed" ta="center">{description}</Text>}{actions}</Stack></Center>
}
