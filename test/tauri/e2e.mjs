/**
 * The whole Tauri end-to-end run, behind one command: `pnpm test:tauri`.
 *
 *   node test/tauri/e2e.mjs                 run every suite, in order
 *   node test/tauri/e2e.mjs ui preset       run only the named suites
 *
 * Ported from `test/e2e.mjs` (Electron) with two changes:
 *   - the suites are the Tauri ports in this folder; they spawn the release exe
 *     built from `src-tauri` (see `launch.mjs` for how the CDP endpoint is
 *     reached through WebView2, and for the required `custom-protocol` build
 *     feature)
 *   - there are no `engine` / `enginebuffered` suites: the engine scenarios now
 *     live in the Rust test crate — run them with `cargo test --test engine`
 *     (or `pnpm test:cargo`).
 *
 * A suite that fails stops the run: later suites would otherwise pile up more
 * app windows and ffmpeg processes on top of an already-broken app.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appExePath } from './launch.mjs'
import { killStrays, tauriAppEnv } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const testDir = path.resolve(here, '..')

/** name -> { script, budget, what } */
const SUITES = {
  ui: { script: 'ui-e2e.mjs', budget: 420_000, what: 'UI: queue, start/stop/skip, log panel, ingest' },
  features: { script: 'features-e2e.mjs', budget: 600_000, what: 'burn-in, hardware encoder, seek, multi-file queue' },
  presets: { script: 'preset-e2e.mjs', budget: 420_000, what: 'presets, RTMP tab + obs-websocket controls, resolution/bitrate widgets' },
  layout: { script: 'layout-e2e.mjs', budget: 300_000, what: 'player bar geometry across tabs' },
  datadir: { script: 'data-dir-e2e.mjs', budget: 300_000, what: 'state files stay inside Data/' }
}

const ORDER = ['ui', 'features', 'presets', 'layout', 'datadir']

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node test/tauri/e2e.mjs [suite ...]')
  console.log(`suites: ${ORDER.join(', ')}`)
  process.exit(0)
}
const unknown = requested.filter((s) => !SUITES[s])
if (unknown.length > 0) {
  console.error(`unknown suite(s): ${unknown.join(', ')}\nknown suites: ${ORDER.join(', ')}`)
  process.exit(2)
}
const suites = requested.length > 0 ? requested : ORDER

/* The suites spawn the Tauri release exe; fail here with the fix if missing. */
let exe
try {
  exe = appExePath()
} catch (err) {
  console.error(String(err.message ?? err))
  process.exit(1)
}

/* The end-to-end suites stream from the shared fixtures. */
const FIXTURES = ['clip_a.mp4', 'clip_b.mp4', 'clip_c.mp4', 'clip_d.mp4', 'clip_a.srt']
if (FIXTURES.some((f) => !fs.existsSync(path.join(testDir, f)))) {
  console.log('Generating test media...')
  const gen = spawnSync(process.execPath, [path.join(testDir, 'make-fixtures.mjs')], { cwd: root, stdio: 'inherit' })
  if (gen.status !== 0) process.exit(gen.status ?? 1)
}

/* Leftovers from a killed previous run would trip the app's single-instance
 * guard and make every suite read as "the app never started". Only our own
 * cargo-built binary name is cleared here (not the packaged/Electron process
 * names) so a concurrent Electron run on this machine is not disturbed. */
killStrays(['rtmp-file-streamer'])

/** Every suite inherits the sanitised Tauri environment (see `tauriAppEnv`). */
const env = tauriAppEnv()

const runSuite = (name) =>
  new Promise((resolve) => {
    const suite = SUITES[name]
    console.log(`\n${'='.repeat(72)}\n=== e2e: ${name} — ${suite.what}\n${'='.repeat(72)}`)
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(here, suite.script)], { cwd: root, env, stdio: 'inherit' })

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
