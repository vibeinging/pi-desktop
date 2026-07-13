import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const MINIMUM_NODE = [22, 19, 0]
const MINIMUM_NPM = [11, 0, 0]
const PROJECTS = [
  { name: '本地后端', directory: 'server' },
  { name: '渲染层', directory: 'renderer' },
  { name: 'Electron', directory: 'electron' },
]

function versionParts(value) {
  return String(value).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] || 0) > minimum[index]) return true
    if ((actual[index] || 0) < minimum[index]) return false
  }
  return true
}

if (!versionAtLeast(versionParts(process.versions.node), MINIMUM_NODE)) {
  throw new Error(`需要 Node.js >= ${MINIMUM_NODE.join('.')}，当前为 ${process.versions.node}`)
}

const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : ''
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const npmArgs = (args) => npmCli ? [npmCli, ...args] : args

const npmVersion = execFileSync(npmCommand, npmArgs(['--version']), {
  cwd: ROOT_DIR,
  encoding: 'utf8',
  shell: process.platform === 'win32' && !npmCli,
}).trim()

if (!versionAtLeast(versionParts(npmVersion), MINIMUM_NPM)) {
  throw new Error(`需要 npm >= ${MINIMUM_NPM.join('.')}，当前为 ${npmVersion}`)
}

function runNpm(args) {
  execFileSync(npmCommand, npmArgs(args), {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      // 不依赖用户全局 npm cache 的权限和所有者状态。
      npm_config_cache: process.env.PI_SETUP_NPM_CACHE
        || join(ROOT_DIR, '.cache', 'npm'),
    },
    stdio: 'inherit',
    shell: process.platform === 'win32' && !npmCli,
  })
}

for (const project of PROJECTS) {
  const directory = join(ROOT_DIR, project.directory)
  const lockfile = join(directory, 'package-lock.json')
  if (!existsSync(lockfile)) throw new Error(`${project.directory}/package-lock.json 不存在，无法进行可复现安装`)
  console.log(`\n[setup] 安装${project.name}依赖`)
  runNpm(['--prefix', directory, 'ci', '--no-audit', '--no-fund'])
}

console.log('\n[setup] 检查并构建 vendored pi')
runNpm(['--prefix', join(ROOT_DIR, 'server'), 'run', 'ensure:pi'])

console.log('\n[setup] 完成。运行 npm run dev 启动桌面应用。')
