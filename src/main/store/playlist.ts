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
 * How many leading characters the two cleaned names must share.
 *
 * Exact-name matching is too strict in practice: a release folder typically holds
 * `Show.S01E01.mkv` next to `Show.S01E01.chs.srt` / `.cht.srt` / `.简体.srt`, and
 * those qualifier suffixes are exactly what has to be tolerated. The comparison
 * therefore happens on the name with its language/edition tokens removed, and the
 * shared part must still be long enough to identify the file — which is what stops
 * `…S01E01` from matching `…S01E02`.
 */
const SIDECAR_MIN_SHARED_CHARS = 6

/** Qualifier tokens carrying no identifying information, stripped before comparing. */
const SUBTITLE_QUALIFIER_RE =
  /(?:^|[._\-\s])(chs|cht|cn|zh|zho|chi|hans|hant|sc|tc|简体|繁体|简|繁|中文|双语|中英|英文|english|eng|jpn|jp|japanese|kor|kr|korean|forced|sdh|cc|full|default)(?=$|[._\-\s])/i

/**
 * The identifying part of a filename: everything before the first qualifier token,
 * lower-cased and without trailing separators. `Show.S01E01.chs.srt` →
 * `show.s01e01`.
 */
export function stemPrefix(name: string): string {
  const stem = path.basename(name, path.extname(name)).toLowerCase()
  const match = new RegExp(SUBTITLE_QUALIFIER_RE.source, 'i').exec(stem)
  return (match ? stem.slice(0, match.index) : stem).replace(/[._\-\s]+$/, '')
}

/**
 * True when `subtitleName` looks like a sidecar of `videoName`.
 *
 * Two ways to qualify:
 *  1. the subtitle stem is the video stem, or the video stem followed by a
 *     separator (`movie.srt`, `movie.zh-CN.srt`) — the original rules;
 *  2. after dropping language/edition tokens from the subtitle name, the two share
 *     at least {@link SIDECAR_MIN_SHARED_CHARS} characters and one is a prefix of
 *     the other, so `Show.S01E01.1080p` pairs with `Show.S01E01.chs` but not with
 *     `Show.S01E02.chs`.
 */
export function subtitleMatchesVideo(videoName: string, subtitleName: string): boolean {
  const videoStem = path.basename(videoName, path.extname(videoName)).toLowerCase().replace(/[._\-\s]+$/, '')
  const subStem = path.basename(subtitleName, path.extname(subtitleName)).toLowerCase()
  if (!videoStem || !subStem) return false
  if (subStem === videoStem || subStem.startsWith(`${videoStem}.`) || subStem.startsWith(`${videoStem}_`) || subStem.startsWith(`${videoStem}-`)) {
    return true
  }
  const videoPrefix = stemPrefix(videoName)
  const subPrefix = stemPrefix(subtitleName)
  if (!videoPrefix || !subPrefix) return false
  const shorter = videoPrefix.length <= subPrefix.length ? videoPrefix : subPrefix
  const longer = shorter === videoPrefix ? subPrefix : videoPrefix
  return shorter.length >= SIDECAR_MIN_SHARED_CHARS && longer.startsWith(shorter)
}

/**
 * Sidecar subtitle files that belong to `videoPath`: a shared name prefix plus any
 * language/qualifier suffix, plus `Subs/`-style sibling folders.
 */
export function findSidecarSubtitles(videoPath: string): string[] {
  const dir = path.dirname(videoPath)
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
      if (subtitleMatchesVideo(videoPath, entry.name)) found.push(full)
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
