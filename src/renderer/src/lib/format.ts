import type { PlaylistItem, TranslationKey } from '@shared/types'
import type { T } from '../i18n'

/** Format seconds as `H:MM:SS` or `MM:SS`. */
export function formatDuration(totalSeconds: number | undefined | null): string {
  if (totalSeconds === undefined || totalSeconds === null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--'
  const s = Math.floor(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatBitrate(kbps: number | undefined): string {
  if (!kbps || kbps <= 0) return '—'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/**
 * Message key per ISO 639 code ffprobe reports for a subtitle track.
 *
 * The names are translated (see `format.lang.*`) because they describe the track
 * to the person choosing it, unlike the code itself. `chi`/`zho` and
 * `fra`/`fre`, `deu`/`ger` are the same language under two ISO 639-2 variants, so
 * each pair maps to two keys with identical text — kept apart so a future
 * translator can distinguish them.
 */
const LANG_KEY: Record<string, TranslationKey> = {
  chi: 'format.lang.chi',
  zho: 'format.lang.zho',
  chs: 'format.lang.chs',
  cht: 'format.lang.cht',
  eng: 'format.lang.eng',
  jpn: 'format.lang.jpn',
  kor: 'format.lang.kor',
  fra: 'format.lang.fra',
  fre: 'format.lang.fre',
  deu: 'format.lang.deu',
  ger: 'format.lang.ger',
  spa: 'format.lang.spa',
  rus: 'format.lang.rus',
  por: 'format.lang.por',
  ita: 'format.lang.ita',
  ara: 'format.lang.ara',
  tha: 'format.lang.tha',
  vie: 'format.lang.vie',
  und: 'format.lang.und'
}

/**
 * Human name for a subtitle track's language code.
 *
 * An unknown code is shown as-is in upper case: inventing a name for a language
 * the table does not know would be worse than showing the tag ffprobe reported.
 */
export function languageLabel(code: string | undefined, t: T): string {
  if (!code) return t('format.lang.unknown')
  const key = LANG_KEY[code.toLowerCase()]
  return key ? t(key) : code.toUpperCase()
}

/** Message key per playlist item status, for the status badge. */
export const STATUS_KEY: Record<PlaylistItem['status'], TranslationKey> = {
  pending: 'playlist.status.pending',
  preparing: 'app.state.preparing',
  live: 'app.state.live',
  done: 'playlist.status.done',
  skipped: 'playlist.status.skipped',
  error: 'app.state.error'
}

export function shortName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

export function dirName(p: string): string {
  const parts = p.split(/[\\/]/)
  parts.pop()
  return parts.join('\\')
}
