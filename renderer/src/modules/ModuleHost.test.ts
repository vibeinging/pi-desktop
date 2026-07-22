import { describe, expect, it } from 'vitest'
import {
  initialModuleData,
  initialModuleDataByPage,
  moduleStateFromItems,
  setModuleDataPath,
  setModuleStateEntry
} from './moduleRuntime'

describe('dynamic module host state', () => {
  it('initializes the entry page data before onLoad actions run', () => {
    const content: any = {
      manifest: { entryPage: 'home' },
      pages: { home: { data: { symbol: '600519' }, mockData: { symbol: '000001' } } },
      actions: {}
    }
    expect(initialModuleData(content, true)).toEqual({ symbol: '000001' })
    expect(initialModuleData(content)).toEqual({ symbol: '600519' })
  })

  it('keeps initial data isolated for every product page', () => {
    const content: any = {
      manifest: { entryPage: 'dashboard' },
      pages: {
        dashboard: { data: { symbol: '600519' } },
        research: { data: { report: '贵州茅台研究' } }
      },
      actions: {}
    }
    expect(initialModuleDataByPage(content)).toEqual({
      dashboard: { symbol: '600519' },
      research: { report: '贵州茅台研究' }
    })
  })

  it('writes action results to nested data targets without mutating old data', () => {
    const current = { quote: { symbol: '600519', rows: [] } }
    const next = setModuleDataPath(current, '$data.quote.rows', [{ price: 123 }])
    expect(next.quote.rows).toEqual([{ price: 123 }])
    expect(next.quote.symbol).toBe('600519')
    expect(current.quote.rows).toEqual([])
  })

  it('builds namespaced product state and applies state change events', () => {
    const initial = moduleStateFromItems([
      { namespace: 'default', key: 'selected', value: 'AAPL' },
      { namespace: 'thesis', key: 'items', value: [{ ticker: 'AAPL' }] }
    ])
    expect(initial).toEqual({ selected: 'AAPL', thesis: { items: [{ ticker: 'AAPL' }] } })
    const next = setModuleStateEntry(initial, { namespace: 'thesis', key: 'items', value: [{ ticker: 'MSFT' }] })
    expect(next.thesis.items).toEqual([{ ticker: 'MSFT' }])
    expect(initial.thesis.items).toEqual([{ ticker: 'AAPL' }])
  })
})
