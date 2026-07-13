import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER_DIR = join(ROOT_DIR, 'server')
const ELECTRON_DIR = join(ROOT_DIR, 'electron')
const STAGING_DIR = join(ROOT_DIR, 'staging')
const STAGING_SERVER_DIR = join(STAGING_DIR, 'server')
const PI_PACKAGES = ['tui', 'ai', 'agent', 'coding-agent']
const npmCli = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : ''
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const npmArgs = (args) => npmCli ? [npmCli, ...args] : args
const electronBuilder = join(
  ELECTRON_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
)
const electronRebuild = join(
  ELECTRON_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
)

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || ROOT_DIR,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  })
}

function runNpm(args, options = {}) {
  run(npmCommand, npmArgs(args), options)
}

function requirePath(path, hint) {
  if (!existsSync(path)) throw new Error(`${hint}: ${path}`)
}

function copyPiRuntimePackage(name) {
  const source = join(SERVER_DIR, 'vendor', 'pi', name)
  const target = join(STAGING_SERVER_DIR, 'vendor', 'pi', name)
  requirePath(join(source, 'package.json'), `缺少 pi ${name} package.json`)
  requirePath(join(source, 'dist', 'index.js'), `缺少 pi ${name} 构建产物，请先运行 npm run build`)
  mkdirSync(target, { recursive: true })
  copyFileSync(join(source, 'package.json'), join(target, 'package.json'))
  cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true })
}

function materializePiRuntimePackage(name) {
  const source = join(STAGING_SERVER_DIR, 'vendor', 'pi', name)
  const packageJson = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const target = join(STAGING_SERVER_DIR, 'node_modules', ...packageJson.name.split('/'))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

function prepareServerRuntime() {
  console.log('\n[package] 准备隔离的 server 运行目录')
  rmSync(STAGING_DIR, { recursive: true, force: true })
  mkdirSync(STAGING_SERVER_DIR, { recursive: true })

  cpSync(join(SERVER_DIR, 'src'), join(STAGING_SERVER_DIR, 'src'), { recursive: true })
  cpSync(join(SERVER_DIR, 'db'), join(STAGING_SERVER_DIR, 'db'), { recursive: true })
  copyFileSync(join(SERVER_DIR, 'package.json'), join(STAGING_SERVER_DIR, 'package.json'))
  copyFileSync(join(SERVER_DIR, 'package-lock.json'), join(STAGING_SERVER_DIR, 'package-lock.json'))

  for (const name of PI_PACKAGES) copyPiRuntimePackage(name)

  const licenseDir = join(STAGING_SERVER_DIR, 'vendor', 'licenses')
  mkdirSync(licenseDir, { recursive: true })
  copyFileSync(
    join(SERVER_DIR, 'vendor', 'licenses', 'pi-MIT.txt'),
    join(licenseDir, 'pi-MIT.txt')
  )
  copyFileSync(join(ROOT_DIR, 'THIRD_PARTY_NOTICES.md'), join(STAGING_SERVER_DIR, 'THIRD_PARTY_NOTICES.md'))

  // 严格按 server lockfile 安装，避免每次打包重新解析依赖版本。
  // npm workspace 会生成指向 vendor 的软链接，安装后再物化为最小运行包。
  runNpm(['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: STAGING_SERVER_DIR,
    env: {
      ...process.env,
      npm_config_cache: process.env.PI_PACKAGE_NPM_CACHE || join(STAGING_DIR, '.npm-cache'),
    },
  })

  for (const name of PI_PACKAGES) {
    rmSync(join(STAGING_SERVER_DIR, 'vendor', 'pi', name, 'node_modules'), {
      recursive: true,
      force: true,
    })
    materializePiRuntimePackage(name)
  }

  // 产物只保留启动所需的 package 元数据；lockfile 仅用于上面的可复现安装。
  const sourcePackage = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'))
  const runtimePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: sourcePackage.type,
    description: sourcePackage.description,
    author: sourcePackage.author,
    license: sourcePackage.license,
    engines: sourcePackage.engines,
    dependencies: {
      ...sourcePackage.dependencies,
    },
  }
  writeFileSync(
    join(STAGING_SERVER_DIR, 'package.json'),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
    'utf8'
  )
  rmSync(join(STAGING_SERVER_DIR, 'package-lock.json'), { force: true })
}

function rebuildNativeModules() {
  requirePath(electronRebuild, '缺少 @electron/rebuild，请先运行 npm run setup')
  const electronPackage = JSON.parse(readFileSync(join(ELECTRON_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'))
  console.log(`\n[package] 在 staging 中为 Electron ${electronPackage.version} / ${process.arch} 重编 better-sqlite3`)
  run(electronRebuild, [
    '--version', electronPackage.version,
    '--arch', process.arch,
    '--module-dir', STAGING_SERVER_DIR,
    '--force',
    '--only', 'better-sqlite3',
  ])
}

function buildAppDirectory() {
  requirePath(electronBuilder, '缺少 electron-builder，请先运行 npm run setup')
  const args = ['--config', join(ELECTRON_DIR, 'electron-builder.yml')]
  if (process.argv.includes('--dir')) args.push('--dir')
  if (process.platform === 'darwin') {
    args.push('--mac')
    args.push(process.arch === 'arm64' ? '--arm64' : '--x64')
  }
  console.log('\n[package] 生成 Electron 应用目录')
  run(electronBuilder, args)
}

console.log('[package] 构建 pi 与 renderer')
runNpm(['run', 'build'])
prepareServerRuntime()
rebuildNativeModules()
buildAppDirectory()

// 防止脚本后续被改成复制源 node_modules：这里明确检查 staging 的原生文件存在。
const stagedBinding = join(STAGING_SERVER_DIR, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
requirePath(stagedBinding, 'staging 中缺少 better-sqlite3 原生模块')
if (!lstatSync(stagedBinding).isFile()) throw new Error(`better-sqlite3 不是普通文件: ${stagedBinding}`)

console.log('\n[package] 完成，产物位于 release/。源 server/node_modules 未被修改。')
