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
  /** Where state was read from before this version, when a migration happened. */
  migratedFrom: string | null
}

let setup: PathSetup | null = null

/**
 * Points Electron's own writable paths at `Data/` and moves state over from the
 * previous `%APPDATA%` location the first time this runs.
 *
 * Must be called before anything reads `app.getPath('userData')`.
 */
export function setupDataPaths(): PathSetup {
  if (setup) return setup

  const data = dataDir()
  const cache = cacheDir()
  const writable = ensureDir(data)
  ensureDir(cache)

  let migratedFrom: string | null = null

  if (writable) {
    // Move state out of the old per-user folder so upgrading users keep their
    // settings, queue and presets instead of silently starting fresh.
    const legacy = path.join(app.getPath('appData'), 'RTMP File Streamer')
    if (path.resolve(legacy) !== path.resolve(data) && fs.existsSync(legacy)) {
      const moved: string[] = []
      for (const file of ['settings.json', 'playlist.json']) {
        const from = path.join(legacy, file)
        const to = path.join(data, file)
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          try {
            fs.copyFileSync(from, to)
            moved.push(file)
          } catch {
            /* skip files that cannot be copied */
          }
        }
      }
      // Presets used to live in a `config` subfolder of the same place.
      const legacyPresets = path.join(legacy, 'config', 'presets.json')
      const newPresets = path.join(data, 'presets.json')
      if (fs.existsSync(legacyPresets) && !fs.existsSync(newPresets)) {
        try {
          fs.copyFileSync(legacyPresets, newPresets)
          moved.push('presets.json')
        } catch {
          /* ignore */
        }
      }
      if (moved.length > 0) migratedFrom = `${legacy} (${moved.join(', ')})`
    }
  }

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
    writable: writable && path.resolve(app.getPath('userData')) === path.resolve(data),
    migratedFrom
  }
  return setup
}

export function getPathSetup(): PathSetup {
  return setup ?? setupDataPaths()
}
