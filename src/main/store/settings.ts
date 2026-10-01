import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { dataDir, ensureDir } from './paths'

let cached: AppSettings | null = null

/** `<app>/Data/settings.json` — see `store/paths.ts`. */
function settingsFile(): string {
  return path.join(dataDir(), 'settings.json')
}

/**
 * Merge stored values over the defaults so keys added in a newer version still
 * resolve, and so a partially written file cannot break startup.
 *
 * Presets are intentionally NOT stored here — they live in the `config` folder
 * (see `store/presets.ts`).
 */
function mergeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
  const s = stored ?? {}
  const session = { ...DEFAULT_SETTINGS.session, ...(s.session ?? {}) }
  return {
    ffmpegPath: typeof s.ffmpegPath === 'string' ? s.ffmpegPath : '',
    ffprobePath: typeof s.ffprobePath === 'string' ? s.ffprobePath : '',
    session: {
      video: { ...DEFAULT_SETTINGS.session.video, ...(session.video ?? {}) },
      audio: { ...DEFAULT_SETTINGS.session.audio, ...(session.audio ?? {}) },
      subtitles: { ...DEFAULT_SETTINGS.session.subtitles, ...(session.subtitles ?? {}) },
      output: { ...DEFAULT_SETTINGS.session.output, ...(session.output ?? {}) }
    }
  }
}

export function loadSettings(): AppSettings {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    cached = mergeSettings(parsed)
  } catch {
    cached = mergeSettings(undefined)
  }
  return cached
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const next = mergeSettings({ ...current, ...patch })
  cached = next
  try {
    const file = settingsFile()
    ensureDir(path.dirname(file))
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('[settings] 保存失败:', err)
  }
  return next
}

export function getSettingsPath(): string {
  return settingsFile()
}
