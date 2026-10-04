/**
 * Layout regression test for requirement 1:
 * switching settings tabs must not move or resize the player bar / timeline.
 *
 * It measures the bounding boxes of the timeline and the player bar on every
 * tab and asserts they are identical, then also checks that no tab makes the
 * workspace overflow into the player bar.
 *
 * Usage: node .test/layout-e2e.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installWatchdog } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = 9812

const results = []
const note = (s, d) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` — ${d}` : ''}`)
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/* `--lang=zh-CN` pins the UI language, so the fixed layout is measured in the same
   wording on every machine instead of depending on the developer's system locale. */
const appProc = spawn(electron, ['.', '--lang=zh-CN', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, STREAMER_E2E: '1' }
})

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
  console.error('app did not start')
  appProc.kill('SIGKILL')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
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

/* wait for the workspace UI */
{
  const deadline = Date.now() + 25000
  let ok = false
  while (Date.now() < deadline) {
    ok = await ev('!!document.querySelector(".player") && !!document.querySelector(".timeline-bar")').catch(() => false)
    if (ok) break
    await delay(400)
  }
  record('application booted with the player bar', ok)
  if (!ok) {
    ws.close()
    appProc.kill('SIGKILL')
    process.exit(1)
  }
}

/** Measures the fixed parts of the shell plus the scrollable settings body. */
const measure = () =>
  ev(`(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
    }
    const body = document.querySelector('.settings-body')
    return JSON.stringify({
      window: window.innerHeight,
      player: box('.player'),
      timeline: box('.timeline-bar'),
      controls: box('.player-controls'),
      workspace: box('.workspace'),
      logs: box('.logs'),
      settingsBody: box('.settings-body'),
      settingsScroll: body ? Math.round(body.scrollHeight) : 0,
      docScrollHeight: document.documentElement.scrollHeight
    })
  })()`).then(JSON.parse)

/* The shell geometry sits on fractional pixels (DPR scaling), so a single
 * measurement taken while the window is still settling can land on the other
 * side of a .5 rounding boundary and poison the baseline. Measure twice and
 * only accept a baseline that repeats exactly. */
let baseline = await measure()
for (let i = 0; i < 10; i += 1) {
  await delay(500)
  const again = await measure()
  const same =
    again.player.top === baseline.player.top &&
    again.player.height === baseline.player.height &&
    again.timeline.top === baseline.timeline.top &&
    again.workspace.height === baseline.workspace.height
  if (same) break
  baseline = again
}
note('baseline (视频编码)', `player=${baseline.player.height}px timeline.top=${baseline.timeline.top}`)

const TABS = ['视频编码', '音频编码', '字幕', '输出', '高级']

let allStable = true
const perTab = []
for (const tab of TABS.slice(1)) {
  const switched = await ev(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(${JSON.stringify(tab)}))
    if (!t) return 'no-tab'
    t.click()
    return 'ok'
  })()`)
  await delay(450)
  const m = await measure()
  perTab.push({ tab, m, switched })
  const same =
    m.player.top === baseline.player.top &&
    m.player.height === baseline.player.height &&
    m.timeline.top === baseline.timeline.top &&
    m.timeline.height === baseline.timeline.height &&
    m.controls.top === baseline.controls.top &&
    m.workspace.height === baseline.workspace.height
  if (!same) allStable = false
  note(
    `tab ${tab}`,
    `player.top=${m.player.top} (${m.player.top === baseline.player.top ? 'same' : `was ${baseline.player.top}`}), timeline.top=${m.timeline.top} (${m.timeline.top === baseline.timeline.top ? 'same' : `was ${baseline.timeline.top}`}), workspace.h=${m.workspace.height}`
  )
}

record('player bar geometry identical across all tabs', allStable, allStable ? 'no shift' : JSON.stringify(perTab.map((p) => `${p.tab}:${p.m.player.top}`)))
record(
  'timeline keeps a constant position across all tabs',
  perTab.every((p) => p.m.timeline.top === baseline.timeline.top && p.m.timeline.height === baseline.timeline.height),
  perTab.map((p) => `${p.tab}:${p.m.timeline.top}`).join(' ')
)
record(
  'workspace height does not change with tab content',
  perTab.every((p) => p.m.workspace.height === baseline.workspace.height),
  perTab.map((p) => `${p.tab}:${p.m.workspace.height}`).join(' ')
)
record(
  'page never scrolls as a whole (inner panels scroll instead)',
  baseline.docScrollHeight <= baseline.window + 1,
  `doc=${baseline.docScrollHeight} window=${baseline.window}`
)

/* The point of the fix is that the *content* varies while the chrome does not.
   Capture each tab's content extent to prove the tabs really differ. */
const perTabContent = {}
for (const tab of TABS) {
  await ev(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(${JSON.stringify(tab)}))
    t?.click()
    return 'ok'
  })()`)
  await delay(400)
  perTabContent[tab] = await ev(`(() => {
    const body = document.querySelector('.settings-body')
    if (!body) return -1
    const fields = [...body.querySelectorAll('.field')]
    const last = fields[fields.length - 1]
    return Math.round(last ? last.getBoundingClientRect().bottom - body.getBoundingClientRect().top : 0)
  })()`)
}
// `settingsBody.scrollHeight` is the container's own height here, so the extent
// of the last field is what actually reflects per-tab content length.
record(
  'settings content extent differs per tab (so the measurement is meaningful)',
  new Set(Object.values(perTabContent)).size > 1,
  JSON.stringify(perTabContent)
)

/* Nothing may overlap the player bar: workspace bottom == player top. */
const noOverlap = await ev(`(() => {
  const ws = document.querySelector('.workspace').getBoundingClientRect()
  const pl = document.querySelector('.player').getBoundingClientRect()
  return JSON.stringify({ workspaceBottom: Math.round(ws.bottom), playerTop: Math.round(pl.top) })
})()`).then(JSON.parse)
record(
  'workspace ends exactly where the player bar begins',
  Math.abs(noOverlap.workspaceBottom - noOverlap.playerTop) <= 1,
  JSON.stringify(noOverlap)
)

/* The tall tab must scroll inside its own panel. */
const scrollable = await ev(`(() => {
  const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('视频编码'))
  t?.click()
  const body = document.querySelector('.settings-body')
  const last = [...body.querySelectorAll('.field')].pop()
  const before = body.scrollTop
  body.scrollTop = 9999
  const after = body.scrollTop
  const overflow = body.scrollHeight - body.clientHeight
  const lastVisible = last ? last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 2 : false
  body.scrollTop = before
  return JSON.stringify({ overflow, scrolled: after > before, lastVisible })
})()`).then(JSON.parse)
record(
  'tall tab scrolls inside the panel instead of growing it',
  scrollable.overflow > 0 && scrollable.scrolled,
  JSON.stringify(scrollable)
)

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} layout checks passed`)

ws.close()
appProc.kill('SIGKILL')
await delay(600)
process.exit(results.every((r) => r.ok) ? 0 : 1)
