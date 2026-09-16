import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const roots = ['report-core', 'report-pdf', 'weekly-report-source', 'weknora-connector', 'report-review']
const files = []
for (const name of roots) {
  const dir = join('packages', name, 'test')
  for (const file of await readdir(dir)) if (/\.test\.(?:m?js)$/u.test(file)) files.push(join(dir, file))
}
const testEnv = { ...process.env }
testEnv.PYTHONIOENCODING ||= 'utf-8'
if (process.platform === 'win32') {
  testEnv.RUN19_PYTHON ||= 'python'
  testEnv.RUN19_FONT ||= `${process.env.WINDIR || 'C:\\Windows'}\\Fonts\\msyh.ttc`
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: testEnv })
process.exitCode = result.status ?? 1
