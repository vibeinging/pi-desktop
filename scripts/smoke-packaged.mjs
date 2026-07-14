import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

const releaseDir = fileURLToPath(new URL('../release/', import.meta.url))
const files = walk(releaseDir)
let executable
if (process.platform === 'darwin') {
  executable = files.find((file) => file.includes('.app/Contents/MacOS/') && basename(file) === 'PI Desktop')
} else if (process.platform === 'win32') {
  executable = files.find((file) => /win-unpacked[/\\]PI Desktop\.exe$/i.test(file))
} else {
  executable = files.find((file) => /linux-unpacked[/\\]pi-desktop$/i.test(file))
}
if (!executable) throw new Error(`未找到 ${process.platform} unpacked 可执行文件`)

const home = mkdtempSync(join(tmpdir(), 'pi-desktop-smoke-'))
// GitHub 的 Linux Runner 不能把 chrome-sandbox 设置为 root/4755。
// 只给 CI smoke 关闭 Chromium sandbox，正式安装包启动参数不变。
const executableArgs = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const child = spawn(executable, executableArgs, {
  env: {
    ...process.env,
    PI_SMOKE_TEST: '1',
    PI_DB_PATH: join(home, 'local.db'),
    HOME: home,
    USERPROFILE: home,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { output += chunk.toString('utf8') })
const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
const code = await new Promise((resolve) => child.once('exit', resolve))
clearTimeout(timer)
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
if (code !== 0 || !output.includes('[smoke] packaged flow passed')) {
  throw new Error(`安装目录启动探针失败(code=${code})\n${output}`)
}
console.log(`[smoke] ${process.platform}/${process.arch} Renderer、pi Agent、后端 IPC、SQLite、yiTrace、配置、附件、重启恢复和删除成功`)
