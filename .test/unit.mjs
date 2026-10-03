/**
 * The whole non-Electron test run, in one command: `pnpm test:unit`.
 *
 * Three stages, in this order because each feeds the next:
 *   1. fixtures  — generate the sample clips if they are missing
 *   2. bundles   — esbuild the TypeScript modules the plain-node checks import
 *   3. harness   — the checks themselves (ffmpeg command vectors, real
 *                  transcodes, a local RTMP listener, and the obs-websocket
 *                  protocol against a real TCP client)
 *
 * Everything log-worthy goes to stdout unchanged; this file only sequences the
 * stages and fails fast with the stage name.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** Runs a child with inherited stdio; rejects with the child's exit code. */
function step(label, script, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`\n### ${label}`)
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code ?? 'unknown'})`))))
  })
}

/** The clips every downstream suite streams from. */
const FIXTURES = ['clip_a.mp4', 'clip_b.mp4', 'clip_c.mp4', 'clip_d.mp4', 'clip_a.srt', 'clip_emb.mkv']

if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing. Run `pnpm build` first (or use `pnpm test`, which builds).')
  process.exit(1)
}

const missing = FIXTURES.filter((f) => !fs.existsSync(path.join(here, f)))
if (missing.length > 0) {
  await step(`fixtures (${missing.join(', ')})`, path.join(here, 'make-fixtures.mjs'))
}

try {
  await step('bundles', path.join(here, 'build-bundles.mjs'))
  await step('checks', path.join(here, 'harness.mjs'))
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
