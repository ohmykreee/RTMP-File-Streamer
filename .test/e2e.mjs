/**
 * The whole Electron end-to-end run, behind one command: `pnpm test:e2e`.
 *
 *   node .test/e2e.mjs                 run every suite, in order
 *   node .test/e2e.mjs ui preset       run only the named suites
 *
 * The suites are the existing `*-e2e.mjs` / `engine-run.cjs` drivers; this file
 * is only the dispatcher that used to be copy-pasted once per suite
 * (run-ui-test.mjs, run-features-test.mjs, run-preset-test.mjs,
 * run-engine-test.mjs — all of which just spawned Electron and forwarded the
 * exit code).
 *
 * A suite that fails stops the run: later suites would otherwise pile up more
 * Electron windows and ffmpeg processes on top of an already-broken app.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killStrays } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

/** name -> { script, how, budget } ; `how: 'electron-app'` boots the real app. */
const SUITES = {
  ui: { script: 'ui-e2e.mjs', how: 'node', budget: 420_000, what: 'UI: queue, start/pause/skip, log panel, ingest' },
  features: { script: 'features-e2e.mjs', how: 'node', budget: 600_000, what: 'burn-in, hardware encoder, seek, multi-file queue' },
  presets: { script: 'preset-e2e.mjs', how: 'node', budget: 420_000, what: 'presets, RTMP tab + obs-websocket controls, resolution/bitrate widgets' },
  layout: { script: 'layout-e2e.mjs', how: 'node', budget: 300_000, what: 'player bar geometry across tabs' },
  datadir: { script: 'data-dir-e2e.mjs', how: 'node', budget: 300_000, what: 'state files stay inside Data/' },
  engine: { script: 'engine-run.cjs', how: 'electron-app', budget: 300_000, what: 'engine lifecycle inside Electron without a window' }
}

const ORDER = ['ui', 'features', 'presets', 'layout', 'datadir', 'engine']

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node .test/e2e.mjs [suite ...]')
  console.log(`suites: ${ORDER.join(', ')}`)
  process.exit(0)
}
const unknown = requested.filter((s) => !SUITES[s])
if (unknown.length > 0) {
  console.error(`unknown suite(s): ${unknown.join(', ')}\nknown suites: ${ORDER.join(', ')}`)
  process.exit(2)
}
const suites = requested.length > 0 ? requested : ORDER

/* The end-to-end suites need the built app and the engine test bundle. */
if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing. Run `pnpm build` first (or use `pnpm test`, which builds).')
  process.exit(1)
}
if (suites.includes('engine') && !fs.existsSync(path.join(root, 'out', 'main', 'test-entry.cjs'))) {
  console.log('Building the engine test bundle...')
  const built = spawnSync(process.execPath, [path.join(here, 'build-bundles.mjs')], { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

const FIXTURES = ['clip_a.mp4', 'clip_b.mp4', 'clip_c.mp4', 'clip_a.srt']
if (FIXTURES.some((f) => !fs.existsSync(path.join(here, f)))) {
  console.log('Generating test media...')
  const gen = spawnSync(process.execPath, [path.join(here, 'make-fixtures.mjs')], { cwd: root, stdio: 'inherit' })
  if (gen.status !== 0) process.exit(gen.status ?? 1)
}

/** Electron must NOT run as plain node, or `app` is missing and no window opens. */
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const runSuite = (name) =>
  new Promise((resolve) => {
    const suite = SUITES[name]
    console.log(`\n${'='.repeat(72)}\n=== e2e: ${name} — ${suite.what}\n${'='.repeat(72)}`)
    const started = Date.now()
    // `engine-run.cjs` is the Electron main script itself: Electron is handed the
    // file, not node. The browser suites are plain node drivers that spawn the app.
    const child =
      suite.how === 'electron-app'
        ? spawn(electron, [path.join(here, suite.script)], { cwd: root, env, stdio: 'inherit' })
        : spawn(process.execPath, [path.join(here, suite.script)], { cwd: root, env, stdio: 'inherit' })

    // A wedged suite would hang `pnpm test` forever; the watchdog fails it instead.
    const timer = setTimeout(() => {
      console.error(`\n[watchdog] e2e:${name} exceeded ${(suite.budget / 1000).toFixed(0)}s — aborting the run.`)
      killStrays()
      child.kill('SIGKILL')
      resolve({ name, code: 3, seconds: (Date.now() - started) / 1000 })
    }, suite.budget)

    child.on('error', (err) => {
      clearTimeout(timer)
      console.error(`[e2e:${name}] could not start: ${String(err)}`)
      resolve({ name, code: 1, seconds: (Date.now() - started) / 1000 })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000 })
    })
  })

const outcomes = []
for (const name of suites) {
  const outcome = await runSuite(name)
  outcomes.push(outcome)
  console.log(`--- e2e:${name} ${outcome.code === 0 ? 'PASS' : 'FAIL'} (${outcome.seconds.toFixed(0)}s)`)
  if (outcome.code !== 0) {
    // Stop here: one broken suite usually breaks the next ones the same way.
    console.error('\nStopping after the first failing suite so the remaining ones do not stack windows on a broken app.')
    break
  }
}

console.log(`\n${'='.repeat(72)}\ne2e summary`)
for (const o of outcomes) console.log(`  ${o.code === 0 ? 'PASS' : 'FAIL'}  ${o.name.padEnd(10)} ${o.seconds.toFixed(0)}s`)
const failed = outcomes.filter((o) => o.code !== 0)
if (failed.length > 0) {
  console.error(`\n${failed.length}/${outcomes.length} suite(s) failed`)
  process.exit(1)
}
console.log('all suites passed')
