/**
 * Verifies where the app keeps its state.
 *
 * The built `out/` app run from the project root writes everything into `Data/` beside
 * it and nothing into the Roaming profile — the layout the portable folder depends on.
 *
 * The development build is the only thing launched here. The packaged
 * `release/win-unpacked` copy is a build artefact with no code signature, so the OS
 * refuses to start it: the checks that used to launch it (and a copy of it moved to
 * another folder) failed for a reason that has nothing to do with this app. Nothing
 * else about the artefact is inspected either, for the same reason — what ships is
 * verified where it is produced, not by starting it here.
 *
 * Usage: node test/data-dir-e2e.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronEnv } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const results = []
const note = (s, d) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` — ${d}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- helpers ---------------- */

async function connect(cdpPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not up yet */
    }
    await delay(400)
  }
  return null
}

function makeClient(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  })
  const ready = new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  return { ready, send, ev, close: () => ws.close() }
}

/** Launches an app, waits for the UI, exercises the state files, and reports. */
async function checkLayout({ label, command, args, cwd, expectedDataDir, cdpPort }) {
  note(`launching ${label}`, `cwd=${cwd}`)
  // `electronEnv` strips the variables that turn Electron into plain node; without
  // that the app exits immediately and this reads as "the OS would not launch it".
  const child = spawn(command, args, { cwd, env: electronEnv() })
  let log = ''
  child.stdout?.on('data', (d) => (log += d.toString()))
  child.stderr?.on('data', (d) => (log += d.toString()))

  const page = await connect(cdpPort)
  if (!page) {
    record(`${label}: app starts`, false, log.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-400) || 'no CDP target')
    child.kill('SIGKILL')
    return
  }
  const client = makeClient(page)
  await client.ready
  await client.send('Runtime.enable')

  // Wait for the UI to finish booting.
  let booted = false
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    booted = await client.ev('!!document.querySelector(".preset-bar")').catch(() => false)
    if (booted) break
    await delay(400)
  }
  record(`${label}: app starts with the settings UI`, booted)

  const location = JSON.parse(await client.ev('window.streamer.getPresets().then(p => JSON.stringify(p.location))'))
  note(`${label}: resolved data dir`, location.dir)

  record(
    `${label}: Data folder sits in the application directory`,
    path.resolve(location.dir) === path.resolve(expectedDataDir),
    `${location.dir} (expected ${expectedDataDir})`
  )
  record(`${label}: report says the folder is writable`, location.writable === true)
  record(`${label}: Data folder exists on disk`, fs.existsSync(expectedDataDir), expectedDataDir)

  // Saving a preset must create Data/presets.json.
  const presetName = `${label} 预设`
  await client.ev(`(async () => {
    const s = await window.streamer.getSettings()
    await window.streamer.savePreset(${JSON.stringify(presetName)}, s.session)
    return 'ok'
  })()`)
  await delay(700)

  const presetsFile = path.join(expectedDataDir, 'presets.json')
  record(`${label}: presets.json written into Data/`, fs.existsSync(presetsFile), presetsFile)
  if (fs.existsSync(presetsFile)) {
    const text = fs.readFileSync(presetsFile, 'utf8')
    const parsed = JSON.parse(text)
    record(
      `${label}: preset readable with intact UTF-8 name`,
      (parsed.presets ?? []).some((p) => p.name === presetName),
      `${(parsed.presets ?? []).length} preset(s)`
    )
  }

  // Playlist persistence also lives there. Both files are written lazily, so the
  // test has to actually change something for them to appear.
  const playlistFile = path.join(expectedDataDir, 'playlist.json')
  const settingsFile = path.join(expectedDataDir, 'settings.json')
  const clip = path.join(here, 'clip_c.mp4')
  await client.ev(`(async () => {
    const s = await window.streamer.getSettings()
    await window.streamer.saveSettings({ session: { ...s.session, video: { ...s.session.video, bitrateKbps: 4321 } } })
    return 'ok'
  })()`)
  await delay(600)
  if (fs.existsSync(clip)) {
    await client.ev(`window.streamer.addItems([${JSON.stringify(clip)}]).then(() => 'ok')`)
    await delay(1500)
  }
  record(`${label}: settings.json written into Data/`, fs.existsSync(settingsFile), settingsFile)
  record(`${label}: playlist.json written into Data/`, fs.existsSync(playlistFile), playlistFile)
  if (fs.existsSync(settingsFile)) {
    const round = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    record(
      `${label}: the value just changed is the one stored there`,
      round.session?.video?.bitrateKbps === 4321,
      `bitrateKbps=${round.session?.video?.bitrateKbps}`
    )
  }

  // Caches are kept inside Data/ as well, not in the user profile.
  const cacheDir = path.join(expectedDataDir, 'Cache')
  const roamingDir = path.join(process.env.APPDATA ?? '', 'RTMP File Streamer')
  record(`${label}: cache folder created inside Data/`, fs.existsSync(cacheDir), cacheDir)
  record(`${label}: nothing written to the Roaming profile`, !fs.existsSync(roamingDir), roamingDir)

  client.close()
  child.kill('SIGKILL')
  await delay(1200)
}

/* ---------------- the only launch: the built app from the project root ---------------- */
const devData = path.join(root, 'Data')
fs.rmSync(devData, { recursive: true, force: true })

await checkLayout({
  label: '开发构建',
  command: electron,
  args: ['.', '--remote-debugging-port=9841', '--remote-allow-origins=*'],
  cwd: root,
  expectedDataDir: devData,
  cdpPort: 9841
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} data-directory checks passed`)
fs.writeFileSync(path.join(here, 'data-dir-report.json'), JSON.stringify({ results }, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
