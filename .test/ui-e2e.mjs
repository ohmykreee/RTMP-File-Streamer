/**
 * End-to-end check of the real application: launches the built main process,
 * seeds the persisted playlist, drives the UI over CDP exactly like a user would
 * (click 开始串流, then 下一个文件), and verifies that a listening RTMP endpoint
 * receives the stream.
 *
 * Usage: node .test/ui-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe'
const LISTEN_PORT = 14935
const CDP_PORT = 9444
/**
 * The app keeps all state in `<appRoot>/Data`. In development (how this test
 * launches it) the app root is the working directory, i.e. the project folder.
 */
const LEGACY_DATA = path.join(process.env.APPDATA ?? '', 'RTMP File Streamer')
const DATA_DIR = path.join(root, 'Data')

const results = []
const note = (step, detail) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? ` — ${detail}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- clean slate ----------------
 * The app stores its state in <appRoot>/Data, so this test owns that folder.
 * The pre-migration %APPDATA% folder is removed too, otherwise the app's
 * first-run migration would copy stale settings back in. */
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.rmSync(LEGACY_DATA, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

/* ---------------- seed the app's saved playlist ---------------- */
const clipA = path.join(here, 'clip_a.mp4')
const clipB = path.join(here, 'clip_b.mp4')
const srt = path.join(here, 'clip_a.srt')

const probe = (file) => {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    encoding: 'utf8'
  })
  return JSON.parse(r.stdout)
}
const infoA = probe(clipA)
const infoB = probe(clipB)
const durationOf = (p) => Number(p.format?.duration ?? 0)

const mkItem = (id, file, info, withSub) => ({
  id,
  path: file,
  name: path.basename(file),
  size: Number(info.format?.size ?? 0),
  durationSec: durationOf(info),
  subtitleTracks: withSub
    ? [{ id: `ext:${srt}`, source: 'external', path: srt, codec: 'subrip', family: 'text', title: 'clip_a.srt' }]
    : [],
  selectedSubtitleId: withSub ? `ext:${srt}` : null,
  mode: withSub ? 'burn' : 'off',
  syncOffsetSec: 0,
  subtitleDelaySec: 0,
  status: 'pending'
})

fs.writeFileSync(
  path.join(DATA_DIR, 'playlist.json'),
  JSON.stringify({ items: [mkItem('a', clipA, infoA, true), mkItem('b', clipB, infoB, false)] }, null, 2)
)
note('seeded saved playlist', path.join(DATA_DIR, 'playlist.json'))

/* ---------------- RTMP ingest accepting repeated publishes ---------------- */
const sessions = []
let stopping = false
const acceptConnections = () => {
  if (stopping) return
  const index = sessions.length
  const file = path.join(here, `ui_recv_${index}.flv`)
  fs.rmSync(file, { force: true })
  const proc = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-f',
      'flv',
      '-i',
      `rtmp://127.0.0.1:${LISTEN_PORT}/live/test`,
      '-c',
      'copy',
      '-f',
      'flv',
      '-y',
      file
    ],
    { windowsHide: true }
  )
  proc.on('close', () => {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    sessions.push({ index, file, size })
    note(`ingest#${index} closed`, `${(size / 1024).toFixed(0)} KB`)
    if (!stopping) setTimeout(acceptConnections, 150)
  })
  proc.on('error', () => {})
}
acceptConnections()
await delay(1500)
note('test ingest listening', `rtmp://127.0.0.1:${LISTEN_PORT}/live/test`)

/* ---------------- point the app at that ingest ---------------- */
const settingsFile = path.join(DATA_DIR, 'settings.json')
let savedSettings = {}
try {
  savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
} catch {
  /* first run */
}
const output = {
  ...(savedSettings.session?.output ?? {}),
  rtmpUrl: `rtmp://127.0.0.1:${LISTEN_PORT}/live`,
  streamKey: 'test',
  container: 'flv',
  // Reset everything else explicitly: these tests must not depend on values a
  // previous session (or a manual experiment) left behind in settings.json.
  extraOutputArgs: '',
  realtimePacing: true,
  loopPlaylist: false,
  reconnectDelaySec: 2,
  maxReconnectAttempts: 1,
  gapBetweenItemsSec: 0.5,
  seekAccuracy: 'fast',
  dropLateFrames: false
}
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ ...savedSettings, session: { ...(savedSettings.session ?? {}), output } }, null, 2)
)
note('app settings retargeted', output.rtmpUrl)

/* ---------------- launch the real app ---------------- */
const appProc = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
})
let appLog = ''
appProc.stdout?.on('data', (d) => (appLog += d.toString()))
appProc.stderr?.on('data', (d) => (appLog += d.toString()))

/* ---------------- CDP plumbing ---------------- */
async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not ready yet */
    }
    await delay(400)
  }
  return null
}

const target = await waitForTarget()
if (!target) {
  console.error('FAILED: renderer never exposed a CDP target\n', appLog.slice(-2000))
  appProc.kill('SIGKILL')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const pageErrors = []

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    pageErrors.push(msg.params.entry.text)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
  return res.result.value
}

/** Wait until the React app has booted and the bridge is usable. */
async function waitForApp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await evaluate(
      'typeof window.streamer === "object" && !!document.querySelector(".player") && !!document.querySelector(".playlist")'
    ).catch(() => false)
    if (ok) return true
    await delay(400)
  }
  return false
}

const booted = await waitForApp()
record('application window booted with the workspace UI', booted)
if (!booted) {
  console.error('page text:', await evaluate('document.body.innerText.slice(0,600)').catch(() => 'n/a'))
  ws.close()
  appProc.kill('SIGKILL')
  process.exit(1)
}

/* ---------------- verify what the UI shows ---------------- */
const playlistRows = await evaluate('document.querySelectorAll(".playlist-item").length')
record('saved playlist restored into the UI', playlistRows === 2, `${playlistRows} rows`)

const shownNames = await evaluate(
  'JSON.stringify([...document.querySelectorAll(".pi-name")].map(e => e.textContent))'
)
record('restored entries are the expected files', shownNames.includes('clip_a.mp4') && shownNames.includes('clip_b.mp4'), shownNames)

const subtitleBadge = await evaluate(
  'JSON.stringify([...document.querySelectorAll(".playlist-item .badge")].map(e => e.textContent.trim()))'
)
record('sidecar subtitle is advertised on the first entry', subtitleBadge.includes('字幕'), subtitleBadge)

/* The header renders the ffmpeg pill only after capability probing finishes. */
let ffmpegPill = ''
{
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    ffmpegPill = await evaluate(
      'JSON.stringify([...document.querySelectorAll(".topbar-right .pill")].map(e => e.textContent.trim()))'
    )
    if (ffmpegPill.toLowerCase().includes('ffmpeg')) break
    await delay(300)
  }
}
record('ffmpeg build is reported in the header', ffmpegPill.toLowerCase().includes('ffmpeg'), ffmpegPill)

const startLabel = await evaluate('(document.querySelector(".controls .btn")?.textContent ?? "").trim()')
record('start button is enabled with a populated queue', startLabel.includes('开始串流'), startLabel)

/* ---------------- click 开始串流 ---------------- */
/** React re-renders asynchronously, so poll until the button is actually clickable. */
async function clickWhenReady(matcher, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = 'not-found'
  while (Date.now() < deadline) {
    last = await evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')]
      const target = btns.find(b => b.textContent.includes(${JSON.stringify(matcher)}) && !b.disabled)
      if (!target) return 'not-found'
      target.click()
      return 'clicked'
    })()`)
    if (last === 'clicked') return last
    await delay(300)
  }
  return last
}

note('clicking 开始串流')
const clicked = await clickWhenReady('开始串流', 20000)
record('the start button is clickable through the UI', clicked === 'clicked', clicked)

/* ---------------- observe live progress in the DOM ---------------- */
let sawLivePill = false
let maxPercent = 0
const observeDeadline = Date.now() + 30000
let firstSessionBytes = 0

while (Date.now() < observeDeadline) {
  const snap = await evaluate(`(() => {
    const pill = document.querySelector('.topbar-right .pill[class*="state-"]')
    const pct = parseFloat(document.querySelector('.progress-pct')?.textContent ?? '0')
    const stats = document.querySelector('.np-stats')?.innerText ?? ''
    return JSON.stringify({ state: pill?.innerText ?? '', pct: Number.isFinite(pct) ? pct : 0, stats })
  })()`).catch(() => '{}')
  const s = JSON.parse(snap)
  if (/推流中|已连接/.test(s.state)) sawLivePill = true
  if (s.pct > maxPercent) maxPercent = s.pct
  // ffmpeg writes the ingest FLV progressively, so the file grows while live.
  const liveFile = path.join(here, 'ui_recv_0.flv')
  if (fs.existsSync(liveFile)) firstSessionBytes = Math.max(firstSessionBytes, fs.statSync(liveFile).size)
  // Progress and on-disk bytes both take a moment to appear, so only stop early
  // once all three signals have been observed.
  if (sawLivePill && maxPercent > 12 && firstSessionBytes > 100000) break
  await delay(600)
}

record('UI reports the live streaming state', sawLivePill)
record('progress percentage advances from the engine feed', maxPercent > 5, `${maxPercent.toFixed(1)}%`)
record(
  'ingest server receives data while the session is live',
  firstSessionBytes > 100000,
  `${(firstSessionBytes / 1024).toFixed(0)} KB written to the first session file`
)

/* ---------------- drag the progress bar / click 下一个文件 ---------------- */
note('clicking 下一个文件')
const skipClicked = await clickWhenReady('下一个文件', 15000)
record('the skip button is clickable while live', skipClicked === 'clicked', skipClicked)

let reachedSecond = false
const skipDeadline = Date.now() + 20000
while (Date.now() < skipDeadline) {
  const text = await evaluate('(document.querySelector(".now-playing")?.innerText ?? "")').catch(() => '')
  if (text.includes('clip_b.mp4')) {
    reachedSecond = true
    break
  }
  await delay(500)
}
record('skipping advanced the UI to the second entry', reachedSecond)

/* ---------------- finish and inspect what arrived ---------------- */
let idleReached = false
const finishDeadline = Date.now() + 40000
while (Date.now() < finishDeadline) {
  const state = await evaluate('(document.querySelector(".topbar-right .pill[class*=\\"state-\\"]")?.innerText ?? "")').catch(() => '')
  if (state.includes('空闲')) {
    idleReached = true
    break
  }
  await delay(600)
}
record('session returned to idle after the queue finished', idleReached)

const logsText = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('日志'))
  btn?.click()
  return 'ok'
})()`)
void logsText
await delay(800)
const logLines = await evaluate('document.querySelectorAll(".log-line").length')
record('the in-app log panel has entries', logLines > 3, `${logLines} lines`)
const errorLines = await evaluate(
  'JSON.stringify([...document.querySelectorAll(".log-line.lv-error .log-msg")].map(e => e.textContent).slice(0,3))'
)
record('no error entries in the in-app log', errorLines === '[]' || errorLines === '[]', errorLines)

/* ---------------- state must live in the app's Data folder ----------------
 * Queried while the app is still alive: killing it first would leave this CDP
 * call waiting on a dead socket forever. */
const location = JSON.parse(await evaluate('window.streamer.getPresets().then(p => JSON.stringify(p.location))'))
record(
  'Data folder is inside the application directory',
  path.resolve(location.dir) === path.resolve(DATA_DIR),
  `${location.dir} (expected ${DATA_DIR})`
)
record(
  'settings and playlist were written there',
  fs.existsSync(path.join(DATA_DIR, 'settings.json')) && fs.existsSync(path.join(DATA_DIR, 'playlist.json')),
  ['settings.json', 'playlist.json'].filter((f) => fs.existsSync(path.join(DATA_DIR, f))).join(', ')
)
record('nothing was written to the Roaming profile', !fs.existsSync(LEGACY_DATA), LEGACY_DATA)

/* ---------------- shut down and check the ingested media ---------------- */
const uiShot = path.join(here, 'gui-live.png')
try {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(uiShot, Buffer.from(shot.data, 'base64'))
  note('screenshot saved', uiShot)
} catch (err) {
  note('screenshot failed', String(err))
}

stopping = true
await delay(1000)
appProc.kill('SIGKILL')
await delay(1200)

const good = sessions.filter((s) => s.size > 50000)
record('ingest received at least one full publish session', good.length >= 1, `sessions: ${sessions.map((s) => `${(s.size / 1024).toFixed(0)}KB`).join(', ')}`)

for (const s of good.slice(0, 2)) {
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,avg_frame_rate', '-print_format', 'json', s.file],
    { encoding: 'utf8' }
  )
  try {
    const p = JSON.parse(r.stdout || '{}')
    const st = p.streams?.[0] ?? {}
    const [n, d] = String(st.avg_frame_rate ?? '0/0').split('/').map(Number)
    const fps = n && d ? n / d : 0
    const content = fps ? Number(st.nb_read_frames) / fps : NaN
    record(
      `session #${s.index} carries decodable video`,
      st.codec_name === 'h264' && content > 2,
      `${st.codec_name} ${st.width}x${st.height}, ${content.toFixed(1)}s`
    )
  } catch (err) {
    record(`session #${s.index} carries decodable video`, false, String(err))
  }
}

record('no uncaught exceptions in the renderer', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none')

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} UI end-to-end checks passed`)
fs.writeFileSync(path.join(here, 'ui-e2e-report.json'), JSON.stringify({ results, sessions, appLogTail: appLog.slice(-4000) }, null, 2))
ws.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
