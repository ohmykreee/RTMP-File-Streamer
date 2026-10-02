import path from 'node:path'
import type {
  AudioSettings,
  ContainerName,
  MediaInfo,
  MediaStreamInfo,
  PlaylistItem,
  SessionSettings,
  SubtitleRenderSettings,
  SubtitleTrackRef,
  VideoCodecName,
  VideoSettings
} from '@shared/types'
import { CONTAINER_MUXER } from '@shared/defaults'
import { buildRtmpTarget } from '@shared/rtmp'
import { encoderArgFor, getAvailableEncoderNames } from './capabilities'

export interface BuildRequest {
  ffmpegPath: string
  media: MediaInfo
  item: PlaylistItem
  settings: SessionSettings
  /** Where to begin inside the file, in seconds. */
  startPositionSec: number
  /** Optional override: write to a local file instead of the configured RTMP target. */
  outputOverride?: string
}

export type SubtitleApplication = 'burn-text' | 'burn-bitmap' | 'copy' | 'none'

export interface BuiltCommand {
  args: string[]
  commandLine: string
  /** Short human readable description of the pipeline, shown in the UI. */
  summary: string[]
  warnings: string[]
  vencName: string
  aencName: string
  subtitleApplied: SubtitleApplication
  /** Seconds of material left from `startPositionSec`. */
  remainingDurationSec: number
  /** ffprobe index of the video stream that was mapped, or -1 when there is none. */
  videoStreamIndex: number
  /** ffprobe index of the audio stream that was mapped, or -1 when there is none. */
  audioStreamIndex: number
}

interface EncoderSpec {
  name: string
  kind: string
}

/* ------------------------------------------------------------------ *
 * Escaping / formatting helpers
 * ------------------------------------------------------------------ */

/**
 * Escape a filesystem path for use inside an ffmpeg filter argument.
 *
 * Two layers of parsing happen: the filtergraph parser splits on `:` and `,`
 * unless they are escaped, and it strips single quotes. A Windows path therefore
 * needs its drive-letter colon escaped, while the quotes around the value are
 * handled by the caller.
 */
export function escapeFilterPath(p: string): string {
  const s = path.resolve(p).replace(/\\/g, '/')
  // `C:/x` -> `C\:/x`; a colon is only special as the option separator.
  return s.replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** `#RRGGBB` -> libass `&HAABBGGRR`. */
function colorToAss(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  const aa = alpha.toString(16).padStart(2, '0').toUpperCase()
  if (!m) return `&H${aa}FFFFFF`
  const r = m[1].slice(0, 2).toUpperCase()
  const g = m[1].slice(2, 4).toUpperCase()
  const b = m[1].slice(4, 6).toUpperCase()
  return `&H${aa}${b}${g}${r}`
}

function buildForceStyle(s: SubtitleRenderSettings): string {
  return [
    `FontName=${s.fontName?.trim() || 'Arial'}`,
    `FontSize=${Math.max(8, Math.round(s.fontSize))}`,
    `PrimaryColour=${colorToAss(s.primaryColor)}`,
    `OutlineColour=${colorToAss(s.outlineColor)}`,
    'BorderStyle=1',
    `Outline=${Math.max(0, s.outlineWidth)}`,
    `Shadow=${Math.max(0, s.shadow)}`,
    `Alignment=${Math.max(1, Math.min(9, Math.round(s.alignment)))}`,
    `MarginV=${Math.max(0, Math.round(s.marginVertical))}`,
    `Bold=${s.bold ? -1 : 0}`,
    `Italic=${s.italic ? -1 : 0}`
  ].join(',')
}

/**
 * Build the `subtitles=` filter argument.
 *
 * The single quotes are required — without them the filtergraph parser treats
 * the commas inside `force_style` as filter separators. Colons and commas inside
 * the quoted values still have to be backslash-escaped.
 */
function subtitlesFilterArg(source: string, streamIndex: number, s: SubtitleRenderSettings): string {
  const parts: string[] = [`filename='${source}'`]
  if (streamIndex >= 0) parts.push(`si=${streamIndex}`)
  if (s.styleMode === 'force' || s.styleMode === 'plain') {
    const style = buildForceStyle(s).replace(/([,:])/g, '\\$1')
    parts.push(`force_style='${style}'`)
  }
  return `subtitles=${parts.join(':')}`
}

/**
 * Translate the resolution controls into an ffmpeg `scale` argument.
 *
 * The UI exposes a width field, a height field and an "auto" checkbox:
 *  - scaling off            -> empty string (keep the source resolution)
 *  - auto (= preserve AR)   -> `<width>:-2`, ffmpeg derives an even height
 *  - explicit               -> `<width>:<height>`
 *
 * Falls back to a plain `1920:-2` when a settings object from an older schema has
 * no usable geometry, so a stale config can never produce an invalid filter.
 */
export function resolveScaleFilter(v: VideoSettings): string {
  if (!v.scale || !v.scale.trim()) return ''
  const rawWidth = Math.round(v.scaleWidth || 0)
  const rawHeight = Math.round(v.scaleHeight || 0)
  if (rawWidth < 2) return '1920:-2'
  if (!v.scaleAuto && rawHeight < 2) return `${rawWidth}:-2`
  return v.scaleAuto ? `${rawWidth}:-2` : `${rawWidth}:${rawHeight}`
}

/* ------------------------------------------------------------------ *
 * Stream selection
 * ------------------------------------------------------------------ */

/**
 * Picks the stream to encode.
 *
 * Cover art (an `attached_pic` video stream: album/MV thumbnails) must never be
 * chosen over the real video, and neither must a stream ffprobe could not
 * describe (no codec) — that combination produces a silent audio-only stream.
 */
function pickBest(streams: MediaStreamInfo[]): MediaStreamInfo | undefined {
  const usable = streams.filter((s) => {
    if (!s.codec || s.codec === 'unknown') return false
    if (s.attachedPic) return false
    return true
  })
  if (usable.length === 0) return undefined
  const score = (s: MediaStreamInfo): number => {
    let v = 0
    if (s.isDefault) v += 1000
    const layout = (s.channelLayout ?? '').toLowerCase()
    if (s.channels === 2 || layout.includes('stereo')) v += 200
    if (s.channels && s.channels > 2 && s.channels <= 6) v += 40
    if (s.type === 'audio') v += (s.bitrate ?? 0) / 200000
    if (s.type === 'video') v += Math.min(s.width ?? 0, 3840) / 50
    return v
  }
  return [...usable].sort((a, b) => score(b) - score(a))[0]
}

/** One-line stream inventory, used in the log so "no video" cases are diagnosable. */
export function describeStreams(media: MediaInfo): string {
  if (media.streams.length === 0) return '流信息: (空)'
  const parts = media.streams.map((s) => {
    const bits = [`#${s.index}`, s.type, s.codec]
    if (s.type === 'video') bits.push(`${s.width ?? '?'}x${s.height ?? '?'}`, `${s.fps ?? '?'}fps`)
    if (s.type === 'audio') bits.push(`${s.channels ?? '?'}ch`, `${s.sampleRate ?? '?'}Hz`)
    if (s.attachedPic) bits.push('封面图')
    if (s.isDefault) bits.push('默认')
    return bits.join(' ')
  })
  return `流信息: ${parts.join(' | ')}`
}

/* ------------------------------------------------------------------ *
 * Encoder specific argument groups
 * ------------------------------------------------------------------ */

function pixelFormatFor(v: VideoSettings, spec: EncoderSpec): string {
  const requested = v.pixelFormat || 'yuv420p'
  // Hardware encoders need their own 8-bit surface formats: AMF and QSV take NV12.
  if (spec.kind === 'amf' || spec.kind === 'qsv') return requested === 'yuv420p' ? 'nv12' : requested
  return requested
}

/**
 * Builds the complete encoder-specific argument group.
 *
 * x264/x265 accept `-x264-params` / `-x265-params` only once — passing the flag
 * twice silently discards the first set — so every private option is accumulated
 * into a single dictionary and emitted exactly once at the end.
 */
function applyVideoEncoderArgs(
  args: string[],
  v: VideoSettings,
  spec: EncoderSpec,
  fps: number,
  container: ContainerName
): void {
  const gopFrames = v.keyframeIntervalSec > 0 ? Math.max(1, Math.round(fps * v.keyframeIntervalSec)) : 0
  const bf = Math.max(0, Math.min(4, v.bFrames))
  const x264: string[] = []
  const x265: string[] = []

  if (container === 'flv' && spec.name === 'libaom-av1') {
    // The FLV muxer treats AV1 as experimental; opt in explicitly.
    args.push('-strict', 'experimental')
  }

  /* ---- codec / preset / profile ---- */
  if (spec.kind === 'software') {
    if (spec.name === 'libsvtav1') {
      args.push('-preset', /^\d+$/.test(v.preset) ? v.preset : '8')
    } else if (spec.name === 'libaom-av1') {
      const numeric = /^\d+$/.test(v.preset) ? v.preset : '8'
      args.push('-cpu-used', String(Math.max(0, Math.min(8, Number(numeric)))))
      args.push('-usage', 'realtime', '-lag-in-frames', '0')
    } else if (v.preset) {
      args.push('-preset', v.preset)
    }
    if (v.tune && spec.name !== 'libsvtav1' && spec.name !== 'libaom-av1') args.push('-tune', v.tune)
    if (v.profile && (spec.name === 'libx264' || spec.name === 'libx265')) args.push('-profile:v', v.profile)
  } else if (spec.kind === 'nvenc') {
    args.push('-preset', /^p[1-7]$/.test(v.preset) ? v.preset : 'p4')
    if (v.profile && spec.name.includes('h264')) args.push('-profile:v', v.profile)
    if (v.tune === 'zerolatency') args.push('-tune', 'ull')
    args.push('-bf', String(bf))
    if (gopFrames > 0) args.push('-forced-idr', '1')
  } else if (spec.kind === 'amf') {
    const qualityMap: Record<string, string> = {
      speed: 'speed',
      ultrafast: 'speed',
      balanced: 'balanced',
      fast: 'balanced',
      quality: 'quality',
      medium: 'quality',
      slow: 'quality'
    }
    args.push('-quality', qualityMap[v.preset] ?? 'balanced')
    if (v.tune === 'zerolatency') {
      // Opt-in via tune: AMF's low-latency usage makes some streaming servers
      // (verified against mediamtx's RTSP output) drop the whole video track —
      // the RTMP side registers both tracks with an identical bitstream, yet
      // RTSP readers receive zero video RTP packets while audio keeps flowing.
      args.push('-usage', 'lowlatency')
    }
    args.push('-bf', String(bf))
    if (v.profile && spec.name.startsWith('h264')) args.push('-profile:v', v.profile)
  } else if (spec.kind === 'qsv') {
    args.push('-preset', /^(veryfast|faster|fast|medium|slow|slower)$/.test(v.preset) ? v.preset : 'medium')
    args.push('-bf', String(bf))
  }

  /* ---- rate control ---- */
  const bitrate = Math.max(100, Math.round(v.bitrateKbps))
  const buf = (fallback: number): number => (v.bufferSizeKbps > 0 ? v.bufferSizeKbps : fallback)

  if (v.rateControl === 'crf') {
    if (spec.kind === 'nvenc') {
      args.push('-rc', 'constqp', '-qp', String(Math.max(0, Math.min(51, Math.round(v.crf)))))
    } else if (spec.kind === 'amf') {
      args.push('-rc', 'cqp', '-qp_i', String(v.crf), '-qp_p', String(v.crf), '-qp_b', String(v.crf))
    } else if (spec.kind === 'qsv') {
      args.push('-global_quality', String(v.crf))
    } else if (spec.name === 'libsvtav1' || spec.name === 'libaom-av1') {
      args.push('-crf', String(v.crf), '-b:v', '0')
    } else {
      const max = v.maxBitrateKbps > 0 ? v.maxBitrateKbps : Math.max(bitrate, Math.round(bitrate * 1.5))
      args.push('-crf', String(v.crf), '-maxrate', `${max}k`, '-bufsize', `${buf(max * 2)}k`)
    }
  } else if (v.rateControl === 'cbr') {
    args.push('-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-minrate', `${bitrate}k`, '-bufsize', `${buf(bitrate)}k`)
    if (spec.kind === 'nvenc') {
      args.push('-rc', 'cbr', '-rc-lookahead', '0')
      if (spec.name.includes('h264')) args.push('-nal-hrd', 'cbr')
    } else if (spec.kind === 'amf') {
      args.push('-rc', 'cbr')
    } else if (spec.kind === 'qsv') {
      args.push('-look_ahead', '0')
    } else if (spec.name === 'libx264' || spec.name === 'libx265') {
      // Full CBR emulation so strict ingest servers stay happy.
      x264.push('nal-hrd=cbr', 'force-cfr=1')
      if (spec.name === 'libx265') x265.push('strict-cbr=1')
      args.push('-sc_threshold', '0')
    }
  } else {
    // abr / vbr / auto
    const max = Math.max(bitrate, v.maxBitrateKbps || Math.round(bitrate * 1.3))
    args.push('-b:v', `${bitrate}k`, '-maxrate', `${max}k`, '-bufsize', `${buf(max * 2)}k`)
    if (spec.kind === 'nvenc') args.push('-rc', 'vbr')
    else if (spec.kind === 'amf') args.push('-rc', 'vbr_peak')
  }

  /* ---- keyframes (kept in one place so nothing overrides the GOP) ---- */
  if (gopFrames > 0) {
    args.push('-g', String(gopFrames), '-keyint_min', String(gopFrames))
    if (spec.name === 'libx264' || spec.name === 'libx265') {
      x264.push(`keyint=${gopFrames}`, `min-keyint=${gopFrames}`, 'scenecut=0')
      args.push('-sc_threshold', '0')
    }
  }

  if (spec.name === 'libx264' || spec.name === 'libx265') {
    x264.push(`bframes=${bf}`, `rc-lookahead=${Math.max(0, Math.min(60, Math.round(fps / 2)))}`)
  }

  /* ---- private option dictionaries, emitted once ---- */
  if (x264.length > 0 && (spec.name === 'libx264' || spec.name === 'libx265')) {
    args.push('-x264-params', [...new Set(x264)].join(':'))
  }
  if (x265.length > 0 && spec.name === 'libx265') {
    args.push('-x265-params', [...new Set(x265)].join(':'))
  }
}

/** Appends audio encoder args, returns the ffmpeg encoder name used. */
function applyAudioArgs(args: string[], a: AudioSettings, filters: string[], sourceChannels: number): string {
  const enc = a.codec === 'libopus' ? 'libopus' : a.codec === 'libmp3lame' ? 'libmp3lame' : 'aac'
  const targetRate = enc === 'libopus' ? 48000 : a.sampleRate || 44100
  const targetCh = Math.max(1, Math.min(2, a.channels || 2))

  if (sourceChannels > targetCh && targetCh === 1) filters.push('pan=mono|c0=0.5*c0+0.5*c1')
  if (enc === 'libopus') filters.push('aresample=48000')
  else filters.push(`aresample=${targetRate}`)
  if (enc === 'aac' || enc === 'libmp3lame') {
    filters.push(`aformat=sample_fmts=fltp:channel_layouts=${targetCh === 1 ? 'mono' : 'stereo'}`)
  }

  args.push('-c:a', enc)
  if (a.rateControl === 'vbr' && enc !== 'libopus') args.push('-q:a', enc === 'aac' ? '1.2' : '2')
  else args.push('-b:a', `${Math.max(16, Math.round(a.bitrateKbps))}k`)
  args.push('-ac', String(targetCh), '-ar', String(targetRate))
  return enc
}

/**
 * Enhanced-RTMP notice for FLV targets using a non-H.264 video codec.
 *
 * FFmpeg's FLV muxer writes HEVC as FourCC `hvc1` and AV1 as `av01` — the
 * Enhanced-RTMP format — but whether the stream actually plays depends on the
 * ingest server and the player supporting Enhanced-RTMP. Without that support
 * the video track is dropped or left undecodable, so the user must be told
 * rather than left guessing why the picture is black.
 */
function flvCodecWarning(codec: VideoCodecName, container: ContainerName): string | null {
  if (container !== 'flv') return null
  if (codec === 'hevc') return 'HEVC 通过 Enhanced-RTMP（hvc1）推流，需要服务器与播放器支持 Enhanced-RTMP，否则画面会黑屏/无视频。'
  if (codec === 'av1') return 'AV1 通过 Enhanced-RTMP（av01）推流，需要服务器与播放器支持 Enhanced-RTMP，否则画面会黑屏/无视频。'
  return null
}

/* ------------------------------------------------------------------ *
 * Main builder
 * ------------------------------------------------------------------ */

export function buildStreamCommand(req: BuildRequest): BuiltCommand {
  const { item, settings, media, startPositionSec } = req
  const v = settings.video
  const a = settings.audio
  const sub = settings.subtitles
  const out = settings.output

  const warnings: string[] = []
  const summary: string[] = []
  const available = getAvailableEncoderNames()

  const totalDuration = media.durationSec > 0 ? media.durationSec : item.durationSec
  const startPos = Math.max(0, Math.min(startPositionSec, Math.max(0, totalDuration - 0.2)))
  const remaining = totalDuration > 0 ? Math.max(0, totalDuration - startPos) : 0
  const copyVideo = v.codec === 'copy'

  const videoIn = pickBest(media.videoStreams)
  const audioIn = pickBest(media.audioStreams)

  /* ---------------- subtitle selection ---------------- */
  const mode = item.mode ?? sub.mode
  let track: SubtitleTrackRef | null = null
  if (mode !== 'off') {
    if (item.selectedSubtitleId) track = item.subtitleTracks.find((t) => t.id === item.selectedSubtitleId) ?? null
    if (!track && item.subtitleTracks.length > 0) track = item.subtitleTracks.find((t) => t.family === 'text') ?? item.subtitleTracks[0]
    if (!track && media.subtitleStreams.length > 0) {
      const s0 = media.subtitleStreams[0]
      track = { id: `emb:${s0.index}`, source: 'embedded', streamIndex: s0.index, codec: s0.codec, family: s0.subtitleFamily ?? 'unknown' }
    }
  }
  const isTextTrack = track
    ? track.family === 'text' || (track.family === 'unknown' && !/(pgs|dvd|dvb|xsub|hdmv)/i.test(track.codec))
    : false
  const hasExternalSub = track?.source === 'external' && !!track.path
  const burnBitmapExternal = mode === 'burn' && !!track && !isTextTrack && hasExternalSub && !copyVideo && !!videoIn

  /* ---------------- timestamp offsets ---------------- */
  const avOffset = item.syncOffsetSec || 0
  const subDelay = item.subtitleDelaySec || 0
  // Embedded subtitle streams ride inside input 0, so their delay folds into the A/V offset.
  // A single `-itsoffset` shifts video, audio and embedded subtitles together; a
  // negative value simply drops the leading frames.
  const internalOffset = avOffset + subDelay
  const hasOffset = Math.abs(internalOffset) > 0.0005

  /* ---------------- inputs ---------------- */
  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'info']
  if (out.realtimePacing) args.push('-re')
  if (startPos > 0.05) {
    args.push('-ss', String(round2(startPos)))
    args.push(out.seekAccuracy === 'accurate' ? '-accurate_seek' : '-noaccurate_seek')
    summary.push(`起点 ${round2(startPos)}s`)
  }
  if (hasOffset) {
    // `-itsoffset` shifts video, audio and embedded subtitles together.
    // Measured behaviour (no `-copyts`): a negative offset trims the head and the
    // stream still starts at 0; a positive offset delays everything, so the muxed
    // stream opens with that much empty timeline before the first frame.
    args.push('-itsoffset', String(round2(internalOffset)))
    summary.push(`音视频/字幕偏移 ${round2(internalOffset)}s`)
    if (internalOffset > 0) {
      warnings.push(
        `偏移 +${round2(internalOffset)}s 会延后所有内容，推流开头会有约 ${round2(internalOffset)} 秒的空档（黑屏/无声）等待缓冲。若只是想修正音画不同步，建议改用负值提前内容。`
      )
    }
  }
  args.push('-fflags', '+genpts', '-i', item.path)

  let externalSubInput = -1
  if (mode === 'burn' && track && hasExternalSub) {
    // The sidecar carries the same shift so it stays aligned with the video.
    if (hasOffset) args.push('-itsoffset', String(round2(internalOffset)))
    args.push('-i', track.path!)
    externalSubInput = 1
    summary.push(`${isTextTrack ? '烧录' : '叠加'}外部字幕 ${path.basename(track.path!)}`)
  }

  /* ---------------- video filters ---------------- */
  const filters: string[] = []
  const scaleFilter = resolveScaleFilter(v)
  const sourceFps = videoIn?.fps ?? 0
  const wantsFps = !copyVideo && v.fps > 0 && Math.abs(sourceFps - v.fps) > 0.05

  if (!copyVideo) {
    if (scaleFilter) {
      filters.push(`scale=${scaleFilter}:flags=bicubic`)
      summary.push(`缩放 ${scaleFilter}`)
    }
    if (wantsFps) {
      filters.push(`fps=${v.fps}`)
      summary.push(`${v.fps} fps`)
    }
  } else if (scaleFilter || wantsFps || v.rateControl === 'crf') {
    warnings.push('视频为“直接复制”模式，缩放/帧率/码率设置已忽略。')
  }

  /* Burn-in runs last so font sizes match the output resolution. */
  let burnText = false
  if (mode === 'burn' && track && isTextTrack) {
    if (copyVideo) {
      warnings.push('视频为“直接复制”模式，无法烧录字幕；如需字幕请改为重新编码。')
    } else if (track.source === 'embedded') {
      filters.push(subtitlesFilterArg('0', track.streamIndex ?? -1, sub))
      burnText = true
    } else if (externalSubInput >= 0 && track.path) {
      // libass reads the sidecar directly from disk; the extra input only feeds
      // the bitmap-overlay path below.
      filters.push(subtitlesFilterArg(escapeFilterPath(track.path), -1, sub))
      burnText = true
    }
    if (burnText) summary.push(`烧录字幕${track.source === 'embedded' ? ` (内挂 #${track.streamIndex})` : ''}`)
  } else if (mode === 'burn' && track && !isTextTrack && !hasExternalSub && !copyVideo) {
    warnings.push('内挂位图字幕（PGS/DVD/DVB）无法用滤镜烧录，已跳过字幕。')
  }

  const videoFilterChain = filters.join(',')
  const audioFilters: string[] = []

  /* ---------------- stream mapping ---------------- */
  // Streams are mapped by their absolute ffprobe index, not by `0:v:0`-style
  // specifiers: the first video stream can be cover art (attached_pic) while
  // `pickBest` selected the real track, and the two must not diverge.
  if (burnBitmapExternal) {
    const base = videoFilterChain || 'null'
    const graph = `[0:${videoIn!.index}]${base}[vbase];[vbase][${externalSubInput}:v]overlay=eof_action=pass:repeatlast=0[vout]`
    args.push('-filter_complex', graph)
    args.push('-map', '[vout]')
    summary.push('位图字幕 overlay 合成')
  } else if (videoIn) {
    args.push('-map', `0:${videoIn.index}`)
    if (videoFilterChain) args.push('-vf', videoFilterChain)
  }
  if (audioIn && a.codec !== 'none') args.push('-map', `0:${audioIn.index}`)

  /* ---------------- video encoder ---------------- */
  const spec: EncoderSpec = copyVideo ? { name: 'copy', kind: 'copy' } : encoderArgFor(v.encoder, v.codec, available)
  let vencName = 'copy'
  const flvWarn = flvCodecWarning(v.codec, out.container)
  if (flvWarn) warnings.push(flvWarn)

  if (copyVideo) {
    args.push('-c:v', 'copy')
    summary.unshift('视频：直接复制 (不重编码)')
  } else if (!videoIn) {
    warnings.push('源文件没有可用的视频轨（或只有封面图），将只推送音频。')
  } else {
    vencName = spec.name
    args.push('-c:v', spec.name, '-pix_fmt', pixelFormatFor(v, spec))
    const fpsForGop = v.fps > 0 ? v.fps : Math.min(120, Math.max(10, Math.round(sourceFps || 30)))
    applyVideoEncoderArgs(args, v, spec, fpsForGop, out.container)
    if (v.repeatHeaders && out.container === 'flv') args.push('-flags', '+cgop')
    const hw = spec.kind === 'software' ? '' : ' [硬件]'
    summary.unshift(`视频：${spec.name}${hw} · ${v.rateControl.toUpperCase()}${v.rateControl === 'crf' ? ` CRF ${v.crf}` : ` ${v.bitrateKbps}kbps`}`)
    if (spec.kind === 'software' && v.bitrateKbps > 12000) {
      warnings.push(`软件编码 ${spec.name} 在高码率下可能无法实时编码，建议改用硬件编码器或降低码率。`)
    }
    if (spec.kind === 'amf' && v.tune === 'zerolatency') {
      warnings.push('AMF 低延迟模式（tune=zerolatency）与部分流媒体服务器不兼容，如遇黑屏请把 tune 改为「不设置」。')
    }
  }

  /* ---------------- audio encoder ---------------- */
  let aencName = 'none'
  if (a.codec === 'none') {
    summary.push('音频：丢弃')
  } else if (!audioIn) {
    warnings.push('源文件没有音频轨，将只推送视频。')
  } else if (a.codec === 'copy') {
    aencName = 'copy'
    args.push('-c:a', 'copy')
    summary.push('音频：直接复制')
  } else {
    if (a.loudnorm) {
      audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      summary.push('响度归一化 -16 LUFS')
    }
    aencName = applyAudioArgs(args, a, audioFilters, audioIn.channels ?? 2)
    summary.push(`音频：${aencName} ${a.bitrateKbps}kbps @ ${a.codec === 'libopus' ? 48000 : a.sampleRate}Hz`)
  }
  if (audioFilters.length > 0) args.push('-af', audioFilters.join(','))

  if (out.container === 'flv' && aencName === 'libopus') {
    warnings.push('FLV/RTMP 对 Opus 支持很差，多数服务器无法播放，建议改用 AAC。')
  }
  if (out.container === 'mpegts' && aencName === 'aac') args.push('-bsf:a', 'aac_adtstoasc')

  /* ---------------- subtitle handling result ---------------- */
  let subtitleApplied: SubtitleApplication = 'none'
  if (mode === 'burn' && track && !copyVideo) {
    if (burnText) subtitleApplied = 'burn-text'
    else if (burnBitmapExternal) subtitleApplied = 'burn-bitmap'
  } else if (mode === 'copy' && track) {
    if (!isTextTrack) {
      warnings.push('位图字幕（PGS/DVD/DVB）无法作为独立轨道在 RTMP/FLV 中传输，已跳过。')
    } else if (track.source === 'embedded') {
      args.push('-map', `0:${track.streamIndex}`, '-c:s', 'copy')
      subtitleApplied = 'copy'
      summary.push('字幕：复制轨道')
      if (out.container === 'flv') warnings.push('FLV/RTMP 通常不转发字幕轨；如需字幕请使用“烧录”模式。')
    } else {
      warnings.push('外部字幕文件无法作为独立轨道推流，请改用“烧录”模式。')
    }
  }

  /* ---------------- muxing / output ---------------- */
  if (out.dropLateFrames) args.push('-fflags', '+genpts+igndts', '-max_delay', '0')
  args.push('-max_interleave_delta', '0')
  if (out.container === 'flv') args.push('-flvflags', 'no_duration_filesize')
  if (out.extraOutputArgs.trim()) args.push(...out.extraOutputArgs.trim().split(/\s+/))
  args.push('-progress', 'pipe:1', '-nostats')

  const format = CONTAINER_MUXER[out.container]
  const target = req.outputOverride ?? buildRtmpTarget(out.server, out.streamKey)
  if (!req.outputOverride) {
    // Let ffmpeg retry the socket instead of tearing the whole pipeline down.
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', String(Math.max(1, out.reconnectDelaySec)))
  }
  args.push('-f', format, target)

  return {
    args,
    commandLine: buildCommandLine(req.ffmpegPath, args),
    summary,
    warnings,
    vencName,
    aencName,
    subtitleApplied,
    remainingDurationSec: remaining,
    videoStreamIndex: videoIn ? videoIn.index : -1,
    audioStreamIndex: audioIn && a.codec !== 'none' ? audioIn.index : -1
  }
}

/**
 * Builds just the *codec* side of the pipeline: filters, stream mapping and
 * encoder options, with no input, muxer or destination arguments.
 *
 * This is the half of {@link buildStreamCommand} that the two-process playout
 * needs for its encoder pass — the pass writes MPEG-TS to a buffer file, so the
 * RTMP target, `-re` pacing and container flags all belong to the pusher instead.
 */
export function buildEncoderArgs(req: Omit<BuildRequest, 'outputOverride'>): {
  args: string[]
  summary: string[]
  warnings: string[]
  vencName: string
} {
  const { item, settings, media } = req
  const v = settings.video
  const a = settings.audio
  const sub = settings.subtitles
  const out = settings.output
  const available = getAvailableEncoderNames()
  const warnings: string[] = []
  const summary: string[] = []
  const args: string[] = []

  const copyVideo = v.codec === 'copy'
  const videoIn = pickBest(media.videoStreams)
  const audioIn = pickBest(media.audioStreams)

  /* ---- subtitle selection (same rules as the single-process builder) ---- */
  const mode = item.mode ?? sub.mode
  let track: SubtitleTrackRef | null = null
  if (mode !== 'off') {
    if (item.selectedSubtitleId) track = item.subtitleTracks.find((t) => t.id === item.selectedSubtitleId) ?? null
    if (!track && item.subtitleTracks.length > 0) track = item.subtitleTracks.find((t) => t.family === 'text') ?? item.subtitleTracks[0]
    if (!track && media.subtitleStreams.length > 0) {
      const s0 = media.subtitleStreams[0]
      track = { id: `emb:${s0.index}`, source: 'embedded', streamIndex: s0.index, codec: s0.codec, family: s0.subtitleFamily ?? 'unknown' }
    }
  }
  const isTextTrack = track
    ? track.family === 'text' || (track.family === 'unknown' && !/(pgs|dvd|dvb|xsub|hdmv)/i.test(track.codec))
    : false

  const avOffset = item.syncOffsetSec || 0
  const subDelay = item.subtitleDelaySec || 0
  const internalOffset = avOffset + subDelay
  const hasOffset = Math.abs(internalOffset) > 0.0005

  const filters: string[] = []
  const scaleFilter = resolveScaleFilter(v)
  const sourceFps = videoIn?.fps ?? 0
  const wantsFps = !copyVideo && v.fps > 0 && Math.abs(sourceFps - v.fps) > 0.05
  if (!copyVideo) {
    if (scaleFilter) {
      filters.push(`scale=${scaleFilter}:flags=bicubic`)
      summary.push(`缩放 ${scaleFilter}`)
    }
    if (wantsFps) {
      filters.push(`fps=${v.fps}`)
      summary.push(`${v.fps} fps`)
    }
  }

  let burnText = false
  if (mode === 'burn' && track && isTextTrack && !copyVideo) {
    if (track.source === 'embedded') {
      filters.push(subtitlesFilterArg('0', track.streamIndex ?? -1, sub))
      burnText = true
    } else if (track.path) {
      filters.push(subtitlesFilterArg(escapeFilterPath(track.path), -1, sub))
      burnText = true
    }
    if (burnText) summary.push(`烧录字幕${track.source === 'embedded' ? ` (内挂 #${track.streamIndex})` : ''}`)
  }
  if (hasOffset && internalOffset > 0) {
    warnings.push(`偏移 +${round2(internalOffset)}s 会延后所有内容，推流开头会有约 ${round2(internalOffset)} 秒的空档等待缓冲。`)
  }

  /* ---- mapping ---- */
  if (videoIn) {
    args.push('-map', `0:${videoIn.index}`)
    if (filters.length > 0) args.push('-vf', filters.join(','))
  }
  if (audioIn && a.codec !== 'none') args.push('-map', `0:${audioIn.index}`)

  /* ---- video encoder ---- */
  const spec: EncoderSpec = copyVideo ? { name: 'copy', kind: 'copy' } : encoderArgFor(v.encoder, v.codec, available)
  const flvWarn = flvCodecWarning(v.codec, out.container)
  if (flvWarn) warnings.push(flvWarn)
  if (copyVideo) {
    args.push('-c:v', 'copy')
    summary.unshift('视频：直接复制 (不重编码)')
  } else if (!videoIn) {
    warnings.push('源文件没有可用的视频轨，将只推送音频。')
  } else {
    args.push('-c:v', spec.name, '-pix_fmt', pixelFormatFor(v, spec))
    const fpsForGop = v.fps > 0 ? v.fps : Math.min(120, Math.max(10, Math.round(sourceFps || 30)))
    applyVideoEncoderArgs(args, v, spec, fpsForGop, out.container)
    if (v.repeatHeaders) args.push('-flags', '+cgop')
    const hw = spec.kind === 'software' ? '' : ' [硬件]'
    summary.unshift(`视频：${spec.name}${hw} · ${v.rateControl.toUpperCase()}${v.rateControl === 'crf' ? ` CRF ${v.crf}` : ` ${v.bitrateKbps}kbps`}`)
  }

  /* ---- audio encoder ---- */
  const audioFilters: string[] = []
  if (a.codec === 'none') {
    summary.push('音频：丢弃')
  } else if (!audioIn) {
    warnings.push('源文件没有音频轨，将只推送视频。')
  } else if (a.codec === 'copy') {
    args.push('-c:a', 'copy')
    summary.push('音频：直接复制')
  } else {
    if (a.loudnorm) {
      audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      summary.push('响度归一化 -16 LUFS')
    }
    const enc = applyAudioArgs(args, a, audioFilters, audioIn.channels ?? 2)
    summary.push(`音频：${enc} ${a.bitrateKbps}kbps @ ${a.codec === 'libopus' ? 48000 : a.sampleRate}Hz`)
  }
  if (audioFilters.length > 0) args.push('-af', audioFilters.join(','))

  return { args, summary, warnings, vencName: copyVideo ? 'copy' : spec.name }
}

/** Quote an argument vector for display / copy-paste. */
export function buildCommandLine(bin: string, args: string[]): string {
  const quote = (s: string): string => {
    if (s === '') return '""'
    if (!/[\s"'\\$`|&<>^]/.test(s)) return s
    return `"${s.replace(/"/g, '\\"')}"`
  }
  return [quote(bin), ...args.map(quote)].join(' ')
}

/** Synthetic lavfi source used by the "test connection" action. */
export function buildTestCommand(settings: SessionSettings, url: string, streamKey: string): string[] {
  const a = settings.audio
  const aenc = a.codec === 'none' || a.codec === 'copy' ? 'aac' : a.codec === 'libopus' ? 'libopus' : a.codec === 'libmp3lame' ? 'libmp3lame' : 'aac'
  const target = buildRtmpTarget(url, streamKey)
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=5',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-b:v',
    '1000k',
    '-maxrate',
    '1000k',
    '-bufsize',
    '2000k',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-c:a',
    aenc,
    '-b:a',
    '128k',
    '-ar',
    aenc === 'libopus' ? '48000' : '44100',
    '-ac',
    '2',
    '-f',
    CONTAINER_MUXER[settings.output.container],
    target
  ]
}
