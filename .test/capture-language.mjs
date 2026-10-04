/**
 * Captures the top bar in each language, for the docs.
 *
 * Drives the real app over CDP (same plumbing as `ui-e2e.mjs`): takes a screenshot
 * of the header with the switcher menu open, then switches to Japanese and takes
 * another, so the screenshots show the control and its effect rather than just
 * asserting on them.
 *
 * Usage: node .test/capture-language.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const CDP_PORT = 9333
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const OUT_DIR = path.join(root, 'docs')
fs.mkdirSync(OUT_DIR, { recursive: true })

// Language is pinned so the run is reproducible; the screenshots then show the
// switch itself, not whatever locale the machine happens to have.
const appProc = spawn(electron, ['.', '--lang=zh-CN', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, STREAMER_E2E: '1' }
})
let log = ''
appProc.stdout?.on('data', (d) => (log += d))
appProc.stderr?.on('data', (d) => (log += d))

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
  console.error('renderer never exposed a CDP target\n', log.slice(-1500))
  appProc.kill('SIGKILL')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
await send('Runtime.enable')
await send('Page.enable')

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

/* Only the header: the point is the control and the language it switches. */
async function shootTopBar(file) {
  const box = await evaluate(
    `(() => { const r = document.querySelector('.topbar').getBoundingClientRect(); return JSON.stringify({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}) })()`
  )
  const rect = JSON.parse(box)
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 2 } })
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`saved ${path.relative(root, file)} (${rect.width}x${rect.height} @2x)`)
}

await delay(2500)
await shootTopBar(path.join(OUT_DIR, 'i18n-topbar-zh.png'))

// Open the menu so the three options are visible, and capture that too.
await evaluate(`(() => { document.querySelector('.lang-btn').click(); return 'ok' })()`)
await delay(400)
const barBox = JSON.parse(
  await evaluate(
    `(() => { const r = document.querySelector('.topbar').getBoundingClientRect(); return JSON.stringify({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}) })()`
  )
)
const menuBox = JSON.parse(
  await evaluate(
    `(() => { const r = document.querySelector('.lang-menu').getBoundingClientRect(); return JSON.stringify({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}) })()`
  )
)
const clip = {
  x: Math.min(barBox.x, menuBox.x),
  y: barBox.y,
  width: Math.max(barBox.x + barBox.width, menuBox.x + menuBox.width) - Math.min(barBox.x, menuBox.x),
  height: menuBox.y + menuBox.height - barBox.y
}
const menuShot = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } })
fs.writeFileSync(path.join(OUT_DIR, 'i18n-menu.png'), Buffer.from(menuShot.data, 'base64'))
console.log(`saved docs/i18n-menu.png (${clip.width}x${clip.height} @2x)`)

// Switch to Japanese and capture the same bar in it.
await evaluate(`(() => {
  [...document.querySelectorAll('.lang-menu .lang-item')].find(b => b.textContent.includes('日本語')).click()
  return 'ok'
})()`)
await delay(900)
await shootTopBar(path.join(OUT_DIR, 'i18n-topbar-ja.png'))

const title = await evaluate(`document.querySelector('.brand h1').textContent`)
console.log(`brand title after switching: ${title}`)

ws.close()
appProc.kill('SIGKILL')
await delay(600)
process.exit(0)
