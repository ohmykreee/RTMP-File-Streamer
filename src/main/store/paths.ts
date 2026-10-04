import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * All application state lives in a `Data` folder inside the unpacked
 * application directory (`release/win-unpacked/Data`), so the whole folder stays
 * self-contained and portable — nothing is written to the user profile.
 *
 * Layout:
 *   Data/settings.json   ffmpeg paths + current session settings
 *   Data/playlist.json   the queue, restored on next launch
 *   Data/presets.json    user-saved presets
 *   Data/Logs/           persisted run logs (rotated, size-capped)
 *   Data/Cache/          Chromium/Electron caches (kept out of the main folder)
 */
export function getAppRoot(): string {
  // Packaged: <root>/resources/app.asar → the folder holding the exe.
  if (app.isPackaged) return path.dirname(process.resourcesPath)
  // Development: the project root (electron lives in node_modules/electron/dist).
  return process.cwd()
}

export function dataDir(): string {
  return path.join(getAppRoot(), 'Data')
}

export function cacheDir(): string {
  return path.join(dataDir(), 'Cache')
}

export function logsDir(): string {
  return path.join(dataDir(), 'Logs')
}

export function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export interface PathSetup {
  dataDir: string
  cacheDir: string
  writable: boolean
}

let setup: PathSetup | null = null

/**
 * Points Electron's own writable paths at `Data/`, creating the folder on first
 * run. Nothing is read from or written to the user profile.
 *
 * Must be called before anything reads `app.getPath('userData')`.
 */
export function setupDataPaths(): PathSetup {
  if (setup) return setup

  const data = dataDir()
  const cache = cacheDir()
  const writable = ensureDir(data)
  ensureDir(cache)

  try {
    // userData feeds session storage, local storage and the DevTools profile.
    app.setPath('userData', data)
    app.setPath('sessionData', cache)
    app.setPath('cache', cache)
    app.setPath('logs', path.join(cache, 'logs'))
    app.setPath('crashDumps', path.join(cache, 'crashDumps'))
  } catch (err) {
    console.error('[paths] 无法重定向数据目录，将回退到系统默认位置:', err)
  }

  setup = {
    dataDir: data,
    cacheDir: cache,
    writable: writable && path.resolve(app.getPath('userData')) === path.resolve(data)
  }
  return setup
}

export function getPathSetup(): PathSetup {
  return setup ?? setupDataPaths()
}
