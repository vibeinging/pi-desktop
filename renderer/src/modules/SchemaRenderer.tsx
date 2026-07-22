import { useMemo, useState, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import marked from '@/utils/markdownConfig'
import styles from './modules.module.scss'

export interface ModuleActionBinding {
  action: string
  input?: any
  target?: string
}

interface SchemaRendererProps {
  node: any
  data: Record<string, any>
  state: Record<string, any>
  onAction: (binding: ModuleActionBinding, event?: Record<string, any>) => void
  renderSpecial?: (node: any) => ReactNode
}

function pathValue(root: any, path: string) {
  return path.split('.').filter(Boolean).reduce((value, key) => value?.[key], root)
}

export function resolveModuleValue(value: any, data: Record<string, any>, state: Record<string, any>, event: any = {}) {
  if (typeof value !== 'string') return value
  if (value.startsWith('$data.')) return pathValue(data, value.slice(6))
  if (value.startsWith('$state.')) return pathValue(state, value.slice(7))
  if (value.startsWith('$event.')) return pathValue(event, value.slice(7))
  return value
}

function sourceValue(node: any, data: Record<string, any>, state: Record<string, any>) {
  if (node.source) return resolveModuleValue(String(node.source).startsWith('$') ? node.source : `$data.${node.source}`, data, state)
  return resolveModuleValue(node.value ?? node.data, data, state)
}

function ModuleTabs({ items, render }: { items: any[]; render: (node: any) => ReactNode }) {
  const [active, setActive] = useState(0)
  return (
    <section className={styles.tabs}>
      <div className={styles.tabList} role="tablist">
        {items.map((item, index) => (
          <button key={`${item.label || 'tab'}-${index}`} type="button" role="tab" aria-selected={active === index} data-active={active === index ? 'true' : undefined} onClick={() => setActive(index)}>
            {item.label || `标签 ${index + 1}`}
          </button>
        ))}
      </div>
      <div className={styles.tabPanel}>{render(items[active]?.content)}</div>
    </section>
  )
}

function DataTable({ node, rows }: { node: any; rows: any[] }) {
  const columns = useMemo(() => {
    if (Array.isArray(node.columns) && node.columns.length) {
      return node.columns.map((column: any) => typeof column === 'string' ? { key: column, label: column } : column)
    }
    return Object.keys(rows[0] || {}).slice(0, 12).map((key) => ({ key, label: key }))
  }, [node.columns, rows])
  if (!rows.length) return <div className={styles.empty}>{node.emptyText || '暂无数据'}</div>
  return (
    <div className={styles.tableWrap}>
      <table>
        <thead><tr>{columns.map((column: any) => <th key={column.key}>{column.label || column.key}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, Number(node.limit || 100)).map((row, index) => (
            <tr key={row.id || row.code || index}>
              {columns.map((column: any) => {
                const value = row?.[column.key]
                const changeColumn = column.tone === 'change' || /(change|chg|pct|percent|涨跌|涨幅|跌幅)/i.test(String(column.key || ''))
                const numericChange = changeColumn && typeof value === 'number'
                return <td key={column.key} data-tone={numericChange ? (value > 0 ? 'up' : value < 0 ? 'down' : undefined) : undefined}>{value == null ? '—' : String(value)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Chart({ type, node, value }: { type: 'line' | 'candlestick'; node: any; value: any }) {
  const rows = Array.isArray(value) ? value : []
  if (!rows.length) return <div className={styles.chartEmpty}>{node.emptyText || '暂无图表数据'}</div>
  const categories = rows.map((item: any, index: number) => Array.isArray(item) ? item[0] : item.date || item.time || index)
  const values = rows.map((item: any) => {
    if (type === 'candlestick') return Array.isArray(item) ? item.slice(1, 5) : [item.open, item.close, item.low, item.high]
    return Array.isArray(item) ? item[item.length - 1] : item.value ?? item.close
  })
  const root = typeof document === 'undefined' ? null : document.querySelector('.yiw-root') || document.documentElement
  const tokens = root ? getComputedStyle(root) : null
  const token = (name: string, fallback: string) => tokens?.getPropertyValue(name).trim() || fallback
  const accent = token('--yiw-accent', '#17483e')
  const border = token('--yiw-border', 'rgba(23,72,62,.15)')
  const muted = token('--yiw-muted', '#66716b')
  const option = {
    animation: false,
    grid: { left: 48, right: 20, top: 22, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: categories, axisLine: { lineStyle: { color: border } }, axisLabel: { color: muted } },
    yAxis: { scale: true, splitLine: { lineStyle: { color: border } }, axisLabel: { color: muted } },
    series: [{
      type,
      data: values,
      smooth: type === 'line',
      showSymbol: false,
      lineStyle: { color: accent, width: 2 },
      itemStyle: type === 'candlestick' ? { color: '#e0445e', color0: '#18a56f', borderColor: '#e0445e', borderColor0: '#18a56f' } : { color: accent },
      areaStyle: type === 'line' ? { color: token('--yiw-accent-tint', '#edf3ef') } : undefined
    }]
  }
  return <ReactECharts option={option} notMerge lazyUpdate className={styles.chart} />
}

function MarkdownBlock({ value }: { value: unknown }) {
  const html = useMemo(() => marked.parse(String(value || '')) as string, [value])
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />
}

export default function SchemaRenderer({ node, data, state, onAction, renderSpecial }: SchemaRendererProps) {
  if (node == null || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return <>{String(resolveModuleValue(node, data, state))}</>
  if (Array.isArray(node)) return <>{node.map((child, index) => <SchemaRenderer key={child?.id || index} node={child} data={data} state={state} onAction={onAction} renderSpecial={renderSpecial} />)}</>

  const children = (value = node.children) => <SchemaRenderer node={value} data={data} state={state} onAction={onAction} renderSpecial={renderSpecial} />
  const value = sourceValue(node, data, state)
  switch (node.type) {
    case 'Stack':
      return <div className={styles.stack} style={{ gap: node.gap === 'sm' ? 8 : node.gap === 'lg' ? 24 : 16 }}>{children()}</div>
    case 'Grid':
      return <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(4, Number(node.columns || 2)))}, minmax(0, 1fr))` }}>{children()}</div>
    case 'Toolbar':
      return <div className={styles.toolbar}>{children()}</div>
    case 'Card':
      return <section className={styles.card}>{node.title && <h3>{String(resolveModuleValue(node.title, data, state))}</h3>}{children()}</section>
    case 'Section':
      return <section className={styles.section}>{node.title && <h2>{String(resolveModuleValue(node.title, data, state))}</h2>}{node.description && <p>{String(resolveModuleValue(node.description, data, state))}</p>}{children()}</section>
    case 'Badge':
      return <span className={styles.badge}>{String(resolveModuleValue(node.text ?? value ?? '', data, state))}</span>
    case 'Divider':
      return <hr className={styles.divider} />
    case 'Heading': {
      const Tag = node.level === 1 ? 'h1' : node.level === 3 ? 'h3' : 'h2'
      return <Tag className={styles.heading}>{String(resolveModuleValue(node.text ?? value ?? '', data, state))}</Tag>
    }
    case 'Text':
      return <p className={styles.text}>{String(resolveModuleValue(node.text ?? value ?? '', data, state))}</p>
    case 'Markdown':
      return <MarkdownBlock value={resolveModuleValue(node.text ?? value ?? '', data, state)} />
    case 'Button':
      return <button type="button" className={styles.button} onClick={() => node.onClick?.action && onAction(node.onClick, {})}>{node.label || node.text || '执行'}</button>
    case 'SearchInput':
      return (
        <form className={styles.search} onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          if (node.onSubmit?.action) onAction(node.onSubmit, { value: form.get('value') })
        }}>
          <input name="value" placeholder={node.placeholder || '搜索'} aria-label={node.placeholder || '搜索'} />
          <button type="submit">搜索</button>
        </form>
      )
    case 'Tabs':
      return <ModuleTabs items={Array.isArray(node.items) ? node.items : []} render={(item) => <SchemaRenderer node={item} data={data} state={state} onAction={onAction} />} />
    case 'MetricCard': {
      const metric = value && typeof value === 'object' ? value : { value }
      const change = metric.change ?? node.change
      return <article className={styles.metric}><span>{node.label || metric.label || node.title || '指标'}</span><strong>{metric.value ?? node.value ?? '—'}</strong>{change != null && <small data-tone={Number(change) >= 0 ? 'up' : 'down'}>{Number(change) >= 0 ? '+' : ''}{change}%</small>}</article>
    }
    case 'DataTable':
      return <DataTable node={node} rows={Array.isArray(value) ? value : []} />
    case 'LineChart':
      return <Chart type="line" node={node} value={value} />
    case 'CandlestickChart':
      return <Chart type="candlestick" node={node} value={value} />
    case 'MarketOverview': {
      const items = Array.isArray(value) ? value : []
      return <div className={styles.market}>{items.length ? items.map((item: any, index: number) => <div key={item.code || item.name || index}><span>{item.name || item.code || '行情'}</span><strong>{item.value ?? item.price ?? '—'}</strong><small data-tone={Number(item.change) >= 0 ? 'up' : 'down'}>{item.change == null ? '' : `${Number(item.change) >= 0 ? '+' : ''}${item.change}%`}</small></div>) : <div className={styles.empty}>{node.emptyText || '暂无行情'}</div>}</div>
    }
    case 'EmptyState':
      return <div className={styles.empty}><strong>{node.title || '暂无内容'}</strong>{node.description && <span>{node.description}</span>}</div>
    case 'AgentWorkspace':
      return renderSpecial ? <>{renderSpecial(node)}</> : <div className={styles.componentError}>当前环境无法运行 Agent 工作台</div>
    default:
      return <div className={styles.componentError}>无法显示组件：{String(node.type || '未知')}</div>
  }
}
