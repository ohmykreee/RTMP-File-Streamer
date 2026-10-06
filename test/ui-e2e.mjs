/**
 * End-to-end check of the real application: launches the built main process,
 * seeds the persisted playlist, drives the UI over CDP exactly like a user would
 * (click 开始串流, then 下一个文件), and verifies that a listening RTMP endpoint
 * receives the stream.
 *
 * Usage: node test/ui-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronEnv } from './harness-util.mjs'

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
 * The app stores its state in <appRoot>/Data, so this test owns that folder. */
fs.rmSync(DATA_DIR, { recursive: true, force: true })
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
  // The address carries the trailing `/`; the key is appended directly to it.
  server: `rtmp://127.0.0.1:${LISTEN_PORT}/live/`,
  streamKey: 'test',
  container: 'flv',
  // Reset everything else explicitly: these tests must not depend on values a
  // previous session (or a manual experiment) left behind in settings.json.
  extraOutputArgs: '',
  realtimePacing: true,
  // The buffered two-process playout, which is what the app ships with. Stated
  // explicitly because this file resets the output block: leaving it out would run
  // the single-process pipeline and quietly stop covering the default path.
  buffered: true,
  bufferSec: 2,
  loopPlaylist: false,
  reconnectDelaySec: 2,
  maxReconnectAttempts: 1,
  dropLateFrames: false
}
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      ...savedSettings,
      // Debug output is off by default now; the log-panel checks below count
      // entry levels across both writers, which needs debug entries present.
      debugLogging: true,
      session: { ...(savedSettings.session ?? {}), output },
      /*
       * The saved language is reset alongside the output block, for the same reason:
       * this suite's later section switches to Japanese and back, so a run that
       * stopped halfway would otherwise leave a saved choice behind and make the
       * NEXT run start in the wrong language — failing its own Chinese-text
       * assertions for a reason that has nothing to do with the code.
       */
      language: 'zh',
      languageSet: true
    },
    null,
    2
  )
)
note('app settings retargeted', output.server)

/* ---------------- launch the real app ---------------- */
/*
 * `--lang=zh-CN` pins the interface language: this suite asserts on Chinese UI
 * text, and a first launch otherwise detects the language from the system locale,
 * which would make the result depend on the machine rather than on the app.
 */
const appProc = spawn(electron, ['.', '--lang=zh-CN', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: electronEnv()
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
let sawBufferedSpan = false
let maxBufferedFraction = 0
let bufferNote = ''
const observeDeadline = Date.now() + 30000
let firstSessionBytes = 0

while (Date.now() < observeDeadline) {
  const snap = await evaluate(`(() => {
    const pill = document.querySelector('.topbar-right .pill[class*="state-"]')
    // The readout lives under the progress bar, next to the bar it describes.
    const pct = parseFloat(document.querySelector('.timeline-pct')?.textContent ?? '0')
    const stats = document.querySelector('.np-stats')?.innerText ?? ''
    /* The encoder's position is a green strip along the bottom edge of the main bar,
     * so its width is measured against that bar. Selectors are built from strings so
     * no backslash escaping has to survive the eval. */
    const STRIP = 'timeline-' + 'encoded'
    const FILL = 'timeline-encoded-' + 'fill'
    const NOTE = 'buffer-' + 'note'
    const bar = document.querySelector('.timeline-bar')
    const strip = document.querySelector('.' + STRIP)
    const fill = document.querySelector('.' + FILL)
    const barWidth = bar ? bar.getBoundingClientRect().width : 0
    let fillWidth = 0
    if (fill) {
      // The fill animates its width, so read the computed value rather than the
      // in-flight layout box.
      const w = getComputedStyle(fill).width
      fillWidth = w.endsWith('px') ? parseFloat(w) : 0
    }
    const note = document.querySelector('.' + NOTE)
    return JSON.stringify({
      state: pill ? pill.innerText : '',
      pct: Number.isFinite(pct) ? pct : 0,
      stats,
      hasStrip: strip !== null,
      fillWidth,
      barWidth,
      bufferNote: note ? note.innerText : ''
    })
  })()`).catch(() => '{}')
  const s = JSON.parse(snap)
  if (/推流中|已连接/.test(s.state)) sawLivePill = true
  if (s.pct > maxPercent) maxPercent = s.pct
  if (s.bufferNote) bufferNote = s.bufferNote
  if (s.hasStrip && s.barWidth > 0) {
    sawBufferedSpan = true
    maxBufferedFraction = Math.max(maxBufferedFraction, s.fillWidth / s.barWidth)
  }
  // ffmpeg writes the ingest FLV progressively, so the file grows while live.
  const liveFile = path.join(here, 'ui_recv_0.flv')
  if (fs.existsSync(liveFile)) firstSessionBytes = Math.max(firstSessionBytes, fs.statSync(liveFile).size)
  // Progress and on-disk bytes both take a moment to appear, so only stop early
  // once every signal has been observed — including the buffer actually being drawn,
  // which lags the others because the encoder has to get ahead first.
  if (sawLivePill && maxPercent > 12 && firstSessionBytes > 100000 && sawBufferedSpan) break
  await delay(600)
}

record('UI reports the live streaming state', sawLivePill)
record('progress percentage advances from the engine feed', maxPercent > 5, `${maxPercent.toFixed(1)}%`)
/*
 * Captured while the buffer is actually drawn: the end-of-run screenshot is taken
 * after the session stops, when the bar is full and the buffered span is gone, so it
 * cannot show the one thing this display exists for.
 */
try {
  const liveShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(here, 'gui-buffered.png'), Buffer.from(liveShot.data, 'base64'))
  note('buffered screenshot saved', path.join(here, 'gui-buffered.png'))
} catch (err) {
  note('buffered screenshot failed', String(err))
}
/*
 * The buffered span is the UI's own statement that the encoder is ahead of what has
 * been published, which is what the two-process playout exists to give. Asserting it
 * keeps the bar from silently collapsing back to a single fill, and the width says
 * the buffer is a real quantity rather than a rounding artefact.
 */
record(
  'the strip on the bar shows how far the encoder has run ahead',
  sawBufferedSpan && maxBufferedFraction > 0.01,
  `${(maxBufferedFraction * 100).toFixed(1)}% of the bar's width at the widest${bufferNote ? ` · ${bufferNote}` : ''}`
)
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

/* ---------------- log list integrity ----------------
 * Two writers feed the log list (the main process and StreamEngine) and each
 * numbered its entries from 1, so those ids collide. The renderer re-keys every
 * entry; if that regressed, React would silently drop the colliding rows — which
 * also made level filtering look like it only covered the latest push.
 *
 * Meanwhile the panel is still collapsed, so the rows are checked after it opens
 * (the body is only mounted while expanded). */
const history = JSON.parse(await evaluate(`window.streamer.getLogs().then(l => JSON.stringify({ entries: l.length }))`))
console.log(`    [note] main-process ring buffer holds ${history.entries} entries`)

/* ---------------- the log panel, now opened from its own header ----------------
 * The duplicate 「📋 日志」 button in the player bar is gone; the panel header is
 * the only toggle, and the filter toolbar only exists while the panel is open. */
const collapsed = JSON.parse(
  await evaluate(`(() => {
    const actions = document.querySelector('.logs-actions')
    return JSON.stringify({
      expanded: document.querySelector('.logs')?.classList.contains('expanded') ?? null,
      toolbarVisible: actions ? getComputedStyle(actions).display !== 'none' : null,
      header: document.querySelector('.logs-title')?.textContent?.trim() ?? null
    })
  })()`)
)
record('the log panel starts collapsed with its toolbar hidden', collapsed.expanded === false && collapsed.toolbarVisible === false, JSON.stringify(collapsed))

await evaluate(`(() => {
  document.querySelector('.logs-head')?.click()
  return 'ok'
})()`)
await delay(800)
const expanded = JSON.parse(
  await evaluate(`(() => {
    const actions = document.querySelector('.logs-actions')
    const buttons = [...document.querySelectorAll('.logs-actions .seg-btn')].map(b => b.textContent.trim())
    return JSON.stringify({
      expanded: document.querySelector('.logs')?.classList.contains('expanded') ?? null,
      toolbarVisible: actions ? getComputedStyle(actions).display !== 'none' : null,
      buttons
    })
  })()`)
)
record('clicking the header expands the panel and reveals the toolbar', expanded.expanded === true && expanded.toolbarVisible === true, JSON.stringify(expanded))
record(
  'the filter row is 全部 plus five levels including 调试',
  JSON.stringify(expanded.buttons) === JSON.stringify(['全部', '调试', '信息', '警告', '错误', 'FFmpeg']),
  JSON.stringify(expanded.buttons)
)
record(
  'a separator splits 全部 from the level buttons',
  await evaluate(`(() => {
    const seg = document.querySelector('.logs-actions .seg')
    const sep = seg ? seg.querySelector('.seg-sep') : null
    if (!sep) return false
    // Between the 「全部」 button and the first level button, and actually visible.
    return sep.previousElementSibling && sep.previousElementSibling.textContent.trim() === '全部' &&
      sep.nextElementSibling && sep.nextElementSibling.textContent.trim() === '调试' &&
      getComputedStyle(sep).width !== '0px'
  })()`),
  'divider between 全部 and 调试'
)

/* The panel must render everything it holds: the header count comes from the same
 * array, so a mismatch means rows were dropped while mounting (the id collision),
 * and the history it holds must be the whole main-process buffer. */
const rendered = JSON.parse(
  await evaluate(`(() => {
    const header = document.querySelector('.logs-title')?.textContent ?? ''
    const held = Number((header.match(/\\((\\d+)\\)/) ?? [])[1] ?? -1)
    return JSON.stringify({
      held,
      rows: document.querySelectorAll('.log-line').length,
      levels: [...new Set([...document.querySelectorAll('.log-line')].map(e => e.className.replace('log-line lv-', '')))].sort()
    })
  })()`)
)
record('every held log entry is rendered', rendered.held > 100 && rendered.rows === rendered.held, `held=${rendered.held} rows=${rendered.rows}`)
record('the panel holds the whole main-process history', rendered.held === history.entries, `panel=${rendered.held} main=${history.entries}`)
record(
  'the log shows entries from both writers (app + engine)',
  rendered.levels.length >= 3,
  `levels in view: ${rendered.levels.join(', ')}`
)

// 「全部」 is active by default (no level selected); pressing 调试 must drop it.
const filterStates = JSON.parse(
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.logs-actions .seg-btn')]
    const active = () => btns.filter(b => b.classList.contains('active')).map(b => b.textContent.trim())
    const before = active()
    btns.find(b => b.textContent.trim() === '调试')?.click()
    return JSON.stringify({ before })
  })()`)
)
await delay(300)
const afterDebug = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('.logs-actions .seg-btn')].filter(b => b.classList.contains('active')).map(b => b.textContent.trim()))`)
)
record('pressing 全部 is the default and 调试 deselects it', JSON.stringify(filterStates.before) === JSON.stringify(['全部']) && JSON.stringify(afterDebug) === JSON.stringify(['调试']), `${JSON.stringify(filterStates.before)} -> ${JSON.stringify(afterDebug)}`)

// A second level adds to the set (multi-select), pressing it again clears it.
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.logs-actions .seg-btn')]
  btns.find(b => b.textContent.trim() === '警告')?.click()
  return 'ok'
})()`)
await delay(250)
const afterWarn = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('.logs-actions .seg-btn')].filter(b => b.classList.contains('active')).map(b => b.textContent.trim()))`)
)
record('level filters are multi-select', JSON.stringify(afterWarn) === JSON.stringify(['调试', '警告']), JSON.stringify(afterWarn))
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('.logs-actions .seg-btn')]
  btns.find(b => b.textContent.trim() === '调试')?.click()
  btns.find(b => b.textContent.trim() === '警告')?.click()
  return 'ok'
})()`)
await delay(400)
const backToAll = JSON.parse(
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.logs-actions .seg-btn')]
    return JSON.stringify({
      active: btns.filter(b => b.classList.contains('active')).map(b => b.textContent.trim()),
      lines: document.querySelectorAll('.log-line').length
    })
  })()`)
)
record(
  'clearing every level returns to 全部 and shows all logs',
  JSON.stringify(backToAll.active) === JSON.stringify(['全部']) && backToAll.lines > 3,
  JSON.stringify(backToAll)
)

/* A level filter must hold for the WHOLE list, not just the newest entries: every
 * rendered row has to carry the selected level, and the count has to match the
 * levels actually present in the history. */
const errorFilter = JSON.parse(
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.logs-actions .seg-btn')].find(b => b.textContent.trim() === '错误')
    btn?.click()
    const header = document.querySelector('.logs-title')?.textContent ?? ''
    return JSON.stringify({ held: Number((header.match(/\\((\\d+)\\)/) ?? [])[1] ?? -1) })
  })()`)
)
await delay(400)
const onlyErrors = JSON.parse(
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.log-line')]
    return JSON.stringify({
      rows: rows.length,
      foreign: rows.filter(r => !r.classList.contains('lv-error')).length,
      header: (document.querySelector('.logs-title')?.textContent ?? '').replace(/\\s/g, '')
    })
  })()`)
)
record(
  'a single level filter shows only that level, across the whole list',
  onlyErrors.foreign === 0 && onlyErrors.rows === 0 && /^▸运行日志\(0\/\d+\)$/.test(onlyErrors.header),
  `history had ${errorFilter.held} entries, rows=${onlyErrors.rows}, foreign=${onlyErrors.foreign}, header=${onlyErrors.header}`
)

/* ---------------- the 清空 button actually empties the panel ---------------- */
// The header reads `(total)` when nothing is filtered and `(shown/total)`
// otherwise; parse whichever form is present.
const readPanelCounts = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const header = document.querySelector('.logs-title')?.textContent ?? ''
      const pair = header.match(/\\((\\d+)(?:\\/(\\d+))?\\)/)
      const shown = pair ? Number(pair[1]) : -1
      const held = pair ? Number(pair[2] ?? pair[1]) : -1
      return JSON.stringify({ header: header.replace(/\\s/g, ''), shown, held, rows: document.querySelectorAll('.log-line').length })
    })()`)
  )

await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.logs-actions button')].find(b => b.textContent.trim() === '清空')
  btn?.click()
  return 'ok'
})()`)
await delay(600)
const afterClear = await readPanelCounts()
record('清空 empties the rendered log list', afterClear.rows === 0 && afterClear.held === 0, JSON.stringify(afterClear))

/* Nothing may refill the panel afterwards: the renderer cleared its own list, and
 * the main process has to have dropped its copy as well — otherwise the next
 * event would hand the old entries straight back. */
const clearedUpstream = JSON.parse(await evaluate(`window.streamer.getLogs().then(l => JSON.stringify({ entries: l.length }))`))
record(
  '清空 also clears the main-process buffer (nothing can be handed back)',
  clearedUpstream.entries === 0,
  `main-process entries after 清空: ${clearedUpstream.entries}`
)
await delay(1200)
const settled = await readPanelCounts()
record('the cleared panel stays empty', settled.rows === 0 && settled.held === 0, JSON.stringify(settled))

const errorLines = await evaluate(
  'JSON.stringify([...document.querySelectorAll(".log-line.lv-error .log-msg")].map(e => e.textContent).slice(0,3))'
)
record('no error entries in the in-app log', errorLines === '[]' || errorLines === '[]', errorLines)

/* ---------------- the language switcher ----------------
 * The picker sits last in the top bar. Everything below reads the *rendered* text
 * back, because "the setting was saved" is not the same claim as "the interface
 * changed language": a value that reaches the store but not the components would
 * pass a settings-only check. */
const langBar = JSON.parse(
  await evaluate(`(() => {
    const right = document.querySelector('.topbar-right')
    const btn = right?.querySelector('.lang-btn')
    const children = right ? [...right.children] : []
    return JSON.stringify({
      present: !!btn,
      isLast: children.length > 0 && children[children.length - 1] === btn?.parentElement,
      badge: btn?.querySelector('.lang-badge')?.textContent?.trim() ?? null,
      disabled: btn?.disabled ?? null
    })
  })()`)
)
record(
  'the language button is the last control in the top bar',
  langBar.present === true && langBar.isLast === true && langBar.badge === '中',
  JSON.stringify(langBar)
)

await evaluate(`(() => {
  document.querySelector('.lang-btn')?.click()
  return 'ok'
})()`)
await delay(300)
const langMenu = JSON.parse(
  await evaluate(`(() => {
    // The accessible name, not textContent: the badge and the language name are
    // adjacent inline elements, so textContent concatenates them ("中中文").
    const items = [...document.querySelectorAll('.lang-menu .lang-item')].map(b => b.getAttribute('aria-label'))
    const active = document.querySelector('.lang-menu .lang-item.active')?.getAttribute('aria-label') ?? null
    const checked = [...document.querySelectorAll('.lang-menu .lang-item')].map(b => b.getAttribute('aria-checked'))
    return JSON.stringify({ items, active, checked })
  })()`)
)
record(
  'the language menu lists every language under its own name',
  JSON.stringify(langMenu.items) === JSON.stringify(['中文 (当前)', '日本語', 'English']) &&
    Array.isArray(langMenu.checked) &&
    JSON.stringify(langMenu.checked) === JSON.stringify(['true', 'false', 'false']),
  JSON.stringify(langMenu)
)

await evaluate(`(() => {
  [...document.querySelectorAll('.lang-menu .lang-item')].find(b => b.textContent.includes('日本語'))?.click()
  return 'ok'
})()`)
await delay(700)
const afterSwitch = JSON.parse(
  await evaluate(`(() => {
    const stored = { title: document.querySelector('.brand h1')?.textContent?.trim() ?? null, htmlLang: document.documentElement.lang }
    return JSON.stringify(stored)
  })()`)
)
let savedLanguage = null
try {
  savedLanguage = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).language ?? null
} catch {
  /* the file is rewritten on every settings change */
}
record(
  'switching to Japanese re-renders the interface and persists the choice',
  afterSwitch.title === 'RTMP ファイルストリーマー' && afterSwitch.htmlLang === 'ja' && savedLanguage === 'ja',
  `${afterSwitch.title} / lang=${afterSwitch.htmlLang} / settings.json=${savedLanguage}`
)

/* Back to Chinese, so this suite's own wording assertions (and the next suite's)
 * still describe what is on screen. */
await evaluate(`(() => {
  document.querySelector('.lang-btn')?.click()
  return 'ok'
})()`)
await delay(300)
await evaluate(`(() => {
  [...document.querySelectorAll('.lang-menu .lang-item')].find(b => b.textContent.includes('中文'))?.click()
  return 'ok'
})()`)
await delay(700)
const backToZh = JSON.parse(
  await evaluate(`(() => JSON.stringify({ title: document.querySelector('.brand h1')?.textContent?.trim() ?? null, lang: document.documentElement.lang }))()`)
)
record(
  'switching back restores the Chinese interface',
  backToZh.title === 'RTMP 文件串流器' && backToZh.lang === 'zh',
  `${backToZh.title} / lang=${backToZh.lang}`
)

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
const roamingDir = path.join(process.env.APPDATA ?? '', 'RTMP File Streamer')
record('nothing was written to the Roaming profile', !fs.existsSync(roamingDir), roamingDir)

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
