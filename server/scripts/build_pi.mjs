import { execFileSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const TSGO_ENTRY = join(SERVER_DIR, 'node_modules', '@typescript', 'native-preview', 'bin', 'tsgo.js')
const PI_PACKAGES = ['tui', 'ai', 'agent', 'coding-agent']

function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function resolveCompilerNode() {
  const candidates = [
    process.execPath,
    ...String(process.env.PATH || '').split(delimiter).map((path) => join(path, process.platform === 'win32' ? 'node.exe' : 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node'
  ].filter((path, index, all) => path && existsSync(path) && all.indexOf(path) === index)

  for (const candidate of candidates) {
    const arch = nodeArch(candidate)
    if (!arch) continue
    const platformPackage = join(
      SERVER_DIR,
      'node_modules',
      '@typescript',
      `native-preview-${process.platform}-${arch}`
    )
    if (existsSync(platformPackage)) return candidate
  }
  throw new Error('没有找到与 @typescript/native-preview 原生包架构匹配的 Node')
}

if (!existsSync(TSGO_ENTRY)) throw new Error(`缺少 tsgo: ${TSGO_ENTRY}`)
const compilerNode = resolveCompilerNode()
console.log(`[pi-build] 使用 ${compilerNode} (${nodeArch(compilerNode)})`)

for (const name of PI_PACKAGES) {
  const packageDir = join(SERVER_DIR, 'vendor', 'pi', name)
  console.log(`[pi-build] 编译 ${name}`)
  rmSync(join(packageDir, 'dist'), { recursive: true, force: true })
  execFileSync(compilerNode, [TSGO_ENTRY, '-p', 'tsconfig.build.json'], {
    cwd: packageDir,
    env: process.env,
    stdio: 'inherit'
  })
}

function copyMatching(sourceDir, targetDir, predicate) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isFile() && predicate(entry.name)) {
      copyFileSync(join(sourceDir, entry.name), join(targetDir, entry.name))
    }
  }
}

const codingAgentDir = join(SERVER_DIR, 'vendor', 'pi', 'coding-agent')
copyMatching(
  join(codingAgentDir, 'src', 'modes', 'interactive', 'theme'),
  join(codingAgentDir, 'dist', 'modes', 'interactive', 'theme'),
  (name) => name.endsWith('.json')
)
copyMatching(
  join(codingAgentDir, 'src', 'modes', 'interactive', 'assets'),
  join(codingAgentDir, 'dist', 'modes', 'interactive', 'assets'),
  (name) => name.endsWith('.png')
)

const exportHtmlSource = join(codingAgentDir, 'src', 'core', 'export-html')
const exportHtmlTarget = join(codingAgentDir, 'dist', 'core', 'export-html')
mkdirSync(exportHtmlTarget, { recursive: true })
for (const name of ['template.html', 'template.css', 'template.js']) {
  copyFileSync(join(exportHtmlSource, name), join(exportHtmlTarget, name))
}
cpSync(join(exportHtmlSource, 'vendor'), join(exportHtmlTarget, 'vendor'), { recursive: true })

if (process.platform !== 'win32') {
  for (const name of ['cli.js', 'rpc-entry.js']) {
    chmodSync(join(codingAgentDir, 'dist', name), 0o755)
  }
}
