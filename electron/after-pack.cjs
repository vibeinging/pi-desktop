const { cpSync, existsSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

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
}
