import fs from 'node:fs'
import path from 'node:path'
import type { MediaInfo, PlaylistItem, SubtitleMode, SubtitleTrackRef } from '@shared/types'
import { probeMedia, probeSubtitleFile, embeddedSubtitleRefs } from '../ffmpeg/probe'
import { SUPPORTED_SUBTITLE_EXT } from '@shared/types'
import { dataDir, ensureDir } from './paths'

export interface PlaylistStore {
  items: PlaylistItem[]
  media: Map<string, MediaInfo>
}

let idSeq = 0
function newId(): string {
  idSeq += 1
  return `it_${Date.now().toString(36)}_${idSeq.toString(36)}`
}

/** Probe cache keyed by path, invalidated when the file's size or mtime changes. */
interface CacheEntry {
  key: string
  info: MediaInfo
}
const probeCache = new Map<string, CacheEntry>()

function fileKey(p: string): string {
  try {
    const st = fs.statSync(p)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'missing'
  }
}

export async function probeCached(ffprobePath: string, filePath: string): Promise<MediaInfo> {
  const abs = path.resolve(filePath)
  const key = fileKey(abs)
  const hit = probeCache.get(abs)
  if (hit && hit.key === key) return hit.info
  const info = await probeMedia(ffprobePath, abs)
  if (!info.probeError) probeCache.set(abs, { key, info })
  return info
}

export function getCachedMedia(filePath: string): MediaInfo | undefined {
  const abs = path.resolve(filePath)
  const hit = probeCache.get(abs)
  if (!hit) return undefined
  if (hit.key !== fileKey(abs)) {
    probeCache.delete(abs)
    return undefined
  }
  return hit.info
}

export function invalidateProbe(filePath: string): void {
  probeCache.delete(path.resolve(filePath))
}

/**
 * Sidecar subtitle files that belong to `videoPath`: same basename with any
 * language/qualifier suffix, plus `Subs/`-style sibling folders.
 */
export function findSidecarSubtitles(videoPath: string): string[] {
  const dir = path.dirname(videoPath)
  const stem = path.basename(videoPath, path.extname(videoPath)).toLowerCase()
  const found: string[] = []

  const scan = (targetDir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(targetDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(targetDir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0 && /^(subs?|subtitles?|字幕)$/i.test(entry.name)) scan(full, depth - 1)
        continue
      }
      const ext = path.extname(entry.name).toLowerCase()
      if (!SUPPORTED_SUBTITLE_EXT.includes(ext)) continue
      const entryStem = path.basename(entry.name, ext).toLowerCase()
      // Accept "movie.srt", "movie.zh-CN.srt", "movie.forced.ass", "movie.eng"
      if (entryStem === stem || entryStem.startsWith(`${stem}.`) || entryStem.startsWith(`${stem}_`) || entryStem.startsWith(`${stem}-`)) {
        found.push(full)
      }
    }
  }

  scan(dir, 1)
  return found
}

export interface AddItemsResult {
  items: PlaylistItem[]
  errors: { path: string; message: string }[]
}

export async function createPlaylistItems(
  ffprobePath: string,
  filePaths: string[],
  defaults: { mode: SubtitleMode }
): Promise<AddItemsResult> {
  const items: PlaylistItem[] = []
  const errors: { path: string; message: string }[] = []

  for (const raw of filePaths) {
    const filePath = path.resolve(raw)
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      errors.push({ path: filePath, message: '文件不存在或无法访问' })
      continue
    }

    const info = await probeCached(ffprobePath, filePath)
    if (info.probeError && info.streams.length === 0) {
      errors.push({ path: filePath, message: info.probeError })
    }

    const tracks: SubtitleTrackRef[] = [...embeddedSubtitleRefs(info)]

    // Auto-attach sidecar subtitle files so "video + subtitles" needs one click.
    for (const subPath of findSidecarSubtitles(filePath)) {
      const ref = await probeSubtitleFile(ffprobePath, subPath)
      if (ref && !tracks.some((t) => t.id === ref.id)) tracks.push(ref)
    }

    const preferred = tracks.find((t) => t.family === 'text') ?? tracks[0] ?? null

    items.push({
      id: newId(),
      path: filePath,
      name: path.basename(filePath),
      size,
      durationSec: info.durationSec,
      subtitleTracks: tracks,
      selectedSubtitleId: preferred ? preferred.id : null,
      mode: tracks.length > 0 ? defaults.mode : 'off',
      syncOffsetSec: 0,
      subtitleDelaySec: 0,
      status: 'pending',
      broken: Boolean(info.probeError && info.streams.length === 0)
    })
  }

  return { items, errors }
}

export async function attachSubtitleFile(
  ffprobePath: string,
  item: PlaylistItem,
  subPath: string
): Promise<SubtitleTrackRef | null> {
  let size = 0
  try {
    size = fs.statSync(subPath).size
  } catch {
    return null
  }
  void size
  const existing = item.subtitleTracks.find((t) => t.source === 'external' && t.path && path.resolve(t.path) === path.resolve(subPath))
  if (existing) return existing
  const ref = await probeSubtitleFile(ffprobePath, subPath)
  return ref
}

export function reorderById(items: PlaylistItem[], orderedIds: string[]): PlaylistItem[] {
  const map = new Map(items.map((i) => [i.id, i]))
  const next: PlaylistItem[] = []
  for (const id of orderedIds) {
    const item = map.get(id)
    if (item) {
      next.push(item)
      map.delete(id)
    }
  }
  // Preserve anything the renderer did not mention.
  for (const leftover of map.values()) next.push(leftover)
  return next
}

/* ------------------------------------------------------------------ *
 * Persistence of the queue between sessions
 * ------------------------------------------------------------------ */

/** `<app>/Data/playlist.json` — see `store/paths.ts`. */
export function playlistFile(): string {
  return path.join(dataDir(), 'playlist.json')
}

export function loadPersistedPlaylist(): PlaylistItem[] {
  try {
    const raw = fs.readFileSync(playlistFile(), 'utf8')
    const parsed = JSON.parse(raw) as { items?: PlaylistItem[] }
    if (!Array.isArray(parsed.items)) return []
    return parsed.items
      .filter((i) => i && typeof i.path === 'string')
      .map((i) => ({
        ...i,
        // Nothing is "live" after a restart.
        status: 'pending' as const,
        error: undefined
      }))
  } catch {
    return []
  }
}

export function persistPlaylist(items: PlaylistItem[]): void {
  try {
    const file = playlistFile()
    ensureDir(path.dirname(file))
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error('[playlist] 保存失败:', err)
  }
}
