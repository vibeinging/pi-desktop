import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PI_DIR = join(SERVER_DIR, 'vendor', 'pi')
const PI_BASE_CONFIG = join(SERVER_DIR, 'vendor', 'tsconfig.base.json')
const PI_PACKAGES = ['tui', 'ai', 'agent', 'coding-agent']

function latestMtime(path) {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  let latest = stat.mtimeMs
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.git') continue
    latest = Math.max(latest, latestMtime(join(path, entry.name)))
  }
  return latest
}

function stalePackage(name) {
  const packageDir = join(PI_DIR, name)
  const distEntry = join(packageDir, 'dist', 'index.js')
  if (!existsSync(distEntry)) return name
  const sourceMtime = Math.max(
    latestMtime(join(packageDir, 'src')),
    latestMtime(join(packageDir, 'package.json')),
    latestMtime(join(packageDir, 'tsconfig.build.json')),
    latestMtime(PI_BASE_CONFIG)
  )
  return sourceMtime > statSync(distEntry).mtimeMs ? name : ''
}

if (process.env.PI_SKIP_PI_BUILD === '1') {
  console.warn('[pi-build] 已按 PI_SKIP_PI_BUILD=1 跳过检查')
  process.exit(0)
}

const stale = PI_PACKAGES.map(stalePackage).filter(Boolean)
if (!stale.length) {
  console.log('[pi-build] 运行产物已是最新')
  process.exit(0)
}

console.log(`[pi-build] 需要更新: ${stale.join(', ')}`)
const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : ''
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const npmArgs = npmCli ? [npmCli, 'run', 'build:pi'] : ['run', 'build:pi']
execFileSync(npmCommand, npmArgs, {
  cwd: SERVER_DIR,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32' && !npmCli
})
