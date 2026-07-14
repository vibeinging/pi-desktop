const appConfig = require('./generated-app-config.cjs')

module.exports = {
  appId: appConfig.appId,
  productName: appConfig.productName,
  electronVersion: '42.4.1',
  asar: true,
  npmRebuild: false,
  afterPack: 'electron/after-pack.cjs',
  directories: {
    output: 'release',
    buildResources: 'electron/icons',
  },
  files: [
    'package.json',
    'electron/main.js',
    'electron/preload.js',
    'electron/*.cjs',
    'electron/icons/**/*',
    'renderer/dist/**/*',
  ],
  extraResources: [
    { from: 'LICENSE', to: 'LICENSE' },
    { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    { from: 'third_party/licenses', to: 'third_party/licenses' },
    { from: 'staging/server', to: 'server', filter: ['**/*'] },
  ],
  protocols: [{ name: `${appConfig.productName} URL`, schemes: [appConfig.urlProtocol] }],
  mac: {
    category: 'public.app-category.developer-tools',
    icon: appConfig.icons.mac,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true,
    entitlements: 'electron/entitlements.mac.plist',
    entitlementsInherit: 'electron/entitlements.mac.plist',
    signIgnore: ['Contents/Resources/server/(?!.*\\.(?:node|dylib)$)'],
    target: ['dmg', 'zip'],
  },
  win: {
    icon: appConfig.icons.windows,
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  linux: {
    category: 'Development',
    icon: appConfig.icons.linux,
    executableName: appConfig.shortName,
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
  },
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
}
