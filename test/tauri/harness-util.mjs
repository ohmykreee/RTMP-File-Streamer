/**
 * Shared test hygiene for the Tauri end-to-end suites — the same contract as
 * `test/harness-util.mjs` (watchdog + phase are copied, not imported, so the
 * watchdog kills the Tauri app's own process names), with the Electron-specific
 * environment replaced by the Tauri one.
 *
 * The Tauri app is a plain executable, so `electronEnv` has nothing to strip:
 * the suites only need `STREAMER_E2E=1` (the Rust shell moves the window
 * off-screen and makes it click-through) plus whatever a caller adds — most
 * importantly `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` for the CDP port, which
 * the launcher in `launch.mjs` sets.
 */
import { spawnSync } from 'node:child_process'

/**
 * Kills leftover app/ffmpeg children so a dead run cannot hold a port.
 *
 * `rtmp-file-streamer` is what plain `cargo build --release` names the binary;
 * `RTMPFileStreamer` is the name `tauri build` installs (mainBinaryName), so a
 * packaged copy left running is caught too.
 */
export function killStrays(names = ['rtmp-file-streamer', 'RTMPFileStreamer', 'ffmpeg']) {
  if (process.platform !== 'win32') return
  for (const name of names) {
    try {
      spawnSync('taskkill', ['/F', '/IM', `${name}.exe`, '/T'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* ignore: nothing to kill */
    }
  }
}

/**
 * Environment for launching the Tauri app. `extra` is merged in last so the
 * launcher can add the WebView2 CDP switch; `STREAMER_E2E=1` is always set
 * (off-screen + click-through window, implemented in `src-tauri/src/window.rs`).
 */
export function tauriAppEnv(extra = {}) {
  return { ...process.env, ...extra, STREAMER_E2E: '1' }
}

/**
 * Installs the watchdog.
 *
 * @param {number} budgetMs  total wall-clock budget for the whole script
 * @param {string} label     name shown in the failure message
 * @returns {() => void}     call on success to disarm the watchdog
 */
export function installWatchdog(budgetMs, label) {
  const started = Date.now()

  const timer = setTimeout(() => {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.error(
      `\n[watchdog] ${label} exceeded its ${(budgetMs / 1000).toFixed(0)}s budget ` +
        `(ran ${elapsed}s) — treating it as stuck and aborting. ` +
        `The last progress line above shows which step did not complete.`
    )
    killStrays()
    // Exit code 3 marks "timed out", distinct from an assertion failure (1).
    process.exit(3)
  }, budgetMs)

  // The timer must NOT be unref'd: it has to be able to fire while the script is
  // parked on an await that will never settle (that is the case it guards).
  return () => clearTimeout(timer)
}

/**
 * Wraps one phase of a test so a stall inside it is reported with its name
 * rather than as a mystery hang at the end of the run.
 */
export function phase(name) {
  const started = Date.now()
  console.log(`\n== ${name}`)
  return () => console.log(`   (${name} took ${((Date.now() - started) / 1000).toFixed(1)}s)`)
}
