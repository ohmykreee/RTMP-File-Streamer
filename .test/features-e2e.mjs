/**
 * End-to-end regression test for the six UI/logging fixes:
 *   1. the RTMP destination (address + stream key) is saved into presets
 *      (covered by preset-e2e.mjs; here we cover the rest)
 *   2. drag-and-drop resolves real filesystem paths (Electron removed File.path)
 *      and non-video files dropped with them are ignored
 *   3. the stream key is masked (password) with a reveal toggle, kept in plain
 *      text on disk, and the UI shows no composed push target
 *   4. field hints render below their control so inputs stay aligned in a row
 *   5. the run log is persisted to Data/Logs and rotated within its size budget
 *   6. starting a stream locks every setting; stopping unlocks them again
 *
 * Every wait is bounded and the whole run sits under a watchdog, so a stall is
 * reported as a failure instead of hanging the suite.
 *
 * Usage: node .test/features-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installWatchdog, phase } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe'
const CDP_PORT = 9866
const STREAM_PORT = 16210
const TEST_PORT = 16211
const DATA_DIR = path.join(root, 'Data')
const LOGS_DIR = path.join(DATA_DIR, 'Logs')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const LEGACY_DATA = path.join(process.env.APPDATA ?? '', 'RTMP File Streamer')

const disarm = installWatchdog(240000, 'features-e2e')

const results = []
const note = (s, d) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` — ${d}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const clipA = path.join(here, 'clip_a.mp4')
const srtA = path.join(here, 'clip_a.srt')

if (!fs.existsSync(clipA) || !fs.existsSync(srtA)) {
  console.error('fixtures missing; run `node .test/make-fixtures.mjs` first')
  process.exit(1)
}

/* ---------------- clean slate + seeded state ---------------- */
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.rmSync(LEGACY_DATA, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

fs.writeFileSync(
  path.join(DATA_DIR, 'playlist.json'),
  JSON.stringify(
    {
      items: [
        {
          id: 'a',
          path: clipA,
          name: path.basename(clipA),
          size: fs.statSync(clipA).size,
          durationSec: 20,
          subtitleTracks: [],
          selectedSubtitleId: null,
          mode: 'off',
          syncOffsetSec: 0,
          subtitleDelaySec: 0,
          status: 'pending'
        }
      ]
    },
    null,
    2
  )
)
// The address ends with `/`; the key is appended directly to it.
fs.writeFileSync(
  SETTINGS_FILE,
  JSON.stringify(
    {
      ffmpegPath: '',
      ffprobePath: '',
      session: {
        output: {
          server: `rtmp://127.0.0.1:${STREAM_PORT}/live/`,
          streamKey: 'lock-test-key',
          container: 'flv',
          extraOutputArgs: '',
          realtimePacing: true,
          loopPlaylist: false,
          reconnectDelaySec: 2,
          maxReconnectAttempts: 0,
          dropLateFrames: false
        }
      }
    },
    null,
    2
  )
)

/* ---------------- launch the app + CDP scaffolding ---------------- */
// STREAMER_E2E moves the window off-screen and makes it click-through, so the
// physical mouse cannot interfere; CDP keeps working normally.
const appEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, STREAMER_E2E: '1' }
/*
 * `--lang=zh-CN` pins the interface language.
 *
 * On a first launch the app detects its language from the system locale, and this
 * suite asserts on Chinese UI text — so without the switch it would pass on a
 * Chinese machine and fail on an English one for reasons that have nothing to do
 * with the feature under test. Pinning it here also makes the detection itself
 * deterministic: `zh-CN` must resolve to Chinese, which is checked in the unit
 * suite against the pure rules.
 */
const appProc = spawn(electron, ['.', '--lang=zh-CN', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: appEnv
})

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not up yet */
    }
    await delay(400)
  }
  return null
}

const target = await waitForTarget()
if (!target) {
  console.error('FATAL: no CDP target; app failed to start')
  appProc.kill('SIGKILL')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const pageErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  }
})
// Bounded open: a wedged DevTools socket must fail the run, not hang it.
await new Promise((r, reject) => {
  ws.addEventListener('open', r, { once: true })
  const t = setTimeout(() => reject(new Error('CDP websocket never opened')), 15000)
  ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP websocket error')) }, { once: true })
})
// Every CDP round-trip is bounded: `Runtime.evaluate` with awaitPromise would
// otherwise park forever on a promise that never settles.
const send = (method, params = {}) =>
  new Promise((r, reject) => {
    const i = ++msgId
    const timer = setTimeout(() => {
      pending.delete(i)
      const hint = method === 'Runtime.evaluate' ? `: ${String(params.expression).slice(0, 90)}` : ''
      reject(new Error(`CDP ${method} timed out after 30s${hint}`))
    }, 30000)
    pending.set(i, (result) => {
      clearTimeout(timer)
      r(result)
    })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const ev = async (expr) => {
  const started = Date.now()
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  const ms = Date.now() - started
  if (ms > 1000) note(`slow CDP evaluate (${(ms / 1000).toFixed(1)}s)`, String(expr).slice(0, 80))
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
await send('Runtime.enable')

async function waitFor(label, probe, timeoutMs, intervalMs = 200) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeoutMs) {
    try {
      value = await probe()
    } catch {
      value = undefined
    }
    if (value) return { ok: true, value, waitedMs: Date.now() - started }
    await delay(intervalMs)
  }
  note('TIMEOUT', `${label} did not happen within ${timeoutMs}ms`)
  return { ok: false, value, waitedMs: Date.now() - started }
}

function bail(message) {
  console.error(`\nFATAL: ${message}`)
  try {
    appProc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  disarm()
  process.exit(1)
}

/* ================= boot ================= */
{
  const end = phase('awaiting application boot')
  const booted = await waitFor('settings panel to render', () => ev('!!document.querySelector(".settings-body")'), 25000)
  record('application booted', booted.ok, `after ${booted.waitedMs}ms`)
  end()
  if (!booted.ok) bail('the settings panel never rendered')
}

/* ================= 1. drag-and-drop path resolution ================= */
{
  const end = phase('drag-and-drop path resolution')
  // A hidden file input + DOM.setFileInputFiles is the only way to hand the
  // renderer real File objects backed by disk paths.
  await ev(`(() => {
    const i = document.createElement('input')
    i.type = 'file'; i.id = '__drop_probe'; i.multiple = true
    i.style.position = 'fixed'; i.style.left = '-9999px'
    document.body.appendChild(i)
    return 'ok'
  })()`)
  const doc = await send('DOM.getDocument', { depth: -1 })
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__drop_probe' })
  const tFile = Date.now()
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [clipA, srtA] })
  note('setFileInputFiles', `${((Date.now() - tFile) / 1000).toFixed(1)}s`)
  await delay(300)

  const hasPathProp = await ev(`'path' in document.getElementById('__drop_probe').files[0]`)
  record('Electron no longer exposes File.path (the original bug)', hasPathProp === false, `has path: ${hasPathProp}`)

  const resolved = JSON.parse(
    await ev(`JSON.stringify(window.streamer.getPathsForFiles([...document.getElementById('__drop_probe').files]))`)
  )
  record('the bridge resolves dropped files to real paths', resolved.length === 2 && resolved[0] === clipA, resolved.join(' , '))
  await ev(`document.getElementById('__drop_probe')?.remove()`)

  // The playlist pipeline must ignore the subtitle that arrived in the same drop.
  const beforeCount = await ev('document.querySelectorAll(".playlist-item").length')
  note('addItems starting', `before=${beforeCount}`)
  const addStart = Date.now()
  await ev(`window.streamer.addItems(${JSON.stringify([clipA, srtA])})`)
  note('addItems returned', `${((Date.now() - addStart) / 1000).toFixed(1)}s`)
  const added = await waitFor(
    'playlist to grow by exactly the video file',
    async () => (await ev('document.querySelectorAll(".playlist-item").length')) === beforeCount + 1,
    15000
  )
  record('a drop with a subtitle file adds only the video', added.ok, `${beforeCount} → ${await ev('document.querySelectorAll(".playlist-item").length')} items`)
  const logs = JSON.parse(await ev('window.streamer.getLogs().then(l => JSON.stringify(l))'))
  record('the ignored non-video file is mentioned in the log', logs.some((l) => l.message.includes('非视频文件')), 'log line checked')
  end()
}

/* ================= 2. stream key masking + no target display ================= */
{
  const end = phase('stream key masking')
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('输出'))
    tab?.click()
    return 'ok'
  })()`)
  const shown = await waitFor('the stream key field to render', async () =>
    ev(`!![...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥'))`)
  , 8000)
  if (!shown.ok) bail('the stream key field never rendered')

  const info = await ev(`(() => {
    const field = [...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥'))
    const input = field?.querySelector('input')
    const toggle = field?.querySelector('.secret-toggle')
    return JSON.stringify({ type: input?.type, hasToggle: !!toggle, toggleText: toggle?.textContent?.trim() })
  })()`)
  const key = JSON.parse(info)
  record('the stream key input is type=password', key.type === 'password', key.type)
  record('the stream key field has a reveal toggle', key.hasToggle, key.toggleText)

  // React re-renders asynchronously, so the click and the type check are
  // separate CDP round-trips with a short wait between them.
  const keyFieldExpr = `(() => {
    const field = [...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥'))
    return JSON.stringify({ type: field.querySelector('input').type })
  })()`
  await ev(`[...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥')).querySelector('.secret-toggle').click()`)
  await delay(250)
  const revealed = JSON.parse(await ev(keyFieldExpr))
  await ev(`[...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥')).querySelector('.secret-toggle').click()`)
  await delay(250)
  const backTo = JSON.parse(await ev(keyFieldExpr))
  record('the toggle reveals and re-masks the key', revealed.type === 'text' && backTo.type === 'password', `revealed=${revealed.type} backTo=${backTo.type}`)

  const keyInput = await ev(`(() => {
    const field = [...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥'))
    return field.querySelector('input').value
  })()`)
  record('the saved key is loaded into the masked field', keyInput === 'lock-test-key', keyInput)

  record('the UI shows no composed push target', (await ev(`!!document.querySelector('.rtmp-target')`)) === false)

  // UI polish regressions: the password input shares the dark theme, number
  // inputs hide their native spinner (selects keep the dropdown arrow), and
  // tune defaults to "unset" (AMF + zerolatency is incompatible with some
  // streaming servers, so it must be opt-in).
  const pwdBg = await ev(`(() => {
    const keyField = [...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('串流密钥'))
    return getComputedStyle(keyField.querySelector('input')).backgroundColor
  })()`)
  record('the password input uses the dark input background', pwdBg === 'rgb(11, 16, 23)', pwdBg)

  await ev(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('视频编码'))?.click()`)
  await delay(350)
  // Chromium's getComputedStyle cannot observe the spinner pseudo-element, so
  // verify the stylesheet carries the hiding rule instead (visual effect is
  // confirmed by screenshot inspection).
  const spinnerRule = await ev(`(() => {
    for (const sheet of document.styleSheets) {
      let rules
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of rules) {
        if (rule.selectorText && rule.selectorText.includes('inner-spin-button') && rule.style && rule.style.webkitAppearance === 'none') return true
      }
    }
    return false
  })()`)
  record('number inputs hide the native spinner', spinnerRule === true, spinnerRule)
  record('tune defaults to unset', (await ev('window.streamer.getSettings().then(s => s.session.video.tune)')) === '')
  const tuneSelect = await ev(`(() => {
    const field = [...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim() === 'tune')
    return field ? field.querySelector('select').value : 'no-field'
  })()`)
  record('the tune select renders with no value selected', tuneSelect === '', tuneSelect)

  const storedRaw = fs.readFileSync(SETTINGS_FILE, 'utf8')
  const stored = JSON.parse(storedRaw)
  record('the key is still stored in plain text on disk', stored.session?.output?.streamKey === 'lock-test-key', stored.session?.output?.streamKey)
  end()
}

/* ================= 3. field alignment ================= */
{
  const end = phase('field alignment')
  const TABS = ['视频编码', '音频编码', '字幕', '输出', '高级']
  const problems = []
  const details = []
  for (const tab of TABS) {
    await ev(`(() => {
      const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(${JSON.stringify(tab)}))
      t?.click()
      return 'ok'
    })()`)
    await delay(350)
    const report = JSON.parse(
      await ev(`(() => {
        // Compound widgets (the resolution block) carry an extra toggle row and
        // are their own layout unit; the alignment rule applies to plain
        // "label -> control -> hint" fields sharing a grid row.
        const grids = [...document.querySelectorAll('.settings-body .field-grid')]
        const problems = []
        const shape = (field) => {
          if (field.querySelector(':scope > .res-inputs')) return 'compound'
          if (field.querySelector(':scope > .unit-input')) return field.querySelector(':scope > .unit-input')
          if (field.querySelector(':scope > .color-row')) return field.querySelector(':scope > .color-row')
          return field.querySelector(':scope > input, :scope > select')
        }
        for (const grid of grids) {
          const rows = new Map()
          for (const field of grid.querySelectorAll('.field')) {
            const control = shape(field)
            if (!control || control === 'compound') continue
            const top = Math.round(field.getBoundingClientRect().top)
            if (!rows.has(top)) rows.set(top, [])
            rows.get(top).push(Math.round(control.getBoundingClientRect().top - top))
          }
          for (const [top, offsets] of rows) {
            if (offsets.length > 1 && Math.max(...offsets) - Math.min(...offsets) > 2) {
              problems.push('misaligned-row@' + top + '(' + offsets.join('/') + ')')
            }
          }
          // The hint must sit below its control, never beside or above it.
          for (const field of grid.querySelectorAll('.field')) {
            const control = shape(field)
            if (!control || control === 'compound') continue
            const hint = field.querySelector(':scope > .field-hint')
            if (hint && hint.getBoundingClientRect().top < control.getBoundingClientRect().bottom - 2) {
              problems.push('hint-above@' + (field.querySelector('.field-label')?.textContent ?? '').trim().slice(0, 12))
            }
          }
        }
        return JSON.stringify(problems)
      })()`)
    )
    if (report.length > 0) problems.push(`${tab}: ${report.join(', ')}`)
    details.push(`${tab}=${report.length === 0 ? 'ok' : report.join(',')}`)
  }
  record('controls line up on every tab and hints stay below', problems.length === 0, problems.join(' ; ') || details.join(' | '))
  end()
}

/* ================= 4. lock while streaming / unlock after ================= */
const RECEIVED = path.join(here, 'features_received.flv')
{
  const end = phase('stream lock/unlock')
  fs.rmSync(RECEIVED, { force: true })
  const listener = spawn(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${STREAM_PORT}/live/lock-test-key`, '-c', 'copy', '-f', 'flv', '-y', RECEIVED],
    { windowsHide: true }
  )
  let listenerErr = ''
  listener.stderr.on('data', (d) => (listenerErr += d.toString()))
  await delay(1200)

  record('start button clickable', (await ev(`(() => {
    const b = [...document.querySelectorAll('.player-controls button')].find(x => x.textContent.includes('开始串流'))
    b?.click()
    return b ? 'clicked' : 'missing'
  })()`)) === 'clicked')

  const running = await waitFor(
    'engine to reach the live state',
    async () => (await ev('window.streamer.getStatus().then(s => s.state)')) === 'live',
    25000
  )
  record('engine reached the live state', running.ok, running.value || 'no state')
  if (!running.ok) {
    listener.kill('SIGKILL')
    bail('engine never reached live; cannot verify the lock')
  }
  await delay(1500)

  record('a lock notice is shown', await ev(`!!document.querySelector('.lock-note')`))
  record('the settings body is inert', await ev(`document.querySelector('.settings-body').hasAttribute('inert')`))
  const lockedControls = await ev(`(() => {
    const presetSelect = document.querySelector('.preset-select')
    const clearBtn = [...document.querySelectorAll('.panel-head-actions button')].find(b => b.textContent.trim() === '清空')
    const itemBtns = [...document.querySelectorAll('.pi-actions button')]
    return JSON.stringify({
      presetDisabled: presetSelect?.disabled,
      savePresetDisabled: [...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.includes('保存为预设'))?.disabled,
      clearDisabled: clearBtn?.disabled,
      allItemActionsDisabled: itemBtns.length > 0 && itemBtns.filter(b => b.textContent.trim() !== '▶ 从此开始').every(b => b.disabled)
    })
  })()`)
  const lock = JSON.parse(lockedControls)
  record('preset select is disabled while streaming', lock.presetDisabled === true, lockedControls)
  record('playlist mutating buttons are disabled while streaming', lock.clearDisabled === true && lock.allItemActionsDisabled === true, lockedControls)

  // A programmatic edit must not reach the settings model either.
  const beforeBitrate = await ev('window.streamer.getSettings().then(s => s.session.video.bitrateKbps)')
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('视频编码'))
    tab?.click()
    return 'ok'
  })()`)
  await delay(300)
  await ev(`(() => {
    const field = [...document.querySelectorAll('.settings-body .field')].find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith('视频码率'))
    const input = field.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '9999')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await delay(800)
  const afterBitrate = await ev('window.streamer.getSettings().then(s => s.session.video.bitrateKbps)')
  record('a locked edit never reaches the settings model', afterBitrate === beforeBitrate, `${beforeBitrate} → ${afterBitrate}`)

  // The stream key never appears outside the debug log, but it IS there.
  const logs = JSON.parse(await ev('window.streamer.getLogs().then(l => JSON.stringify(l))'))
  record(
    'the debug log carries the composed push target',
    logs.some((l) => l.level === 'debug' && l.message.includes(`rtmp://127.0.0.1:${STREAM_PORT}/live/lock-test-key`)),
    'log searched'
  )

  await delay(2500) // let some data flow
  record('stop button clickable', (await ev(`(() => {
    const b = [...document.querySelectorAll('.player-controls button')].find(x => x.textContent.trim() === '⏹ 停止')
    b?.click()
    return b ? 'clicked' : 'missing'
  })()`)) === 'clicked')
  const idle = await waitFor(
    'session to return to idle',
    async () => (await ev('window.streamer.getStatus().then(s => s.state)')) === 'idle',
    20000
  )
  record('session returned to idle', idle.ok, `${idle.waitedMs}ms`)
  listener.kill('SIGKILL')
  await delay(800)

  const unlocked = await ev(`(() => {
    const presetSelect = document.querySelector('.preset-select')
    const clearBtn = [...document.querySelectorAll('.panel-head-actions button')].find(b => b.textContent.trim() === '清空')
    return JSON.stringify({ inert: document.querySelector('.settings-body').hasAttribute('inert'), presetDisabled: presetSelect?.disabled, clearDisabled: clearBtn?.disabled })
  })()`)
  const un = JSON.parse(unlocked)
  record('settings unlock after the session ends', un.inert === false && un.presetDisabled === false && un.clearDisabled === false, unlocked)
  record('no lock notice after the session ends', (await ev(`!!document.querySelector('.lock-note')`)) === false)

  // The pushed stream must contain real video, not just audio.
  const size = fs.existsSync(RECEIVED) ? fs.statSync(RECEIVED).size : 0
  record('the ingest received the pushed stream', size > 50000, `${(size / 1024).toFixed(0)} KB${listenerErr ? `; ${listenerErr.split(/\r?\n/)[0]}` : ''}`)
  if (size > 0) {
    const probe = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', RECEIVED], { encoding: 'utf8', timeout: 30000 })
    try {
      const parsed = JSON.parse(probe.stdout)
      const vs = parsed.streams.find((s) => s.codec_type === 'video')
      const as = parsed.streams.find((s) => s.codec_type === 'audio')
      record('received stream has decodable video AND audio', Boolean(vs) && Boolean(as), `video=${vs?.codec_name} ${vs?.width}x${vs?.height} audio=${as?.codec_name}`)
    } catch (err) {
      record('received stream has decodable video AND audio', false, String(err))
    }
  }
  end()
}

/* ================= 5. connection test with an empty key ================= */
{
  const end = phase('connection test with an empty key')
  const testReceived = path.join(here, 'features_test_received.flv')
  fs.rmSync(testReceived, { force: true })
  const listener = spawn(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${TEST_PORT}/live`, '-c', 'copy', '-f', 'flv', '-y', testReceived],
    { windowsHide: true }
  )
  await delay(1200)
  const res = JSON.parse(
    await ev(`window.streamer.testRtmp({ url: 'rtmp://127.0.0.1:${TEST_PORT}/live', streamKey: '', timeoutSec: 15 }).then(r => JSON.stringify(r))`)
  )
  record('the connection test accepts an empty stream key', res.ok === true, res.message)
  listener.kill('SIGKILL')
  await delay(500)
  const size = fs.existsSync(testReceived) ? fs.statSync(testReceived).size : 0
  record('the keyless test stream reached the ingest', size > 10000, `${(size / 1024).toFixed(0)} KB`)
  fs.rmSync(testReceived, { force: true })
  end()
}

/* ========= 5b. the connection test uses the configured encoding settings =========
 *
 * The test button used to push its own hardcoded recipe (128k/44100/stereo AAC,
 * libx264 ultrafast 1000k), so a server that rejected the real stream could still
 * answer "连接成功" — and vice versa. It must now exercise the session's encoders,
 * and the panel must say what it pushed.
 */
{
  const end = phase('connection test honours the encoding settings')
  const changed = JSON.parse(
    await ev(`window.streamer.saveSettings({ session: { audio: { codec: 'aac', rateControl: 'cbr', bitrateKbps: 96, sampleRate: 22050, channels: 1, loudnorm: true }, video: { fps: 25, scale: '1280:720', scaleWidth: 1280, scaleHeight: 720, scaleAuto: false } } }).then(s => JSON.stringify(s.session))`)
  )
  record(
    'the test scenario was written to settings',
    changed.audio.sampleRate === 22050 && changed.audio.channels === 1 && changed.video.fps === 25,
    `audio=${changed.audio.codec} ${changed.audio.sampleRate}Hz ${changed.audio.channels}ch loudnorm=${changed.audio.loudnorm}, video ${changed.video.scale}@${changed.video.fps}`
  )

  // Reload so the renderer holds this session: with the field removed from the
  // request the main process would fall back to these persisted settings and the
  // "settings travel with the request" half of the fix would go untested.
  await send('Page.enable')
  await send('Page.reload')
  await waitFor('the renderer to come back', () => ev(`!!window.streamer`), 20000)
  await delay(1200)

  const cap = path.join(here, 'features_test_settings.flv')
  fs.rmSync(cap, { force: true })
  const listener = spawn(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${TEST_PORT}/live`, '-c', 'copy', '-f', 'flv', '-y', cap],
    { windowsHide: true }
  )
  await delay(1200)
  const result = JSON.parse(
    await ev(`window.streamer.testRtmp({ url: 'rtmp://127.0.0.1:${TEST_PORT}/live', streamKey: '', timeoutSec: 25 }).then(r => JSON.stringify(r))`)
  )
  listener.kill('SIGKILL')
  await delay(700)

  record('the test with configured settings succeeds', result.ok === true, result.message)
  const summary = String((result.summary ?? []).join(' · '))
  record(
    'the test reports the settings it used',
    summary.includes('22050') && summary.includes('单声道') && summary.includes('96kbps') && summary.includes('1280x720') && summary.includes('25fps'),
    summary || '(no summary)'
  )

  const size = fs.existsSync(cap) ? fs.statSync(cap).size : 0
  record('the configured-settings test stream reached the ingest', size > 50000, `${(size / 1024).toFixed(0)} KB`)
  if (size > 0) {
    const probe = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', cap], { encoding: 'utf8', timeout: 30000 })
    try {
      const parsed = JSON.parse(probe.stdout)
      const vs = parsed.streams.find((s) => s.codec_type === 'video')
      const as = parsed.streams.find((s) => s.codec_type === 'audio')
      record(
        'the received test audio uses the configured sample rate and channel count',
        as?.sample_rate === '22050' && as?.channels === 1,
        as ? `${as.codec_name} ${as.sample_rate}Hz ${as.channels}ch` : 'no audio stream'
      )
      record(
        'the received test video uses the configured resolution and frame rate',
        vs?.width === 1280 && vs?.height === 720 && vs?.avg_frame_rate === '25/1',
        vs ? `${vs.codec_name} ${vs.width}x${vs.height} @${vs.avg_frame_rate}` : 'no video stream'
      )
    } catch (err) {
      record('the received test audio uses the configured sample rate and channel count', false, String(err))
    }
  }
  fs.rmSync(cap, { force: true })

  /*
   * And through the real button, so the wiring (renderer -> preload -> IPC) is
   * covered too: the panel must render the result and name the parameters behind it.
   */
  const panel = path.join(here, 'features_test_panel.flv')
  fs.rmSync(panel, { force: true })
  const panelListener = spawn(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${TEST_PORT}/live`, '-c', 'copy', '-f', 'flv', '-y', panel],
    { windowsHide: true }
  )
  await delay(1200)
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tabs .tab')].find(b => b.textContent.includes('输出'))
    tab.click()
    return 'ok'
  })()`)
  await delay(400)
  await ev(`(() => {
    const el = document.querySelector('input[placeholder="rtmp://127.0.0.1/live/"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, 'rtmp://127.0.0.1:${TEST_PORT}/live/')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await delay(500)
  await ev(`(() => {
    const btn = [...document.querySelectorAll('.row-actions button')].find(b => b.textContent.includes('测试连接'))
    btn.click()
    return 'ok'
  })()`)
  const painted = await waitFor('the test result panel', () => ev(`!!document.querySelector('.test-result')`), 45000, 500)
  const text = painted.ok ? await ev(`document.querySelector('.test-result').textContent`) : ''
  record('the connection test result is rendered in the output tab', painted.ok && String(text).includes('连接成功'), String(text).slice(0, 80))
  record(
    'the panel names the parameters the test pushed',
    String(text).includes('22050') && String(text).includes('单声道'),
    String(text).replace(/\s+/g, ' ').slice(0, 160)
  )
  panelListener.kill('SIGKILL')
  await delay(500)
  const panelSize = fs.existsSync(panel) ? fs.statSync(panel).size : 0
  record('the button-driven test pushed a stream', panelSize > 50000, `${(panelSize / 1024).toFixed(0)} KB`)
  fs.rmSync(panel, { force: true })
  end()
}

/* ================= 6. persisted logging + rotation ================= */
{
  const end = phase('persisted logging')
  const info = JSON.parse(await ev('window.streamer.getLogFileInfo().then(i => JSON.stringify(i))'))
  record('log info points inside Data/Logs', path.resolve(info.dir) === path.resolve(LOGS_DIR), info.dir)
  record('the session log file exists', fs.existsSync(info.currentFile), info.currentFile)
  record('the log has content', info.totalBytes > 500, `${info.totalBytes} bytes`)
  record('the size budget is 12 MB', info.budgetBytes === 12 * 1024 * 1024, `${(info.budgetBytes / 1024 / 1024).toFixed(0)} MB`)

  // The engine's diagnostic lines (stream inventory) must be in the log.
  const logs = JSON.parse(await ev('window.streamer.getLogs().then(l => JSON.stringify(l))'))
  record('the log contains a stream inventory line', logs.some((l) => l.message.includes('流信息')), 'log searched')
  record('the log names the selected video stream', logs.some((l) => l.message.includes('选用视频流')), 'log searched')

  // Quit gracefully so closeLogSession runs, then plant oversized fake sessions
  // and relaunch: rotation must delete the oldest until the folder fits 12 MB.
  await ev(`(() => { window.close(); return 'ok' })()`)
  await waitFor('app to exit', async () => appProc.exitCode !== null || appProc.killed, 10000)
  try {
    appProc.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await delay(800)

  const ended = fs.readdirSync(LOGS_DIR).some((f) => {
    if (!f.endsWith('.log')) return false
    return fs.readFileSync(path.join(LOGS_DIR, f), 'utf8').includes('# ended')
  })
  record('the first session log is closed cleanly', ended, 'looked for the # ended marker')

  const fake1 = path.join(LOGS_DIR, 'session-20200101-000001.log')
  const fake2 = path.join(LOGS_DIR, 'session-20200101-000002.log')
  const fake3 = path.join(LOGS_DIR, 'session-20200101-000003.log')
  for (const [f, mb] of [
    [fake1, 5],
    [fake2, 5],
    [fake3, 5]
  ]) {
    fs.writeFileSync(f, Buffer.alloc(mb * 1024 * 1024, 0x78))
    const t = new Date('2020-01-01T00:00:00')
    fs.utimesSync(f, t, t)
  }

  const second = spawn(electron, ['.', '--lang=zh-CN', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
    cwd: root,
    env: appEnv
  })
  const target2 = await waitForTarget(30000)
  if (!target2) {
    console.error('FATAL: app did not relaunch')
    second.kill('SIGKILL')
    disarm()
    process.exit(1)
  }
  // Re-wire the CDP scaffolding to the new page.
  const ws2 = new WebSocket(target2.webSocketDebuggerUrl)
  await new Promise((r, reject) => {
    ws2.addEventListener('open', r, { once: true })
    const t = setTimeout(() => reject(new Error('CDP websocket never opened (relaunch)')), 15000)
    ws2.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP websocket error (relaunch)')) }, { once: true })
  })
  const pending2 = new Map()
  let id2 = 0
  ws2.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending2.has(m.id)) {
      pending2.get(m.id)(m.result)
      pending2.delete(m.id)
    }
  })
  const send2 = (method, params = {}) =>
    new Promise((r, reject) => {
      const i = ++id2
      const timer = setTimeout(() => {
        pending2.delete(i)
        reject(new Error(`CDP ${method} timed out after 30s`))
      }, 30000)
      pending2.set(i, (result) => {
        clearTimeout(timer)
        r(result)
      })
      ws2.send(JSON.stringify({ id: i, method, params }))
    })
  const ev2 = async (expr) => {
    const r = await send2('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const booted2 = await waitFor('the relaunched app to boot', async () => {
    try {
      return await ev2('!!document.querySelector(".settings-body")')
    } catch {
      return false
    }
  }, 25000)
  record('the app relaunches', booted2.ok)
  if (booted2.ok) {
    const info2 = JSON.parse(await ev2('window.streamer.getLogFileInfo().then(i => JSON.stringify(i))'))
    record('rotation deleted the oldest oversized log', !fs.existsSync(fake1) && fs.existsSync(fake2) && fs.existsSync(fake3), `remaining on disk: ${fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log')).join(', ') || '(none)'}`)
    record('the folder stays within its budget after rotation', info2.totalBytes <= info2.budgetBytes, `${(info2.totalBytes / 1024 / 1024).toFixed(1)} MB of ${(info2.budgetBytes / 1024 / 1024).toFixed(0)} MB`)
    record('a new session file was opened', info2.currentFile !== info.currentFile, info2.currentFile)
  }
  // Remove the planted fakes so the run leaves no junk behind.
  for (const f of [fake2, fake3]) fs.rmSync(f, { force: true })
  ws2.close()
  second.kill('SIGKILL')
  end()
}

/* ---------------- summary ---------------- */
record('no uncaught renderer exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none')

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} feature checks passed`)
disarm()

try {
  ws.close()
} catch {
  /* ignore */
}
try {
  appProc.kill('SIGKILL')
} catch {
  /* ignore */
}
await delay(600)
fs.writeFileSync(path.join(here, 'features-e2e-report.json'), JSON.stringify({ results }, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
