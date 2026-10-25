/**
 * Shared launcher for the Tauri end-to-end suites: spawns the release build of
 * the app, waits for its WebView2 CDP target, and hands back the same CDP
 * plumbing (`send` / `ev`) the Electron suites used — copied from
 * `test/ui-e2e.mjs` / `test/features-e2e.mjs`, unchanged in behaviour.
 *
 * Differences from the Electron launch (everything else is identical):
 *   - the app is `src-tauri/target/release/rtmp-file-streamer.exe`, a plain
 *     executable built by cargo; it embeds the renderer from
 *     `out/renderer-tauri` (frontendDist), so no dev server is needed and the
 *     page URL is `http://tauri.localhost/` — never run a debug build, which
 *     expects `http://localhost:1420`. The build MUST enable the tauri
 *     `custom-protocol` feature (that is what switches the shell from the dev
 *     server to the embedded assets): `cargo build --release --features
 *     tauri/custom-protocol`, or `pnpm run build:tauri` which does the same.
 *   - the CDP endpoint comes from WebView2, so the port is passed through the
 *     `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable (the Rust
 *     shell in `src-tauri/src/window.rs` merges it with its own switches)
 *     instead of an `--remote-debugging-port` argv.
 *   - `--lang=zh-CN` stays an argv: the Rust side parses it as the locale.
 *   - the exe keeps its state in `<cwd>/Data`, so every spawn uses the repo
 *     root as the working directory, exactly like the Electron suites.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tauriAppEnv } from './harness-util.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

/** Path of the release binary; throws with the fix when it has not been built. */
export function appExePath() {
  const exe = path.join(root, 'src-tauri', 'target', 'release', 'rtmp-file-streamer.exe')
  if (!fs.existsSync(exe)) {
    throw new Error(
      `Tauri app not built: ${exe} is missing.\n` +
        `Build it first: \`pnpm run build:renderer\` (vite → out/renderer-tauri), then\n` +
        `\`cargo build --release --features tauri/custom-protocol\` in src-tauri\n` +
        `(or \`pnpm run build:tauri\`). The custom-protocol feature is required:\n` +
        `without it the binary loads the dev server URL instead of the embedded renderer.`
    )
  }
  return exe
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Polls the WebView2 DevTools endpoint for the app's page target.
 * The page URL is `http://tauri.localhost/` (frontendDist is embedded).
 */
async function waitForTarget(cdpPort, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not ready yet */
    }
    await delay(400)
  }
  return null
}

/**
 * Launches the app and connects to its renderer over CDP.
 *
 * @param {object} opts
 * @param {number} opts.cdpPort        port for the WebView2 DevTools endpoint
 * @param {string[]} [opts.args]       extra argv (default: pin the UI language,
 *                                     like every Electron suite does)
 * @param {object} [opts.env]         extra environment for this launch
 * @param {number} [opts.timeoutMs]   budget for the target to appear
 * @returns {Promise<{ proc, target, send, ev, pageErrors, appLog, close }>}
 */
export async function launchApp({ cdpPort, args = ['--lang=zh-CN'], env = {}, timeoutMs = 45000 } = {}) {
  const exe = appExePath()
  /*
   * The WebView2 browser arguments carry the CDP port. The Rust shell already
   * sets its own switches via `additional_browser_args` and merges this
   * variable in, so both survive (see src-tauri/src/window.rs).
   */
  const launchEnv = tauriAppEnv({
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    ...env
  })
  const proc = spawn(exe, args, { cwd: root, env: launchEnv })
  let appLog = ''
  proc.stdout?.on('data', (d) => (appLog += d.toString()))
  proc.stderr?.on('data', (d) => (appLog += d.toString()))

  const target = await waitForTarget(cdpPort, timeoutMs)
  if (!target) {
    console.error(`FAILED: renderer never exposed a CDP target on port ${cdpPort}\n`, appLog.slice(-2000))
    proc.kill('SIGKILL')
    throw new Error(`no CDP target at http://127.0.0.1:${cdpPort}/json/list (page http://tauri.localhost/)`)
  }

  /* ---------------- CDP plumbing (copied from test/ui-e2e.mjs) ---------------- */
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let msgId = 0
  const pending = new Map()
  const pageErrors = []

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(timer)
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

  // Bounded open: a wedged DevTools socket must fail the run, not hang it.
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    const t = setTimeout(() => reject(new Error('CDP websocket never opened')), 15000)
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(t)
        reject(new Error('CDP websocket error'))
      },
      { once: true }
    )
  })

  // Every CDP round-trip is bounded: `Runtime.evaluate` with awaitPromise would
  // otherwise park forever on a promise that never settles.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId
      const timer = setTimeout(() => {
        pending.delete(id)
        const hint = method === 'Runtime.evaluate' ? `: ${String(params.expression).slice(0, 90)}` : ''
        reject(new Error(`CDP ${method} timed out after 30s${hint}`))
      }, 30000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  const close = () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  return { proc, target, send, ev, pageErrors, getAppLog: () => appLog, close }
}
