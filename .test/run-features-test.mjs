/**
 * Runs the features end-to-end test (drag-drop, lock, masking, alignment,
 * persisted logs), clearing ELECTRON_RUN_AS_NODE so the app really launches.
 *
 * Usage: node .test/run-features-test.mjs
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

// The test media is generated on demand so the suite works from a clean checkout.
const media = ['clip_a.mp4', 'clip_a.srt']
const missing = media.filter((f) => !fs.existsSync(path.join(here, f)))
if (missing.length > 0) {
  console.log(`Generating test media (${missing.join(', ')})...`)
  const gen = spawn(process.execPath, [path.join(here, 'make-fixtures.mjs')], { cwd: root, stdio: 'inherit' })
  await new Promise((resolve, reject) => {
    gen.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fixture generation failed (${code})`))))
    gen.on('error', reject)
  })
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const disarmWatchdog = installWatchdog(360000, 'test:features')
const child = spawn(process.execPath, [path.join(here, 'features-e2e.mjs')], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => {
  disarmWatchdog()
  process.exit(code ?? 1)
})
