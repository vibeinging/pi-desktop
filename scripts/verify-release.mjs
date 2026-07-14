import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expectedTag = `v${packageJson.version}`
const actualTag = process.env.GITHUB_REF_NAME || process.argv[2] || ''
if (actualTag && actualTag !== expectedTag) throw new Error(`tag ${actualTag} 与应用版本 ${expectedTag} 不一致`)

const required = process.platform === 'darwin'
  ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
  : process.platform === 'win32'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD']
    : []
const missing = required.filter((name) => !process.env[name])
if (missing.length) throw new Error(`正式发布缺少签名或公证变量: ${missing.join(', ')}`)
console.log(`[release] ${expectedTag} 的版本与 ${process.platform} 发布环境有效`)
