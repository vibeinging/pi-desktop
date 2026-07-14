import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const eslint = join(root, 'renderer', 'node_modules', 'eslint', 'bin', 'eslint.js')
execFileSync(process.execPath, [
  eslint,
  'server/src', 'server/scripts', 'server/test',
  'electron/*.js', 'electron/*.cjs', 'electron/test/*.test.cjs',
  'scripts', 'examples',
  '--ext', '.js,.mjs,.cjs',
  '--no-eslintrc',
  '--env', 'node',
  '--env', 'es2021',
  '--parser-options', '{"ecmaVersion":"latest","sourceType":"module"}',
  '--rule', 'no-undef:error',
  '--rule', 'no-unused-vars:off',
  '--rule', 'no-unreachable:error',
  '--rule', 'no-constant-condition:error',
  '--rule', 'no-dupe-keys:error',
  '--rule', 'no-redeclare:error',
  '--rule', 'no-unsafe-finally:error',
  '--ignore-pattern', '**/node_modules/**',
  '--ignore-pattern', 'server/vendor/**',
  '--ignore-pattern', 'renderer/**',
], { cwd: root, stdio: 'inherit' })
