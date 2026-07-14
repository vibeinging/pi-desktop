import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'release')
mkdirSync(output, { recursive: true })
const npmCli = process.env.npm_execpath || (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const command = process.env.npm_execpath ? process.execPath : npmCli
const prefix = process.env.npm_execpath ? [npmCli] : []

for (const project of ['server', 'renderer', 'electron']) {
  const content = execFileSync(command, [...prefix, '--prefix', project, 'sbom', '--omit=dev', '--sbom-format=cyclonedx'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32' && !process.env.npm_execpath,
  })
  writeFileSync(join(output, `sbom-${project}.cdx.json`), content, 'utf8')
}
console.log('[release] 已生成 Server、Renderer 和 Electron SBOM')
