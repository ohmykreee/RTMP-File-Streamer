import fs from 'node:fs'
import path from 'node:path'
import type { Preset, PresetLocation, SessionSettings } from '@shared/types'
import { DEFAULT_SESSION } from '@shared/defaults'
import { dataDir, ensureDir, getAppRoot } from './paths'

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

/**
 * A preset captures encoding preferences only. The RTMP destination and stream
 * key are deliberately excluded: they are credentials for one specific channel
 * and must never be restored silently when a preset is applied.
 */
function sanitiseSettings(settings: SessionSettings): SessionSettings {
  return {
    ...settings,
    output: { ...settings.output, rtmpUrl: DEFAULT_SESSION.output.rtmpUrl, streamKey: DEFAULT_SESSION.output.streamKey }
  }
}

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

/** Normalises a stored preset so missing keys fall back to the defaults. */
function normalise(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as StoredPresetShape
  if (typeof p.name !== 'string' || !p.name.trim()) return null
  const s = p.settings ?? {}
  const settings = sanitiseSettings({
    video: { ...DEFAULT_SESSION.video, ...(s.video ?? {}) },
    audio: { ...DEFAULT_SESSION.audio, ...(s.audio ?? {}) },
    subtitles: { ...DEFAULT_SESSION.subtitles, ...(s.subtitles ?? {}) },
    output: { ...DEFAULT_SESSION.output, ...(s.output ?? {}) }
  })

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
  } catch {
    cache = []
  }
  return cache
}

function writePresets(presets: Preset[]): void {
  const file = getPresetsFile()
  ensureDir(path.dirname(file))
  const payload: PresetsFile = { version: FILE_VERSION, presets }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  // Atomic replace so a crash mid-write cannot corrupt the store.
  fs.renameSync(tmp, file)
  cache = presets
}

export interface SavePresetInput {
  name: string
  settings: SessionSettings
}

/** Creates a preset, or overwrites the existing one with the same name. */
export function savePreset(input: SavePresetInput): Preset {
  const name = String(input.name ?? '').trim().slice(0, 80)
  if (!name) throw new Error('预设名称不能为空')

  const presets = [...listPresets()]
  const index = presets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase())
  const preset: Preset = {
    id: index >= 0 ? presets[index].id : newPresetId(),
    name,
    savedAt: Date.now(),
    settings: sanitiseSettings(input.settings)
  }
  if (index >= 0) presets[index] = preset
  else presets.push(preset)

  presets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  writePresets(presets)
  return preset
}

export function deletePreset(id: string): Preset[] {
  const presets = listPresets().filter((p) => p.id !== id)
  writePresets(presets)
  return presets
}

export function renamePreset(id: string, name: string): Preset[] {
  const trimmed = String(name ?? '').trim().slice(0, 80)
  if (!trimmed) throw new Error('预设名称不能为空')
  const presets = listPresets().map((p) => (p.id === id ? { ...p, name: trimmed, savedAt: Date.now() } : p))
  presets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  writePresets(presets)
  return presets
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
