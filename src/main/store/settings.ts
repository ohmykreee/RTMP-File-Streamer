import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AppSettings, AudioSettings, Language, OutputSettings, ThemePreference, VideoSettings } from '@shared/types'
import { THEME_PREFERENCES } from '@shared/types'
import { BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, DEFAULT_SETTINGS, OBS_PORT_MAX, OBS_PORT_MIN } from '@shared/defaults'
import { containerForProtocol, networkForProtocol, STREAM_PROTOCOLS } from '@shared/protocol'
import { detectLanguage, isLanguage, resolveLanguage } from '@shared/i18n'
import { dataDir, ensureDir } from './paths'
import { reportStoreError } from './errors'

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
  /*
   * `languageSet` distinguishes "the user chose this" from "this is what the
   * system locale was last time". A stored file written before the field existed
   * carries a language but no flag, which is treated as an explicit choice for
   * migration. Without an explicit choice the system locale is consulted again
   * on every launch, which is what "follow the system until you switch" means.
   */
  const languageSet = typeof s.languageSet === 'boolean' ? s.languageSet : isLanguage(s.language)
  return {
    ffmpegPath: typeof s.ffmpegPath === 'string' ? s.ffmpegPath : '',
    ffprobePath: typeof s.ffprobePath === 'string' ? s.ffprobePath : '',
    // Absent in a file written before the switch existed; debug detail is the useful
    // default, so an old configuration keeps what it always had.
    debugLogging: typeof s.debugLogging === 'boolean' ? s.debugLogging : DEFAULT_SETTINGS.debugLogging,
    language: languageSet ? resolveLanguage(s.language, getSystemLocale()) : detectLanguage(getSystemLocale()),
    languageSet,
    // An unknown value (an old file, a hand edit) follows the system, like a fresh
    // install does.
    theme: THEME_PREFERENCES.includes(s.theme as ThemePreference) ? (s.theme as ThemePreference) : DEFAULT_SETTINGS.theme,
    // Clamped rather than trusted: the panel cannot be dragged outside this range, and
    // a hand-edited file should not be able to leave the queue invisible.
    playlistWidthPercent: clampNumber(s.playlistWidthPercent, 12, 55, DEFAULT_SETTINGS.playlistWidthPercent),
    session: {
      video: normaliseVideo({ ...DEFAULT_SETTINGS.session.video, ...(session.video ?? {}) }),
      audio: normaliseAudio({ ...DEFAULT_SETTINGS.session.audio, ...(session.audio ?? {}) }),
      subtitles: { ...DEFAULT_SETTINGS.session.subtitles, ...(session.subtitles ?? {}) },
      output: normaliseOutput(output)
    }
  }
}

/**
 * Keeps numeric encoder settings in the ranges the command builder assumes.
 *
 * The UI clamps on commit, but a preset, a hand-edited settings file or an IPC
 * client can still deliver `fps: 1000` / `crf: 1000`. The builder only clamped a
 * few fields, so the rest reached ffmpeg as-is. Values written by this version
 * are unaffected.
 */
function normaliseVideo(v: VideoSettings): VideoSettings {
  return {
    ...v,
    bitrateKbps: Math.round(clampNumber(v.bitrateKbps, 100, 100_000, DEFAULT_SETTINGS.session.video.bitrateKbps)),
    maxBitrateKbps: Math.round(clampNumber(v.maxBitrateKbps, 100, 100_000, DEFAULT_SETTINGS.session.video.maxBitrateKbps)),
    bufferSizeKbps: Math.round(clampNumber(v.bufferSizeKbps, 0, 200_000, DEFAULT_SETTINGS.session.video.bufferSizeKbps)),
    crf: Math.round(clampNumber(v.crf, 0, 51, DEFAULT_SETTINGS.session.video.crf)),
    fps: Math.round(clampNumber(v.fps, 0, 240, DEFAULT_SETTINGS.session.video.fps)),
    keyframeIntervalSec: clampNumber(v.keyframeIntervalSec, 0, 10, DEFAULT_SETTINGS.session.video.keyframeIntervalSec),
    bFrames: Math.round(clampNumber(v.bFrames, 0, 4, DEFAULT_SETTINGS.session.video.bFrames)),
    scaleWidth: Math.round(clampNumber(v.scaleWidth, 2, 7680, DEFAULT_SETTINGS.session.video.scaleWidth)),
    scaleHeight: Math.round(clampNumber(v.scaleHeight, 2, 4320, DEFAULT_SETTINGS.session.video.scaleHeight)),
    preset: typeof v.preset === 'string' ? v.preset : '',
    tune: typeof v.tune === 'string' ? v.tune : '',
    profile: typeof v.profile === 'string' ? v.profile : '',
    pixelFormat: typeof v.pixelFormat === 'string' ? v.pixelFormat : 'yuv420p'
  }
}

function normaliseAudio(a: AudioSettings): AudioSettings {
  const sampleRate = [22050, 32000, 44100, 48000].includes(a.sampleRate)
    ? a.sampleRate
    : DEFAULT_SETTINGS.session.audio.sampleRate
  return {
    ...a,
    bitrateKbps: Math.round(clampNumber(a.bitrateKbps, 16, 512, DEFAULT_SETTINGS.session.audio.bitrateKbps)),
    sampleRate,
    channels: Math.round(clampNumber(a.channels, 1, 2, DEFAULT_SETTINGS.session.audio.channels))
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
  /*
   * An address the user emptied stays empty. The field is theirs to clear while
   * they retype it, and answering back with a stored default in the middle of an
   * edit is how a target nobody chose ends up in a settings file. A *missing*
   * value (a fresh install, an old settings file) still falls back, so the field
   * starts from the same example it always did — the UI reports the empty state
   * itself, and the engine refuses to start without one.
   */
  const server = typeof raw.server === 'string' ? raw.server : fallback.server
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
    bufferSec: delay,
    obsWebSocket: {
      enabled: obs.enabled === true,
      host: typeof obs.host === 'string' && obs.host.trim() ? obs.host.trim() : fallback.obsWebSocket.host,
      port: Math.round(clampNumber(obs.port, OBS_PORT_MIN, OBS_PORT_MAX, fallback.obsWebSocket.port)),
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
  } catch (err) {
    // Resolve first: the error reporter logs through the settings store.
    cached = mergeSettings(undefined)
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Keep the unreadable file for diagnosis instead of silently overwriting
      // it with defaults on the next save.
      try {
        fs.renameSync(settingsFile(), `${settingsFile()}.corrupt-${Date.now()}`)
      } catch {
        /* ignore: the directory may be read-only; the error is reported below */
      }
      reportStoreError('settings', err)
    }
  }
  return cached
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  /*
   * A patch is a delta, not a replacement. Spreading it over `current` would let
   * `session: { video: … }` erase the other three sections (they would be filled
   * back from DEFAULTS by `mergeSettings`), and an explicit `undefined` would
   * reset the value. Both reach the store from IPC callers, not just the UI.
   */
  const defined = Object.fromEntries(
    Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)
  ) as Partial<AppSettings>
  const sessionPatch = defined.session
  const session = {
    ...current.session,
    ...(sessionPatch ?? {}),
    video: { ...current.session.video, ...(sessionPatch?.video ?? {}) },
    audio: { ...current.session.audio, ...(sessionPatch?.audio ?? {}) },
    subtitles: { ...current.session.subtitles, ...(sessionPatch?.subtitles ?? {}) },
    output: {
      ...current.session.output,
      ...(sessionPatch?.output ?? {}),
      obsWebSocket: {
        ...current.session.output.obsWebSocket,
        ...(sessionPatch?.output?.obsWebSocket ?? {})
      }
    }
  }
  /*
   * `languageSet` records a deliberate choice. Only a patch that actually carries
   * a language may change it: every other save (theme, session, panel width) would
   * otherwise pin the detected system language on first use, and the setting would
   * stop following the OS even though the user never picked one.
   */
  const languageSet =
    typeof defined.languageSet === 'boolean'
      ? defined.languageSet
      : defined.language !== undefined
        ? true
        : current.languageSet
  const next = mergeSettings({ ...current, ...defined, session, languageSet })
  cached = next
  try {
    const file = settingsFile()
    ensureDir(path.dirname(file))
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    // The cache has already changed, so the UI would show "saved" and lose it on
    // restart. Surface the failure instead of only writing to the console.
    reportStoreError('settings', err)
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
