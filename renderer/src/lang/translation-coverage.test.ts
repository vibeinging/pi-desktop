import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from './en'
import zh from './zh'

type Dictionary = Record<string, unknown>

const DYNAMIC_KEYS = [
  'common.http.authFailed',
  'common.http.badRequest',
  'common.http.clientError',
  'common.http.forbidden',
  'common.http.internalError',
  'common.http.notFound',
  'common.http.serverError',
  'mcpProvider.wizard.step1.railLabel',
  'mcpProvider.wizard.step2.railLabel',
  'mcpProvider.wizard.step3.railLabel',
  'models.empty.chatDescReadonly',
  'models.empty.chatTitle',
  'models.empty.embeddingDescReadonly',
  'models.empty.embeddingTitle',
  'models.empty.operatorChatDescReadonly',
  'models.empty.operatorChatTitle',
  'models.role.embeddingDesc',
  'models.role.primaryDesc',
  'models.role.secondaryDesc',
  'skills.disabled',
  'skills.enabled'
]

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'lang') files.push(...sourceFiles(file))
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      files.push(file)
    }
  }
  return files
}

function staticTranslationKeys(): string[] {
  const keys = new Set<string>()
  const call = /(?:\bi18n\.)?\bt\(\s*(['"])([^'"\n]+)\1/g
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(call)) keys.add(match[2])
  }
  return [...keys].sort()
}

function flatten(dictionary: Dictionary, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(dictionary)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (typeof value === 'string') result[key] = value
    else if (value && typeof value === 'object') Object.assign(result, flatten(value as Dictionary, key))
  }
  return result
}

describe('translation coverage', () => {
  const requiredKeys = [...new Set([...staticTranslationKeys(), ...DYNAMIC_KEYS])].sort()
  const dictionaries = { zh: flatten(zh), en: flatten(en) }

  it('keeps the Chinese and English key sets in sync', () => {
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.zh).sort())
  })

  it.each(Object.entries(dictionaries))('%s covers every reachable translation key', (_language, dictionary) => {
    const missing = requiredKeys.filter((key) => !dictionary[key]?.trim() || dictionary[key] === key)
    expect(missing).toEqual([])
  })
})
