import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { renderSafeMarkdown } from './markdownConfig'
import { sanitizeMermaidSvg, sanitizeMarkdownHtml } from './safeHtml'

const originalWindow = globalThis.window

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
})

afterAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

describe('safe Markdown HTML', () => {
  it('does not execute raw HTML embedded in Markdown', () => {
    const html = renderSafeMarkdown('<img src=x onerror="alert(1)"><script>alert(1)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
  })

  it('removes event handlers and dangerous URL protocols', () => {
    const html = sanitizeMarkdownHtml([
      '<a href="javascript:alert(1)" onclick="alert(1)">bad</a>',
      '<img src="data:image/svg+xml;base64,PHN2Zz4=" onerror="alert(1)">',
    ].join(''))
    expect(html).toBe('<a>bad</a><img>')
  })

  it('removes dangerous URLs emitted from valid Markdown syntax', () => {
    const html = renderSafeMarkdown([
      '[bad](javascript:alert(1))',
      '![bad](data:image/svg+xml;base64,PHN2Zz4=)',
    ].join('\n\n'))
    expect(html).not.toMatch(/javascript:|data:image\/svg\+xml/i)
  })

  it('keeps supported external and local image URLs with safe link attributes', () => {
    const html = sanitizeMarkdownHtml([
      '<a href="https://example.com/docs">docs</a>',
      '<img src="pi-desktop-file://local/abc" alt="local">',
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
    ].join(''))
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('src="pi-desktop-file://local/abc"')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
  })
})

describe('safe Mermaid SVG', () => {
  it('removes active SVG content while preserving diagram shapes', () => {
    const svg = sanitizeMermaidSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><div onclick="alert(1)">bad</div></foreignObject>
        <a href="javascript:alert(1)"><text>link</text></a>
        <path d="M0 0L10 10"></path>
        <text>safe</text>
      </svg>
    `)
    expect(svg).toContain('<svg')
    expect(svg).toContain('<path')
    expect(svg).toContain('<text>safe</text>')
    expect(svg).not.toMatch(/script|foreignObject|onload|javascript:/i)
    expect(svg).not.toContain('<a')
  })
})
