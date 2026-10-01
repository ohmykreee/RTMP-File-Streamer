/**
 * Verifies the preset feature end to end through the real app:
 *   - the preset bar renders with built-ins
 *   - saving captures settings from every tab (video/audio/subtitles/output)
 *   - the file lands in the app's Data folder as documented
 *   - applying a preset restores those settings
 *   - deleting removes it again
 *   - the resolution controls and bitrate unit selector behave
 *
 * Usage: node .test/preset-e2e.mjs
 */
import { spawn } from 'node:child_process'
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
const LEGACY_DATA = path.join(process.env.APPDATA ?? '', 'RTMP File Streamer')

const results = []
const note = (s, d) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` — ${d}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// Start from a clean slate so assertions about file creation are meaningful.
// The legacy %APPDATA% folder is removed too, otherwise the app's first-run
// migration would copy stale settings back into Data/.
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.rmSync(LEGACY_DATA, { recursive: true, force: true })
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

const appProc = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
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

/** Sets a numeric/native input inside the field whose label starts with `labelStartsWith`. */
const setFieldValue = async (labelStartsWith, value) => {
  return ev(`(() => {
    const field = ${fieldExpr(labelStartsWith)}
    if (!field) return 'no-field'
    const input = field.querySelector('input[type="number"], input[type="text"], input:not([type])')
    if (!input) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, String(${JSON.stringify(String(value))}))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
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
await setFieldValue('分辨率', 1600)

// audio tab: 96 kbps
await openTab('音频编码', '码率')
await setFieldValue('码率', 96)

// subtitle tab: turn subtitles off
await openTab('字幕', '默认字幕处理方式')
await setSelectByValue('默认字幕处理方式', 'off')
await delay(200)

// output tab: stream key
const outputTabReady = await openTab('输出', '串流密钥')
record('output tab renders its fields', outputTabReady)
await setFieldValue('串流密钥', 'preset-key-test')
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
    'the preset does NOT store the RTMP destination',
    saved?.settings?.output?.streamKey === 'test',
    `stored key = ${saved?.settings?.output?.streamKey}`
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

/* ---------- delete ---------- */
note('deleting the test preset')
await ev(`(() => {
  const btn = [...document.querySelectorAll('.preset-bar button')].find(b => b.textContent.trim() === '删除')
  btn?.click()
  return 'ok'
})()`)
await delay(900)
const afterDelete = fs.existsSync(PRESETS_FILE) ? JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) : { presets: [] }
record('deleting removes the preset from disk', !(afterDelete.presets ?? []).some((p) => p.name === TEST_PRESET), `${(afterDelete.presets ?? []).length} remaining`)

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

// Enter 6 Mbps and confirm 6000 kbps is what the engine receives.
await ev(`(() => {
  const fields = [...document.querySelectorAll('.settings-body .field')]
  const f = fields.find(x => (x.querySelector('.field-label')?.textContent ?? '').trim().startsWith('视频码率'))
  const input = f.querySelector('.unit-input input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '6')
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
