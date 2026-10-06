import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AppSettings, Language, OutputSettings } from '@shared/types'
import { BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, DEFAULT_SETTINGS } from '@shared/defaults'
import { containerForProtocol, networkForProtocol, STREAM_PROTOCOLS } from '@shared/protocol'
import { isLanguage, resolveLanguage } from '@shared/i18n'
import { dataDir, ensureDir } from './paths'

let cached: AppSettings | null = null

/** `<app>/Data/settings.json` — see `store/paths.ts`. */
function settingsFile(): string {
  return path.join(dataDir(), 'settings.json')
}

/**
 * The language the operating system is set to, as Electron reports it.
 *
 * `app.getLocale()` is the OS UI language (the same one Chromium would negotiate
 * with `navigator.language` in the renderer), and it is read only after the app is
 * ready, which every caller here is. A missing or empty value is passed through as
 * an empty tag so `detectLanguage` falls back rather than guessing from the
 * process environment, which on Windows says nothing useful about the UI language.
 */
export function getSystemLocale(): string {
  try {
    return app.getLocale()
  } catch {
    return ''
  }
}

/**
 * Merge stored values over the defaults so keys added in a newer version still
 * resolve, and so a partially written file cannot break startup.
 */
function mergeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
  const s = stored ?? {}
  const session = { ...DEFAULT_SETTINGS.session, ...(s.session ?? {}) }
  const output = session.output ?? {}
  return {
    ffmpegPath: typeof s.ffmpegPath === 'string' ? s.ffmpegPath : '',
    ffprobePath: typeof s.ffprobePath === 'string' ? s.ffprobePath : '',
    // Absent in a file written before the switch existed; debug detail is the useful
    // default, so an old configuration keeps what it always had.
    debugLogging: typeof s.debugLogging === 'boolean' ? s.debugLogging : DEFAULT_SETTINGS.debugLogging,
    // A stored language wins; otherwise the system locale decides. `languageSet`
    // distinguishes the two, so a settings file written before i18n existed (which
    // has neither key) is treated as "never chosen" and follows the OS.
    language: resolveLanguage(s.language, getSystemLocale()),
    languageSet: isLanguage(s.language),
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
 * The buffered playout is selected by `buffered` alone; `bufferSec` is only how far
 * the encoder may lead, and it is clamped into the range the engine accepts rather
 * than being allowed to express the switch as well.
 *
 * The protocol decides two more fields: the transport is clamped to what the
 * protocol can actually run over, and the container is derived from it outright
 * (a settings file or preset written before the protocol existed carries a
 * `container` choice that is no longer free — it is overwritten, not merged).
 */
export function normaliseOutput(raw: Partial<OutputSettings>): OutputSettings {
  const fallback = DEFAULT_SETTINGS.session.output
  const server = typeof raw.server === 'string' && raw.server.trim() ? raw.server : fallback.server
  const obs = { ...fallback.obsWebSocket, ...(raw.obsWebSocket ?? {}) }
  const buffered = typeof raw.buffered === 'boolean' ? raw.buffered : fallback.buffered
  const delay = clampNumber(raw.bufferSec, BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT)
  const protocol = STREAM_PROTOCOLS.includes(raw.protocol as OutputSettings['protocol'])
    ? (raw.protocol as OutputSettings['protocol'])
    : fallback.protocol
  return {
    ...fallback,
    ...raw,
    server,
    streamKey: typeof raw.streamKey === 'string' ? raw.streamKey : fallback.streamKey,
    protocol,
    network: networkForProtocol(protocol, raw.network),
    container: containerForProtocol(protocol) ?? fallback.container,
    buffered,
    bufferSec: buffered ? delay : clampNumber(raw.bufferSec, BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT),
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

/**
 * The active interface language.
 *
 * Read through `loadSettings()` rather than cached separately so the language and
 * the settings file can never disagree about it.
 */
export function getLanguage(): Language {
  return loadSettings().language
}

/**
 * Records an explicit language choice.
 *
 * Writes both fields: the language itself, and `languageSet` so the choice stops
 * being treated as a mirror of the system locale. Returns the stored settings so a
 * caller can hand the renderer exactly what was persisted.
 */
export function setLanguage(language: Language): AppSettings {
  return saveSettings({ language, languageSet: true })
}
