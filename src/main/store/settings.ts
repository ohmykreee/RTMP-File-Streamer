import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, OutputSettings } from '@shared/types'
import { BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, DEFAULT_SETTINGS } from '@shared/defaults'
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
  const output = (session.output ?? {}) as Partial<OutputSettings> & { rtmpUrl?: unknown }
  return {
    ffmpegPath: typeof s.ffmpegPath === 'string' ? s.ffmpegPath : '',
    ffprobePath: typeof s.ffprobePath === 'string' ? s.ffprobePath : '',
    session: {
      video: { ...DEFAULT_SETTINGS.session.video, ...(session.video ?? {}) },
      audio: { ...DEFAULT_SETTINGS.session.audio, ...(session.audio ?? {}) },
      subtitles: { ...DEFAULT_SETTINGS.session.subtitles, ...(session.subtitles ?? {}) },
      output: normaliseOutput(output)
    }
  }
}

/**
 * Normalises the output block.
 *
 * `rtmpUrl` was renamed to `server` when the OBS-compatible control endpoint
 * arrived (OBS calls the field "server"); the old key is still honoured so an
 * existing installation keeps pushing to the address it was configured with.
 *
 * The buffered playout used to be selected by a NON-ZERO `bufferSec`, and the delay
 * had no floor. Both changed: the switch is its own field now and the delay has a
 * minimum, so a stored file written under the old rule is migrated here — a non-zero
 * delay means the operator wanted buffering, and a delay the engine would refuse is
 * raised to the smallest one it accepts instead of silently disabling the feature.
 */
export function normaliseOutput(raw: Partial<OutputSettings> & { rtmpUrl?: unknown }): OutputSettings {
  const fallback = DEFAULT_SETTINGS.session.output
  const legacy = typeof raw.rtmpUrl === 'string' ? raw.rtmpUrl : ''
  const server = typeof raw.server === 'string' && raw.server.trim() ? raw.server : legacy || fallback.server
  const obs = { ...fallback.obsWebSocket, ...(raw.obsWebSocket ?? {}) }
  const storedDelay = Number(raw.bufferSec)
  const buffered = typeof raw.buffered === 'boolean' ? raw.buffered : Number.isFinite(storedDelay) && storedDelay > 0
  const delay = clampNumber(storedDelay, BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT)
  return {
    ...fallback,
    ...raw,
    server,
    streamKey: typeof raw.streamKey === 'string' ? raw.streamKey : fallback.streamKey,
    buffered,
    bufferSec: buffered ? clampNumber(delay, BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT) : delay,
    obsWebSocket: {
      enabled: obs.enabled === true,
      host: typeof obs.host === 'string' && obs.host.trim() ? obs.host.trim() : fallback.obsWebSocket.host,
      port: Math.round(clampNumber(obs.port, 1, 65535, fallback.obsWebSocket.port)),
      password: typeof obs.password === 'string' ? obs.password : ''
    }
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
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
