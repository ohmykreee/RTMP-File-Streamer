/**
 * Runs the preset/UI feature tests: the preset store through the real app, plus
 * the Data-folder placement rules.
 *
 * Usage: node .test/run-preset-test.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installWatchdog } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing. Run `pnpm run build` first.')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

async function run(script) {
  console.log(`\n--- ${script} ---`)
  const child = spawn(process.execPath, [path.join(here, script)], { cwd: root, env, stdio: 'inherit' })
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
}

const disarmWatchdog = installWatchdog(600000, 'test:presets')

const results = []
results.push(await run('preset-e2e.mjs'))
results.push(await run('data-dir-e2e.mjs'))
results.push(await run('layout-e2e.mjs'))
disarmWatchdog()
process.exit(results.every((c) => c === 0) ? 0 : 1)
