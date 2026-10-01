/**
 * Runs the StreamEngine integration test inside a real Electron process.
 *
 * The harness environment sets ELECTRON_RUN_AS_NODE=1, which would turn the
 * Electron binary into plain Node (and remove the `app` module), so it is
 * cleared for this child process.
 *
 * Usage: node .test/run-engine-test.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

if (!fs.existsSync(electron)) {
  console.error(`Electron binary not found at ${electron}. Run \`pnpm install\` first.`)
  process.exit(1)
}

if (!fs.existsSync(path.join(root, 'out', 'main', 'test-entry.cjs'))) {
  console.error('Test bundles missing. Run `pnpm run test:bundles` first.')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.test'], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
