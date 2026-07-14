import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packagePaths = [
  'package.json',
  'server/package.json',
  'renderer/package.json',
  'electron/package.json',
]
const lockPaths = [
  'server/package-lock.json',
  'renderer/package-lock.json',
  'electron/package-lock.json',
]

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
}

function writeJson(relativePath, value) {
  writeFileSync(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function expectedVersion() {
  return String(readJson('package.json').version || '')
}

function check() {
  const expected = expectedVersion()
  const mismatches = []
  for (const relativePath of packagePaths) {
    const actual = readJson(relativePath).version
    if (actual !== expected) mismatches.push(`${relativePath}: ${actual || '(empty)'}`)
  }
  for (const relativePath of lockPaths) {
    if (!existsSync(join(root, relativePath))) {
      mismatches.push(`${relativePath}: missing`)
      continue
    }
    const lock = readJson(relativePath)
    if (lock.version !== expected) mismatches.push(`${relativePath} version: ${lock.version || '(empty)'}`)
    if (lock.packages?.['']?.version !== expected) {
      mismatches.push(`${relativePath} packages[""] version: ${lock.packages?.['']?.version || '(empty)'}`)
    }
  }
  if (mismatches.length) {
    throw new Error(`应用版本必须统一为 ${expected}:\n- ${mismatches.join('\n- ')}`)
  }
  console.log(`[version] 所有应用包均为 ${expected}`)
}

function setVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`版本格式无效: ${version}`)
  for (const relativePath of packagePaths) {
    const value = readJson(relativePath)
    value.version = version
    writeJson(relativePath, value)
  }
  for (const relativePath of lockPaths) {
    const value = readJson(relativePath)
    value.version = version
    if (value.packages?.['']) value.packages[''].version = version
    writeJson(relativePath, value)
  }
  check()
}

const [command = 'check', value] = process.argv.slice(2)
if (command === 'check') check()
else if (command === 'set') setVersion(value || '')
else if (command === 'print') console.log(expectedVersion())
else throw new Error(`未知命令: ${command}`)
