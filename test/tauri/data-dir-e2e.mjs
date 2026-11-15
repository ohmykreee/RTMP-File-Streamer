/**
 * Verifies where the app keeps its state (Tauri build).
 *
 * The release exe run from the project root writes everything into `Data/` beside
 * it and nothing into the Roaming profile — the layout the portable folder depends
 * on. The exe resolves its state folder from its working directory, so the cwd is
 * the repo root (see `src-tauri/src/store/paths.rs`).
 *
 * Only the built app is launched here, exactly like the Electron original: a
 * packaged copy is a build artefact verified where it is produced, not by
 * starting it here.
 *
 * Ported from `test/data-dir-e2e.mjs` (Electron): the launch and the CDP target
 * discovery moved into `launch.mjs`, every assertion is unchanged.
 *
 * Usage: node test/tauri/data-dir-e2e.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchApp } from './launch.mjs'
import { killStrays } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const testDir = path.resolve(here, '..')
const CDP_PORT = 19841

const results = []
const note = (s, d) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` — ${d}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Launches an app, waits for the UI, exercises the state files, and reports. */
async function checkLayout({ label, expectedDataDir, cdpPort }) {
  note(`launching ${label}`, `cwd=${root}`)
  let app
  try {
    app = await launchApp({ cdpPort, args: [] })
  } catch (err) {
    record(`${label}: app starts`, false, String(err))
    return
  }
  const child = app.proc

  // Wait for the UI to finish booting.
  let booted = false
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    booted = await app.ev('!!document.querySelector(".preset-bar")').catch(() => false)
    if (booted) break
    await delay(400)
  }
  record(`${label}: app starts with the settings UI`, booted)

  const location = JSON.parse(await app.ev('window.streamer.getPresets().then(p => JSON.stringify(p.location))'))
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
  await app.ev(`(async () => {
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
  const clip = path.join(testDir, 'clip_c.mp4')
  await app.ev(`(async () => {
    const s = await window.streamer.getSettings()
    await window.streamer.saveSettings({ session: { ...s.session, video: { ...s.session.video, bitrateKbps: 4321 } } })
    return 'ok'
  })()`)
  await delay(600)
  if (fs.existsSync(clip)) {
    await app.ev(`window.streamer.addItems([${JSON.stringify(clip)}]).then(() => 'ok')`)
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

  app.close()
  child.kill('SIGKILL')
  killStrays()
  await delay(1200)
}

/* ---------------- the only launch: the built app from the project root ---------------- */
const devData = path.join(root, 'Data')
fs.rmSync(devData, { recursive: true, force: true })

await checkLayout({
  label: '开发构建',
  expectedDataDir: devData,
  cdpPort: CDP_PORT
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} data-directory checks passed`)
fs.writeFileSync(path.join(testDir, 'tauri-data-dir-report.json'), JSON.stringify({ results }, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
