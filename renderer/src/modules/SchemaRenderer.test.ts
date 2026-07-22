import { describe, expect, it } from 'vitest'
import { resolveModuleValue } from './SchemaRenderer'

describe('dynamic module bindings', () => {
  it('only resolves data, state and event paths', () => {
    const data = { quote: { price: 12.34 } }
    const state = { selected: '000001' }
    expect(resolveModuleValue('$data.quote.price', data, state)).toBe(12.34)
    expect(resolveModuleValue('$state.selected', data, state)).toBe('000001')
    expect(resolveModuleValue('$event.value', data, state, { value: '平安银行' })).toBe('平安银行')
    expect(resolveModuleValue('javascript:alert(1)', data, state)).toBe('javascript:alert(1)')
  })
})
