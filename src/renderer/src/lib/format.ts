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

const LANG_NAMES: Record<string, string> = {
  chi: '中文',
  zho: '中文',
  chs: '简体中文',
  cht: '繁体中文',
  eng: '英语',
  jpn: '日语',
  kor: '韩语',
  fra: '法语',
  fre: '法语',
  deu: '德语',
  ger: '德语',
  spa: '西班牙语',
  rus: '俄语',
  por: '葡萄牙语',
  ita: '意大利语',
  ara: '阿拉伯语',
  tha: '泰语',
  vie: '越南语',
  und: '未标注'
}

export function languageLabel(code: string | undefined): string {
  if (!code) return '未标注'
  return LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase()
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
