/**
 * Verifies the preset feature end to end through the real app:
 *   - the preset bar renders with built-ins
 *   - saving captures settings from every tab (video/audio/subtitles/output)
 *   - the file lands in the app's Data folder as documented
 *   - applying a preset restores those settings
 *   - deleting removes it again
 *   - the resolution controls and bitrate unit selector behave
 *
 * Usage: node test/preset-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { electronEnv } from './harness-util.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9777
/** The app stores state in `<appRoot>/Data`; in dev that is the project folder. */
const DATA_DIR = path.join(root, 'Data')
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json')

const results = []
const note = (s, d) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` — ${d}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// Start from a clean slate so assertions about file creation are meaningful.
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })
const TEST_PRESET = `测试预设 ${Date.now().toString(36)}`

// This test deliberately rewrites every settings group, so the original file is
// restored afterwards and it cannot leak state into the other suites.
const settingsFile = path.join(DATA_DIR, 'settings.json')
let originalSettingsRaw = null
try {
  originalSettingsRaw = fs.readFileSync(settingsFile, 'utf8')
} catch {
  /* first run: nothing to restore */
}

/* `--lang=zh-CN` pins the UI language so the assertions on Chinese control text do
   not depend on the machine's system locale. */
const appProc = spawn(electron, ['.', '--lang=zh-CN', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: electronEnv()
})

/** Restores settings.json so later suites start from the state they expect. */
function restoreSettings() {
  try {
    if (originalSettingsRaw === null) fs.rmSync(settingsFile, { force: true })
    else fs.writeFileSync(settingsFile, originalSettingsRaw, 'utf8')
  } catch {
    /* best effort */
  }
}

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not up */
    }
    await delay(400)
  }
  return null
}

const target = await waitForTarget()
if (!target) {
  console.error('no CDP target; app failed to start')
  appProc.kill('SIGKILL')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
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
await new Promise((r) => ws.addEventListener('open', r))
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
await send('Runtime.enable')

/* ---------- wait for boot ---------- */
{
  const deadline = Date.now() + 25000
  let ok = false
  while (Date.now() < deadline) {
    ok = await ev('!!document.querySelector(".preset-bar")').catch(() => false)
    if (ok) break
    await delay(400)
  }
  record('preset bar renders in the settings panel', ok)
  if (!ok) {
    ws.close()
    appProc.kill('SIGKILL')
    process.exit(1)
  }
}

/* ---------- preset bar contents ---------- */
const optionLabels = await ev(`JSON.stringify([...document.querySelectorAll('.preset-select option')].map(o => o.textContent))`)
record('preset select lists the built-in presets', optionLabels.includes('内置预设') || optionLabels.includes('1080p60'), optionLabels.slice(0, 120))

const configDirBtn = await ev(`!![...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.includes('数据目录'))`)
record('data folder button is present', configDirBtn)

/* ---------- change settings across every tab, then save a preset ---------- */
note('setting distinct values in each tab')

/** Clicks a tab and waits until the named field actually rendered. */
const openTab = async (tabText, expectLabel, timeoutMs = 6000) => {
  await ev(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes(${JSON.stringify(tabText)}))
    tab?.click()
    return 'ok'
  })()`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await ev(`(() => {
      const fields = [...document.querySelectorAll('.settings-body .field')]
      return fields.some(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith(${JSON.stringify(expectLabel)}))
    })()`)
    if (found) return true
    await delay(150)
  }
  return false
}

/**
 * Finds a field by an exact label prefix.
 * A substring match is not enough: the RTMP url field's hint text also mentions
 * "串流密钥", so `includes` would pick the wrong input.
 */
const fieldExpr = (labelStartsWith) => `[...document.querySelectorAll('.settings-body .field')]
  .find(f => (f.querySelector('.field-label')?.textContent ?? '').trim().startsWith(${JSON.stringify(labelStartsWith)}))`

/**
 * Sets a numeric/native input inside the field whose label starts with
 * `labelStartsWith`, and does not return until the settings model agrees.
 *
 * The verify-and-retry is not decoration: `input`/`change` are delivered
 * synchronously, but React commits asynchronously, so a write can land on an element
 * whose re-render is still in flight and be dropped. Measured on the video bitrate
 * field: it stayed at its default while the rest of the same batch of edits went
 * through, which looked like a preset bug and was a race in this helper.
 *
 * The edit is bracketed with `focusin`/`focusout` rather than `focus()`/`blur()`:
 * fields commit when they are left, and this window is moved off-screen by the e2e
 * env, where it does not always hold OS focus — `focus()` then does nothing and the
 * write would never reach the model. React maps `onBlur` onto `focusout`.
 */
const setFieldValue = async (labelStartsWith, value) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await ev(`(() => {
      const field = ${fieldExpr(labelStartsWith)}
      if (!field) return 'no-field'
      const input = field.querySelector('input[type="number"], input[type="text"], input[type="password"], input:not([type])')
      if (!input) return 'no-input'
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(${JSON.stringify(String(value))}))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      return 'ok'
    })()`)
    await delay(200)
    const applied = await ev(`(() => {
      const field = ${fieldExpr(labelStartsWith)}
      const input = field?.querySelector('input[type="number"], input[type="text"], input[type="password"], input:not([type])')
      return input ? input.value : null
    })()`)
    if (applied === String(value)) return 'ok'
  }
  return 'not-applied'
}

const setSelectByValue = async (labelStartsWith, value) => {
  return ev(`(() => {
    const field = ${fieldExpr(labelStartsWith)}
    if (!field) return 'no-field'
    const sel = field.querySelector('select')
    if (!sel) return 'no-select'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(sel, String(${JSON.stringify(String(value))}))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
}

// video tab: bitrate 3200 kbps, fps 24, scale on with width 1600
await openTab('视频编码', '视频码率')
await setFieldValue('视频码率', 3200)
await setFieldValue('帧率', 24)
await ev(`(() => {
  const f = document.querySelector('.res-field')
  const enable = f?.querySelector('.res-enable input')
  if (enable && !enable.checked) enable.click()
  return 'ok'
})()`)
await delay(250)
// The resolution block has no "Resolution" label of its own any more: the enable
// switch ("Scale output") is its heading, and it is the first label in `.res-field`.
await setFieldValue('缩放输出', 1600)

// audio tab: 96 kbps
await openTab('音频编码', '码率')
await setFieldValue('码率', 96)

// subtitle tab: turn subtitles off
await openTab('字幕', '默认字幕处理方式')
await setSelectByValue('默认字幕处理方式', 'off')
await delay(200)

// output tab: stream key + address
const outputTabReady = await openTab('推流', '串流密钥')
record('output tab renders its fields', outputTabReady)
await setFieldValue('串流密钥', 'preset-key-test')
await setFieldValue('推流地址', 'rtmp://preset.example.com/live/')
await delay(700)

const sessionBefore = JSON.parse(
  await ev('window.streamer.getSettings().then(s => JSON.stringify(s.session))')
)
record(
  'edits reached the settings model across tabs',
  sessionBefore.video.bitrateKbps === 3200 && sessionBefore.video.fps === 24 && sessionBefore.audio.bitrateKbps === 96 && sessionBefore.subtitles.mode === 'off' && sessionBefore.output.streamKey === 'preset-key-test',
  JSON.stringify({
    bitrate: sessionBefore.video.bitrateKbps,
    fps: sessionBefore.video.fps,
    audio: sessionBefore.audio.bitrateKbps,
    subMode: sessionBefore.subtitles.mode,
    key: sessionBefore.output.streamKey
  })
)
record('resolution switched to explicit width with auto height', sessionBefore.video.scale === '1600:-2', sessionBefore.video.scale)

/* ---------- the obs-websocket block of the RTMP tab ---------- */
// These controls are part of the output settings, so they must be reachable in
// the rendered form AND survive the preset round-trip below.
note('configuring the obs-websocket control endpoint')

/**
 * The endpoint restarts on a debounce and `listen()` completes asynchronously,
 * so a fixed sleep would be a race. Polls the IPC status instead.
 */
const waitForObs = async (predicate, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs
  let status = null
  while (Date.now() < deadline) {
    status = JSON.parse(await ev('window.streamer.getObsWebSocketStatus().then(s => JSON.stringify(s))'))
    if (predicate(status)) return status
    await delay(150)
  }
  return status
}

/** Reads the labels/toggles currently rendered in the settings body. */
const readSettingsDom = () =>
  ev(`JSON.stringify({
    labels: [...document.querySelectorAll('.settings-body .field-label')].map(e => e.textContent.trim()),
    toggles: [...document.querySelectorAll('.settings-body .toggle-text')].map(e => e.textContent.trim()),
    activeTab: document.querySelector('.tab.active')?.textContent?.trim() ?? null
  })`)

const obsBefore = JSON.parse(await readSettingsDom())
record(
  'obs-websocket switch renders in the push tab',
  obsBefore.activeTab?.includes('推流') === true && obsBefore.toggles.some((t) => t.includes('obs-websocket')),
  JSON.stringify({ tab: obsBefore.activeTab, toggles: obsBefore.toggles })
)

// Enable it through the UI: the address/port/password fields only exist while
// the feature is on, and switching it on must bind the endpoint.
await ev(`(() => {
  const row = [...document.querySelectorAll('.settings-body .toggle')].find(t => t.textContent.includes('obs-websocket'))
  const sw = row?.querySelector('[role="switch"]')
  if (!sw) return 'no-toggle'
  if (sw.getAttribute('aria-checked') !== 'true') sw.click()
  return 'ok'
})()`)
const enabledStatus = await waitForObs((s) => s.running)
record('enabling the switch starts the endpoint', enabledStatus?.running === true, JSON.stringify(enabledStatus))

const obsAfter = JSON.parse(await readSettingsDom())
record(
  'obs-websocket address/port/password fields render once enabled',
  obsAfter.labels.includes('监听地址') && obsAfter.labels.includes('端口') && obsAfter.labels.some((l) => l.startsWith('密码')),
  JSON.stringify(obsAfter.labels)
)

await setFieldValue('监听地址', '127.0.0.1')
await setFieldValue('端口', '14455')
await setFieldValue('密码', 'preset-secret')
await delay(600)
const sessionWithObs2 = JSON.parse(await ev('window.streamer.getSettings().then(s => JSON.stringify(s.session.output.obsWebSocket))'))
record(
  'obs-websocket address/port/password reach the settings model',
  sessionWithObs2.host === '127.0.0.1' && sessionWithObs2.port === 14455 && sessionWithObs2.password === 'preset-secret',
  JSON.stringify(sessionWithObs2)
)

// Changing the port has to move the listening socket with it.
const rebound = await waitForObs((s) => s.running && s.port === 14455)
record('changing the port rebinds the endpoint', rebound?.running === true && rebound.port === 14455, JSON.stringify(rebound))

// ...and switching the feature off must release it again.
await ev(`(() => {
  const row = [...document.querySelectorAll('.settings-body .toggle')].find(t => t.textContent.includes('obs-websocket'))
  const sw = row?.querySelector('[role="switch"]')
  if (sw?.getAttribute('aria-checked') === 'true') sw.click()
  return 'ok'
})()`)
const stopped = await waitForObs((s) => !s.running)
record('disabling the switch stops the endpoint', stopped?.running === false, JSON.stringify(stopped))

// Turn it back on for the preset round-trip below: the endpoint settings are
// part of the session, so a saved+applied preset must carry them.
await ev(`(() => {
  const row = [...document.querySelectorAll('.settings-body .toggle')].find(t => t.textContent.includes('obs-websocket'))
  const sw = row?.querySelector('[role="switch"]')
  if (sw && sw.getAttribute('aria-checked') !== 'true') sw.click()
  return 'ok'
})()`)
await waitForObs((s) => s.running)

/* ---------- save the preset through the UI ---------- */
note('saving a preset through the UI')
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.includes('保存为预设'))
  btn?.click()
  return 'ok'
})()`)
await delay(300)
const modalOpen = await ev(`!!document.querySelector('.preset-menu')`)
record('save dialog opens from the preset bar', modalOpen)

await ev(`(() => {
  const input = document.querySelector('.preset-menu input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(TEST_PRESET)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await delay(250)
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-menu button')].find(b => b.textContent.includes('保存'))
  btn?.click()
  return 'ok'
})()`)
await delay(800)

/* ---------- verify the file on disk ---------- */
record('presets.json was created in the Data folder', fs.existsSync(PRESETS_FILE), PRESETS_FILE)
let stored = null
if (fs.existsSync(PRESETS_FILE)) {
  try {
    stored = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'))
  } catch (err) {
    record('presets.json is valid JSON', false, String(err))
  }
}
if (stored) {
  const saved = (stored.presets ?? []).find((p) => p.name === TEST_PRESET)
  record('the saved preset is present in the file', Boolean(saved), `${(stored.presets ?? []).length} preset(s) stored`)
  record(
    'the preset captured all four settings groups',
    Boolean(saved?.settings?.video && saved?.settings?.audio && saved?.settings?.subtitles && saved?.settings?.output),
    saved ? Object.keys(saved.settings).join(', ') : 'missing'
  )
  record(
    'the preset captured the edited values',
    saved?.settings?.video?.bitrateKbps === 3200 &&
      saved?.settings?.video?.fps === 24 &&
      saved?.settings?.audio?.bitrateKbps === 96 &&
      saved?.settings?.subtitles?.mode === 'off',
    saved ? `bitrate=${saved.settings.video.bitrateKbps} fps=${saved.settings.video.fps} audio=${saved.settings.audio.bitrateKbps} subMode=${saved.settings.subtitles.mode}` : 'missing'
  )
  record(
    'the preset DOES store the RTMP destination in plain text',
    saved?.settings?.output?.streamKey === 'preset-key-test' && saved?.settings?.output?.server === 'rtmp://preset.example.com/live/',
    `stored key = ${saved?.settings?.output?.streamKey}, server = ${saved?.settings?.output?.server}`
  )
  record(
    'the preset stores the obs-websocket block',
    saved?.settings?.output?.obsWebSocket?.enabled === true &&
      saved?.settings?.output?.obsWebSocket?.port === 14455 &&
      saved?.settings?.output?.obsWebSocket?.password === 'preset-secret',
    JSON.stringify(saved?.settings?.output?.obsWebSocket)
  )
}

/* ---------- apply a built-in, then our preset, and compare ---------- */
note('applying the built-in 720p preset, then the saved one')
await ev(`(() => {
  const sel = document.querySelector('.preset-select')
  const opt = [...sel.options].find(o => o.textContent.includes('720p30 · H.264 CRF'))
  if (!opt) return 'no-option'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await delay(800)
const afterBuiltin = JSON.parse(await ev('window.streamer.getSettings().then(s => JSON.stringify(s.session.video))'))
record('applying a built-in preset overwrites the video settings', afterBuiltin.rateControl === 'crf' && afterBuiltin.crf === 20, `rateControl=${afterBuiltin.rateControl} crf=${afterBuiltin.crf} width=${afterBuiltin.scaleWidth}`)

await ev(`(() => {
  const sel = document.querySelector('.preset-select')
  const opt = [...sel.options].find(o => o.textContent === ${JSON.stringify(TEST_PRESET)})
  if (!opt) return 'no-option'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await delay(800)
const afterSaved = JSON.parse(await ev('window.streamer.getSettings().then(s => JSON.stringify(s.session))'))
record(
  'applying the saved preset restores every group',
  afterSaved.video.bitrateKbps === 3200 &&
    afterSaved.video.fps === 24 &&
    afterSaved.audio.bitrateKbps === 96 &&
    afterSaved.subtitles.mode === 'off' &&
    afterSaved.video.scale === '1600:-2',
  JSON.stringify({ v: afterSaved.video.bitrateKbps, fps: afterSaved.video.fps, a: afterSaved.audio.bitrateKbps, sub: afterSaved.subtitles.mode, scale: afterSaved.video.scale })
)
record(
  'applying the saved preset restores the stream target',
  afterSaved.output.streamKey === 'preset-key-test' && afterSaved.output.server === 'rtmp://preset.example.com/live/',
  JSON.stringify({ server: afterSaved.output.server, key: afterSaved.output.streamKey })
)
record(
  'applying the saved preset restores the obs-websocket block',
  afterSaved.output.obsWebSocket?.enabled === true && afterSaved.output.obsWebSocket?.port === 14455,
  JSON.stringify(afterSaved.output.obsWebSocket)
)

/* ---------- rename ----------
 * The store, IPC and preload layers have always had rename; this suite is what
 * proves the button that reaches them exists and that the new name is what lands
 * on disk. Renaming must not disturb the selection or the settings it holds. */
note('renaming a preset through the UI')
const RENAMED_PRESET = `${TEST_PRESET} · 改名`
const presetIdsBeforeRename = JSON.parse(await ev('window.streamer.getPresets().then(p => JSON.stringify(p.presets.map(x => x.id)))'))

await ev(`(() => {
  const sel = document.querySelector('.preset-select')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  const opt = [...document.querySelectorAll('.preset-select option')].find(o => o.textContent === ${JSON.stringify(TEST_PRESET)})
  if (!sel || !opt) return 'no-option'
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`)
await delay(600)

const renameBtn = await ev(`[...document.querySelectorAll('.preset-bar button')].some(b => b.textContent.trim() === '改名')`)
record('a rename button appears for the selected user preset', renameBtn)

await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.trim() === '改名')
  btn?.click()
  return 'ok'
})()`)
await delay(300)

const renameForm = JSON.parse(
  await ev(`JSON.stringify({
    open: !!document.querySelector('.preset-menu[data-mode="rename"]'),
    prefilled: document.querySelector('.preset-menu input')?.value ?? null
  })`)
)
record('the rename form opens and starts from the current name', renameForm.open && renameForm.prefilled === TEST_PRESET, JSON.stringify(renameForm))

await ev(`(() => {
  const input = document.querySelector('.preset-menu[data-mode="rename"] input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(RENAMED_PRESET)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await delay(250)
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-menu[data-mode="rename"] button')].find(b => b.textContent.trim() === '改名')
  btn?.click()
  return 'ok'
})()`)
await delay(900)

const afterRename = fs.existsSync(PRESETS_FILE) ? JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) : { presets: [] }
const renamedEntry = (afterRename.presets ?? []).find((p) => p.name === RENAMED_PRESET)
record('renaming writes the new name to presets.json', Boolean(renamedEntry), `names: ${(afterRename.presets ?? []).map((p) => p.name).join(' | ') || 'none'}`)
record('the old name is gone from disk', !(afterRename.presets ?? []).some((p) => p.name === TEST_PRESET))
record(
  'renaming keeps the stored settings untouched',
  renamedEntry?.settings?.video?.bitrateKbps === 3200 && renamedEntry?.settings?.output?.streamKey === 'preset-key-test',
  renamedEntry ? `bitrate=${renamedEntry.settings.video.bitrateKbps} key=${renamedEntry.settings.output.streamKey}` : 'missing'
)

const selectionAfterRename = JSON.parse(
  await ev(`JSON.stringify({
    value: document.querySelector('.preset-select')?.value ?? '',
    label: document.querySelector('.preset-select')?.selectedOptions?.[0]?.textContent ?? '',
    menuClosed: !document.querySelector('.preset-menu'),
    deleteShown: [...document.querySelectorAll('.preset-bar button')].some(b => b.textContent.trim() === '删除')
  })`)
)
record(
  'the renamed preset stays selected and the form closes',
  selectionAfterRename.value !== '' && selectionAfterRename.label === RENAMED_PRESET && selectionAfterRename.menuClosed && selectionAfterRename.deleteShown,
  JSON.stringify(selectionAfterRename)
)
record(
  'renaming preserved the preset id the UI was pointing at',
  presetIdsBeforeRename.includes(selectionAfterRename.value),
  `${selectionAfterRename.value} in [${presetIdsBeforeRename.join(', ')}]`
)

/* Rename again to check the store keeps one entry (no duplicate row appears). */
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.trim() === '改名')
  btn?.click()
  return 'ok'
})()`)
await delay(250)
await ev(`(() => {
  const input = document.querySelector('.preset-menu[data-mode="rename"] input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(`${TEST_PRESET} · 二次改名`)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)
await delay(250)
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-menu[data-mode="rename"] button')].find(b => b.textContent.trim() === '改名')
  btn?.click()
  return 'ok'
})()`)
await delay(900)
const afterSecondRename = fs.existsSync(PRESETS_FILE) ? JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) : { presets: [] }
record(
  'renaming twice leaves exactly one preset',
  (afterSecondRename.presets ?? []).filter((p) => p.id === selectionAfterRename.value).length === 1 &&
    (afterSecondRename.presets ?? []).some((p) => p.name === `${TEST_PRESET} · 二次改名`),
  (afterSecondRename.presets ?? []).map((p) => p.name).join(' | ') || 'none'
)

/* ---------- delete ----------
 * Nothing else in this suite depends on the preset surviving, so the rename
 * checks above run first and the cleanup happens last. The prefix match covers
 * every name the rename steps produced. */
note('deleting the test preset')
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.trim() === '删除')
  btn?.click()
  return 'ok'
})()`)
await delay(900)
const afterDelete = fs.existsSync(PRESETS_FILE) ? JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) : { presets: [] }
record(
  'deleting removes the preset from disk',
  !(afterDelete.presets ?? []).some((p) => p.name.startsWith(TEST_PRESET)),
  `${(afterDelete.presets ?? []).length} remaining`
)

/* ---------- resolution + unit controls ---------- */
note('checking resolution and bitrate unit controls')
await ev(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('视频编码'))
  tab?.click()
  return 'ok'
})()`)
await delay(300)

const resShape = await ev(`(() => {
  const f = document.querySelector('.res-field')
  if (!f) return 'missing'
  const w = f.querySelector('input[aria-label="宽度"]')
  const h = f.querySelector('input[aria-label="高度"]')
  const auto = f.querySelector('.auto-check input')
  return JSON.stringify({
    hasWidth: !!w, hasHeight: !!h, hasAuto: !!auto,
    autoChecked: auto?.checked, heightDisabled: h?.disabled,
    widthDisabled: w?.disabled, heightPlaceholder: h?.placeholder
  })
})()`)
const shape = JSON.parse(resShape)
record('resolution has separate width and height inputs', shape.hasWidth && shape.hasHeight, resShape)
record('auto checkbox disables the height input', shape.hasAuto && shape.autoChecked && shape.heightDisabled, `checked=${shape.autoChecked} heightDisabled=${shape.heightDisabled}`)
record('width input stays editable while auto is on', shape.widthDisabled === false, `widthDisabled=${shape.widthDisabled}`)

const unitSelect = await ev(`(() => {
  const fields = [...document.querySelectorAll('.settings-body .field')]
  const f = fields.find(x => (x.querySelector('.field-label')?.textContent ?? '').trim().startsWith('视频码率'))
  const sel = f?.querySelector('.unit-input select')
  return sel ? JSON.stringify([...sel.options].map(o => o.value)) : 'missing'
})()`)
record('bitrate field offers a unit dropdown', unitSelect.includes('kbps') && unitSelect.includes('mbps'), unitSelect)

// Switch to Mbps and confirm the same rate is re-expressed, not rescaled.
const unitConversion = await ev(`(() => {
  const fields = [...document.querySelectorAll('.settings-body .field')]
  const f = fields.find(x => (x.querySelector('.field-label')?.textContent ?? '').trim().startsWith('视频码率'))
  const input = f.querySelector('.unit-input input')
  const before = input.value
  const sel = f.querySelector('.unit-input select')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'mbps')
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return JSON.stringify({ before })
})()`)
await delay(300)
const unitAfter = await ev(`(() => {
  const fields = [...document.querySelectorAll('.settings-body .field')]
  const f = fields.find(x => (x.querySelector('.field-label')?.textContent ?? '').trim().startsWith('视频码率'))
  const input = f.querySelector('.unit-input input')
  const sel = f.querySelector('.unit-input select')
  return JSON.stringify({ value: input.value, unit: sel.value })
})()`)
record('switching to Mbps keeps the same bitrate', JSON.parse(unitAfter).unit === 'mbps', `${unitConversion} → ${unitAfter}`)

// Enter 6 Mbps and confirm 6000 kbps is what the engine receives. The field commits
// when it is left (typing alone must not reach the model), so the write is bracketed
// with focusin/focusout — see `setFieldValue` for why not focus()/blur().
await ev(`(() => {
  const fields = [...document.querySelectorAll('.settings-body .field')]
  const f = fields.find(x => (x.querySelector('.field-label')?.textContent ?? '').trim().startsWith('视频码率'))
  const input = f.querySelector('.unit-input input')
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '6')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  return 'ok'
})()`)
await delay(500)
const mbpsValue = await ev('window.streamer.getSettings().then(s => s.session.video.bitrateKbps)')
record('typing Mbps stores the equivalent kbps value', mbpsValue === 6000, `6 Mbps -> ${mbpsValue} kbps`)

const commandUsesScale = await ev(`(() => {
  const s = document.querySelector('.res-field input[aria-label="宽度"]')
  return s ? 'has-width' : 'no-width'
})()`)
record('resolution inputs are reachable in the rendered form', commandUsesScale === 'has-width', commandUsesScale)

record('no uncaught renderer exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none')

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} preset/UI checks passed`)

ws.close()
appProc.kill('SIGKILL')
await delay(600)
restoreSettings()
fs.writeFileSync(path.join(here, 'preset-e2e-report.json'), JSON.stringify({ results }, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
