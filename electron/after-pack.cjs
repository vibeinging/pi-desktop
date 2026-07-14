const { cpSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

function findNativeFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) return findNativeFiles(full)
    return entry.isFile() && entry.name.endsWith('.node') ? [full] : []
  })
}

/**
 * electron-builder 会对 extraResources 继续应用 node_modules 默认过滤规则。
 * server 主体仍由 extraResources 放在 app.asar 外；这里在签名之前补齐生产依赖。
 */
module.exports = async function afterPack(context) {
  const source = resolve(context.packager.projectDir, 'staging', 'server', 'node_modules')
  if (!existsSync(source)) throw new Error(`staging server node_modules 不存在: ${source}`)

  const resourcesDir = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const target = join(resourcesDir, 'server', 'node_modules')

  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true, dereference: true })

  const binding = join(target, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(binding)) throw new Error(`打包目录缺少 better-sqlite3: ${binding}`)

  const yiTracePackage = join(target, '@yitrace', 'db', 'package.json')
  if (!existsSync(yiTracePackage)) throw new Error(`打包目录缺少 @yitrace/db: ${yiTracePackage}`)
  const yiTraceBindings = findNativeFiles(join(target, '@yitrace'))
  if (yiTraceBindings.length === 0) throw new Error(`打包目录缺少当前平台的 yiTrace 原生模块: ${join(target, '@yitrace')}`)
}
