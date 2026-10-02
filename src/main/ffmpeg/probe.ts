import fs from 'node:fs'
import path from 'node:path'
import { runProcess } from './capabilities'
import type { MediaInfo, MediaStreamInfo, SubtitleCodecFamily, SubtitleTrackRef } from '@shared/types'

const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'text',
  'webvtt',
  'vtt',
  'sami',
  'smi',
  'realtext',
  'subviewer',
  'subviewer1',
  'mpl2',
  'jacosub',
  'microdvd',
  'pjs',
  'stl',
  'eia_608',
  'eia_708',
  'ttml'
])

const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub'])

export function classifySubtitle(codec: string): SubtitleCodecFamily {
  const c = codec.toLowerCase()
  if (TEXT_SUBTITLE_CODECS.has(c)) return 'text'
  if (BITMAP_SUBTITLE_CODECS.has(c)) return 'bitmap'
  return 'unknown'
}

interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  codec_long_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  bit_rate?: string
  sample_rate?: string
  channels?: number
  channel_layout?: string
  duration?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: {
    format_name?: string
    format_long_name?: string
    duration?: string
    size?: string
    bit_rate?: string
  }
}

function parseRate(rate?: string): number | undefined {
  if (!rate) return undefined
  const [num, den] = rate.split('/').map(Number)
  if (!num || !den || Number.isNaN(num) || Number.isNaN(den)) return undefined
  const v = num / den
  return Number.isFinite(v) && v > 0 ? v : undefined
}

function num(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function toStreamInfo(s: FfprobeStream): MediaStreamInfo {
  const typeRaw = (s.codec_type ?? 'unknown').toLowerCase()
  const type: MediaStreamInfo['type'] =
    typeRaw === 'video' || typeRaw === 'audio' || typeRaw === 'subtitle' || typeRaw === 'data' || typeRaw === 'attachment'
      ? (typeRaw as MediaStreamInfo['type'])
      : 'unknown'
  const info: MediaStreamInfo = {
    index: s.index,
    type,
    codec: s.codec_name ?? 'unknown'
  }
  if (s.codec_long_name) info.codecLong = s.codec_long_name
  if (type === 'subtitle') info.subtitleFamily = classifySubtitle(info.codec)
  if (s.width) info.width = s.width
  if (s.height) info.height = s.height
  const fps = parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate)
  if (fps) info.fps = Math.round(fps * 1000) / 1000
  const br = num(s.bit_rate)
  if (br) info.bitrate = br
  const sr = num(s.sample_rate)
  if (sr) info.sampleRate = sr
  if (s.channels) info.channels = s.channels
  if (s.channel_layout) info.channelLayout = s.channel_layout
  const tags = s.tags ?? {}
  const lang = tags.language ?? tags.LANGUAGE
  if (lang) info.language = lang
  const title = tags.title ?? tags.TITLE ?? tags.handler_name
  if (title) info.title = title
  if (s.disposition) {
    info.isDefault = Boolean(s.disposition.default)
    info.isForced = Boolean(s.disposition.forced)
    // Cover art shows up as a video stream flagged `attached_pic`; it must not be
    // mistaken for the real video track when choosing what to encode.
    if (s.disposition.attached_pic) info.attachedPic = true
  }
  return info
}

/** Run ffprobe and normalize the JSON into `MediaInfo`. */
export async function probeMedia(ffprobePath: string, filePath: string): Promise<MediaInfo> {
  const base: MediaInfo = {
    path: filePath,
    size: 0,
    durationSec: 0,
    formatName: '',
    streams: [],
    videoStreams: [],
    audioStreams: [],
    subtitleStreams: []
  }
  try {
    const st = fs.statSync(filePath)
    base.size = st.size
  } catch {
    base.probeError = '文件不存在或无法访问'
    return base
  }

  if (!ffprobePath) {
    base.probeError = '未找到 ffprobe，无法读取媒体信息'
    return base
  }

  const res = await runProcess(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_entries', 'stream=index,codec_type,codec_name,codec_long_name,width,height,avg_frame_rate,r_frame_rate,bit_rate,sample_rate,channels,channel_layout,tags,disposition:format=format_name,format_long_name,duration,size,bit_rate', filePath],
    60000
  )

  const text = res.stdout.trim()
  if (!text) {
    base.probeError = (res.stderr || 'ffprobe 未返回数据').split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
    return base
  }

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(text) as FfprobeOutput
  } catch (err) {
    base.probeError = `ffprobe JSON 解析失败: ${String(err)}`
    return base
  }

  base.streams = (parsed.streams ?? []).map(toStreamInfo)
  base.videoStreams = base.streams.filter((s) => s.type === 'video')
  base.audioStreams = base.streams.filter((s) => s.type === 'audio')
  base.subtitleStreams = base.streams.filter((s) => s.type === 'subtitle')

  const fmt = parsed.format ?? {}
  base.formatName = fmt.format_name ?? ''
  if (fmt.format_long_name) base.formatLongName = fmt.format_long_name
  const fmtBitrate = num(fmt.bit_rate)
  if (fmtBitrate) base.bitrate = fmtBitrate

  let duration = num(fmt.duration) ?? 0
  if (!duration) {
    for (const s of base.streams) {
      const d = num((s as unknown as { duration?: string }).duration)
      if (d && d > duration) duration = d
    }
  }
  base.durationSec = Math.max(0, Math.round(duration * 1000) / 1000)
  base.probeError = undefined
  return base
}

/** Internal subtitle tracks of a probed file, as selectable references. */
export function embeddedSubtitleRefs(info: MediaInfo): SubtitleTrackRef[] {
  return info.subtitleStreams.map((s) => {
    const ref: SubtitleTrackRef = {
      id: `emb:${s.index}`,
      source: 'embedded',
      streamIndex: s.index,
      codec: s.codec,
      family: s.subtitleFamily ?? classifySubtitle(s.codec)
    }
    if (s.language) ref.language = s.language
    if (s.title) ref.title = s.title
    if (s.isDefault) ref.isDefault = s.isDefault
    if (s.isForced) ref.isForced = s.isForced
    return ref
  })
}

/** Probe a sidecar subtitle file (srt/ass/vtt/sup/idx+sub) into a track reference. */
export async function probeSubtitleFile(ffprobePath: string, filePath: string): Promise<SubtitleTrackRef | null> {
  const ext = path.extname(filePath).toLowerCase()
  const fallbackFamily: SubtitleCodecFamily =
    ext === '.sup' || ext === '.sub' || ext === '.idx' ? 'bitmap' : ext === '.srt' || ext === '.ass' || ext === '.ssa' || ext === '.vtt' ? 'text' : 'unknown'

  const info = await probeMedia(ffprobePath, filePath)
  const sub = info.subtitleStreams[0]
  if (!sub) {
    // ffprobe cannot always describe idx/sub pairs; fall back to the extension.
    if (fallbackFamily === 'unknown') return null
    return {
      id: `ext:${filePath}`,
      source: 'external',
      path: filePath,
      codec: ext.replace('.', ''),
      family: fallbackFamily
    }
  }
  const ref: SubtitleTrackRef = {
    id: `ext:${filePath}`,
    source: 'external',
    path: filePath,
    codec: sub.codec,
    family: sub.subtitleFamily ?? fallbackFamily
  }
  if (sub.language) ref.language = sub.language
  const base = path.basename(filePath)
  ref.title = sub.title ?? base
  return ref
}

export function hasVideoStream(info: MediaInfo): boolean {
  return info.videoStreams.length > 0
}
