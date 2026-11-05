import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

// Give the shared source its repository-root base without installing another toolchain.
const eslint = new ESLint({
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  overrideConfigFile: fileURLToPath(new URL('../eslint.analytics.config.js', import.meta.url)),
})
const results = await eslint.lintFiles(['packages/analytics/src/**/*.ts', 'packages/i18n/src/**/*.ts'])
const formatter = await eslint.loadFormatter('stylish')
const output = formatter.format(results)
if (output) process.stdout.write(output)
if (results.some(result => result.errorCount || result.warningCount)) process.exitCode = 1
