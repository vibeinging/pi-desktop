import createDOMPurify, { type Config, type DOMPurify } from 'dompurify'

const MARKDOWN_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
] as const

const MARKDOWN_ATTRS = [
  'alt', 'aria-hidden', 'class', 'colspan', 'height', 'href', 'id', 'loading', 'rel',
  'role', 'rowspan', 'src', 'target', 'title', 'width',
] as const

const MARKDOWN_CONFIG: Config = {
  ALLOWED_TAGS: [...MARKDOWN_TAGS],
  ALLOWED_ATTR: [...MARKDOWN_ATTRS],
  ALLOW_ARIA_ATTR: true,
  ALLOW_DATA_ATTR: false,
  // pi-desktop-file 由下面的 URL hook 精确放行；其它未知协议仍会被 hook 拒绝。
  ALLOW_UNKNOWN_PROTOCOLS: true,
  FORBID_TAGS: ['base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'meta', 'object', 'script', 'select', 'style', 'svg', 'template', 'textarea'],
  FORBID_ATTR: ['formaction', 'srcdoc'],
}

const SVG_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ALLOW_ARIA_ATTR: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_TAGS: ['a', 'foreignObject', 'iframe', 'script'],
  FORBID_ATTR: ['formaction', 'srcdoc'],
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|bmp);base64,[a-z0-9+/=\s]+$/i
const EXTERNAL_URL = /^(?:https?:|mailto:)/i
let purifier: DOMPurify | null = null

function hasUnsafeCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function isRelativeResource(value: string) {
  return !value.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(value)
}

export function isSafeHtmlUrl(value: string, tagName: string, attrName: string) {
  const url = String(value || '').trim()
  const tag = tagName.toLowerCase()
  const attr = attrName.toLowerCase()
  if (!url || hasUnsafeCharacters(url)) return false
  if (url.startsWith('#')) return true

  if (attr === 'href' || attr === 'xlink:href') {
    if (tag === 'use') return false
    return tag === 'a' && EXTERNAL_URL.test(url)
  }

  if (attr === 'src') {
    if (tag !== 'img') return false
    if (/^https?:\/\//i.test(url) || /^pi-desktop-file:\/\//i.test(url)) return true
    if (SAFE_DATA_IMAGE.test(url)) return true
    return isRelativeResource(url)
  }

  return true
}

function getPurifier() {
  if (purifier) return purifier
  if (typeof window === 'undefined' || !window.document) {
    throw new Error('HTML sanitizer requires a browser DOM')
  }

  purifier = createDOMPurify(window as any)
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const attr = data.attrName.toLowerCase()
    if (attr === 'href' || attr === 'xlink:href' || attr === 'src') {
      data.keepAttr = isSafeHtmlUrl(data.attrValue, node.tagName, attr)
    }
  })
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName.toLowerCase() !== 'a') return
    const href = node.getAttribute('href') || ''
    if (EXTERNAL_URL.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    } else {
      node.removeAttribute('target')
      node.removeAttribute('rel')
    }
  })
  return purifier
}

export function sanitizeMarkdownHtml(html: string) {
  return getPurifier().sanitize(String(html || ''), MARKDOWN_CONFIG) as string
}

export function sanitizeMermaidSvg(svg: string) {
  return getPurifier().sanitize(String(svg || ''), SVG_CONFIG) as string
}
