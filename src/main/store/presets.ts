import fs from 'node:fs'
import path from 'node:path'
import type { OutputSettings, Preset, PresetLocation, SessionSettings } from '@shared/types'
import { BUILTIN_PRESETS, DEFAULT_SESSION } from '@shared/defaults'
import { dataDir, ensureDir, getAppRoot } from './paths'
import { normaliseOutput } from './settings'
import { reportStoreError } from './errors'
import { mainT } from '../i18n'

/** Presets live beside the other state files in `<app>/Data`. */
export function getPresetsFile(): string {
  return path.join(dataDir(), 'presets.json')
}

interface PresetsFile {
  version: number
  presets: Preset[]
}

const FILE_VERSION = 1

let cache: Preset[] | null = null

interface StoredPresetShape {
  id?: unknown
  name?: unknown
  savedAt?: unknown
  settings?: Partial<{
    video: Partial<SessionSettings['video']>
    audio: Partial<SessionSettings['audio']>
    subtitles: Partial<SessionSettings['subtitles']>
    output: Partial<SessionSettings['output']>
  }>
}

/**
 * Normalises a stored preset so missing keys fall back to the defaults.
 *
 * The RTMP destination and stream key ARE part of a preset and are stored in
 * plain text: a preset is meant to capture "everything I configured", including
 * where the stream goes, so applying it restores the full setup.
 */
function normalise(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as StoredPresetShape
  if (typeof p.name !== 'string' || !p.name.trim()) return null
  const s = p.settings ?? {}
  const settings: SessionSettings = {
    video: { ...DEFAULT_SESSION.video, ...(s.video ?? {}) },
    audio: { ...DEFAULT_SESSION.audio, ...(s.audio ?? {}) },
    subtitles: { ...DEFAULT_SESSION.subtitles, ...(s.subtitles ?? {}) },
    // Same normalisation as the settings file, so a preset written before the
    // delay / obs-websocket settings existed still loads with sane values.
    output: normaliseOutput((s.output ?? {}) as Partial<OutputSettings>)
  }

  return {
    id: typeof p.id === 'string' && p.id ? p.id : newPresetId(),
    name: p.name.trim().slice(0, 80),
    savedAt: typeof p.savedAt === 'number' ? p.savedAt : Date.now(),
    settings
  }
}

function newPresetId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function listPresets(): Preset[] {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(getPresetsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PresetsFile>
    const list = Array.isArray(parsed.presets) ? parsed.presets : []
    cache = list.map(normalise).filter((p): p is Preset => p !== null)
  } catch (err) {
    cache = []
    // A corrupt file used to fall back to an empty list silently, and the next
    // save then overwrote it — losing every preset. Keep the broken file aside
    // and report it instead.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        fs.renameSync(getPresetsFile(), `${getPresetsFile()}.corrupt-${Date.now()}`)
      } catch {
        /* ignore: the file may be locked; the error is reported below */
      }
      reportStoreError('presets', err)
    }
  }
  return cache
}

function writePresets(presets: Preset[]): void {
  const file = getPresetsFile()
  ensureDir(path.dirname(file))
  const payload: PresetsFile = { version: FILE_VERSION, presets }
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    // Atomic replace so a crash mid-write cannot corrupt the store.
    fs.renameSync(tmp, file)
    cache = presets
  } catch (err) {
    reportStoreError('presets', err)
    throw err
  }
}

export interface SavePresetInput {
  name: string
  settings: SessionSettings
}

/** Creates a preset, or overwrites the existing user preset with the same name. */
export function savePreset(input: SavePresetInput): Preset {
  const name = String(input.name ?? '').trim().slice(0, 80)
  if (!name) throw new Error(mainT('main.dialog.presetNameRequired'))
  if (BUILTIN_PRESETS.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(mainT('main.dialog.presetNameBuiltin'))
  }

  const presets = [...listPresets()]
  const index = presets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
  // Normalise on the way in as well as out: the in-memory list is what the next
  // save compares against, and a preset written by an older version should not
  // reappear with a different shape only after a restart.
  const normalised = normalise({
    id: index >= 0 ? presets[index].id : newPresetId(),
    name,
    savedAt: Date.now(),
    settings: input.settings
  })
  if (!normalised) throw new Error(mainT('main.dialog.presetNameRequired'))
  const preset = normalised
  if (index >= 0) presets[index] = preset
  else presets.push(preset)

  presets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  writePresets(presets)
  return preset
}

export function deletePreset(id: string): Preset[] {
  const presets = listPresets()
  if (!presets.some((p) => p.id === id)) throw new Error(mainT('main.dialog.presetNotFound'))
  const remaining = presets.filter((p) => p.id !== id)
  writePresets(remaining)
  return remaining
}

export function renamePreset(id: string, name: string): Preset[] {
  const trimmed = String(name ?? '').trim().slice(0, 80)
  if (!trimmed) throw new Error(mainT('main.dialog.presetNameRequired'))
  if (BUILTIN_PRESETS.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(mainT('main.dialog.presetNameBuiltin'))
  }
  const presets = listPresets()
  const target = presets.find((p) => p.id === id)
  if (!target) throw new Error(mainT('main.dialog.presetNotFound'))
  if (presets.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(mainT('main.dialog.presetNameTaken', { name: trimmed }))
  }
  const next = presets.map((p) => (p.id === id ? { ...p, name: trimmed, savedAt: Date.now() } : p))
  next.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  writePresets(next)
  return next
}

/** Where the state files live, for display in the UI. */
export function getPresetLocation(): PresetLocation {
  const dir = dataDir()
  return {
    dir,
    file: getPresetsFile(),
    appRoot: getAppRoot(),
    writable: ensureDir(dir)
  }
}
