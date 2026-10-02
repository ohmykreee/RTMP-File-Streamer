/**
 * Shared test hygiene: a watchdog that aborts a stuck run.
 *
 * The end-to-end tests drive a real window and real ffmpeg processes, so a stall
 * (window never opens, engine never reaches a state, CDP request never answers)
 * would otherwise hang forever. Every long-running harness installs a watchdog:
 * when the budget expires the process prints where it was and exits non-zero, so
 * a hang is reported as a failure within a bounded time instead of blocking the
 * whole `pnpm test` run.
 */
import { spawnSync } from 'node:child_process'

/** Kills leftover Electron/ffmpeg children so a dead run cannot hold a port. */
export function killStrays(names = ['electron', 'RTMPFileStreamer', 'ffmpeg']) {
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
