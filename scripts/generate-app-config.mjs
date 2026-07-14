import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = JSON.parse(readFileSync(join(root, 'app.config.json'), 'utf8'))
const requiredStrings = ['productName', 'shortName', 'description', 'appId', 'urlProtocol', 'localFileScheme', 'dataDirName', 'userDataDirName', 'defaultLocale', 'defaultTheme', 'defaultSystemPrompt']
for (const key of requiredStrings) {
  if (!String(config[key] || '').trim()) throw new Error(`app.config.json 缺少 ${key}`)
}
if (!Array.isArray(config.defaultTools) || !config.defaultTools.length) throw new Error('app.config.json 缺少 defaultTools')

const json = JSON.stringify(config, null, 2)
const indexHtml = readFileSync(join(root, 'renderer/index.template.html'), 'utf8')
  .replaceAll('{{locale}}', config.defaultLocale === 'zh' ? 'zh-CN' : config.defaultLocale)
  .replaceAll('{{localFileScheme}}', config.localFileScheme)
  .replaceAll('{{productName}}', config.productName)
const targets = [
  ['electron/generated-app-config.cjs', `// 由 scripts/generate-app-config.mjs 生成，请勿手改。\nmodule.exports = Object.freeze(${json});\n`],
  ['server/src/generated/app-config.js', `// 由 scripts/generate-app-config.mjs 生成，请勿手改。\nexport const APP_CONFIG = Object.freeze(${json});\n`],
  ['renderer/src/generated/app-config.ts', `// 由 scripts/generate-app-config.mjs 生成，请勿手改。\nexport const appConfig = ${json} as const\n`],
  ['renderer/index.html', indexHtml],
]
const checkOnly = process.argv.includes('--check')
const mismatches = []
const normalizeEol = (value) => String(value || '').replace(/\r\n/g, '\n')
for (const [relativePath, content] of targets) {
  const path = join(root, relativePath)
  let current = ''
  try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
  if (normalizeEol(current) === normalizeEol(content)) continue
  if (checkOnly) mismatches.push(relativePath)
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
    console.log(`[app-config] 已生成 ${relativePath}`)
  }
}
if (mismatches.length) throw new Error(`应用配置生成文件过期，请运行 npm run config:generate:\n- ${mismatches.join('\n- ')}`)
if (checkOnly) console.log('[app-config] 三端生成配置一致')
