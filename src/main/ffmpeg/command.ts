import path from 'node:path'
import type {
  AudioSettings,
  ContainerName,
  Language,
  MediaInfo,
  MediaStreamInfo,
  PlaylistItem,
  SessionSettings,
  StreamProtocol,
  SubtitleRenderSettings,
  SubtitleTrackRef,
  VideoCodecName,
  VideoSettings
} from '@shared/types'
import type { Translate, TranslationKey } from '@shared/i18n'
import { translatorFor } from '@shared/i18n'
import {
  buildPushTarget,
  containerForProtocol,
  DEFAULT_STREAM_PROTOCOL,
  muxerForProtocol,
  networkForProtocol,
  protocolKeyArgs
} from '@shared/protocol'
import { encoderArgFor, getAvailableEncoderNames } from './capabilities'

/**
 * Language used when a caller does not name one.
 *
 * Not a preference — a compatibility default. The strings this module produces are
 * the `summary` / `warnings` / `notes` diagnostics, and the offline test harness
 * asserts on their wording, so the builder only localizes when it is told which
 * language to write in. The application always passes the active one; leaving it
 * out yields the original Chinese, which is also what those tests expect.
 */
export const DEFAULT_COMMAND_LANGUAGE: Language = 'zh'

export interface BuildRequest {
  ffmpegPath: string
  media: MediaInfo
  item: PlaylistItem
  settings: SessionSettings
  /** Where to begin inside the file, in seconds. */
  startPositionSec: number
  /** Optional override: write to a local file instead of the configured RTMP target. */
  outputOverride?: string
  /** Language for the summary and warning text; defaults to {@link DEFAULT_COMMAND_LANGUAGE}. */
  language?: Language
}

export type SubtitleApplication = 'burn-text' | 'burn-bitmap' | 'copy' | 'none'

/** The stream indexes a built command actually mapped, for the diagnostics in the log. */
export interface MappedStreams {
  /** ffprobe index of the video stream that was mapped, or -1 when there is none. */
  videoStreamIndex: number
  /** ffprobe index of the audio stream that was mapped, or -1 when there is none. */
  audioStreamIndex: number
}

/**
 * Which source streams a command maps.
 *
 * Shared by both builders so the reported indexes cannot drift from what the
 * mapping does: `-an` (audio codec `none`) means no audio stream is mapped even
 * when the file has one, and a subtitle-only file maps no video at all.
 */
function mappedStreamIndexes(
  videoIn: MediaStreamInfo | null | undefined,
  audioIn: MediaStreamInfo | null | undefined,
  audioCodec: string
): MappedStreams {
  return {
    videoStreamIndex: videoIn ? videoIn.index : -1,
    audioStreamIndex: audioIn && audioCodec !== 'none' ? audioIn.index : -1
  }
}

export interface BuiltCommand extends MappedStreams {
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
}

/** What {@link buildEncoderArgs} produces: the args plus enough context to log the choice. */
export interface BuiltEncoderArgs extends MappedStreams {
  args: string[]
  summary: string[]
  warnings: string[]
  vencName: string
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
 * `source` is a path libass opens for itself, and `streamIndex` is an index among
 * THAT file's *subtitle* streams (see {@link resolveTextBurnSource}) — it is not
 * ffprobe's absolute stream index and not an ffmpeg input number.
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

/** A file libass should read for a text burn-in, plus which of its tracks to use. */
interface TextBurnSource {
  /** Path of the file handed to libass, escaped for the filtergraph. */
  filename: string
  /** Index among that file's subtitle streams (`si`), or -1 for its first one. */
  streamIndex: number
}

/**
 * Decide what a text burn-in reads from, and which subtitle stream inside it.
 *
 * The `subtitles` filter opens a file of its own, so a track that is muxed into the
 * media has to be read back out of the media file — with its index translated into
 * that file's subtitle numbering. Both halves of that were wrong and each fails on
 * its own, measured on a file laid out `0:v 1:a 2:s`:
 *  - `filename='0'`, the shape that shipped, makes libass try to open a file named
 *    `0` ("Unable to open 0"), which aborts filter init and with it the whole
 *    encode — every embedded-subtitle item died about a second after it started;
 *  - `si` counts subtitle streams, not ffprobe indexes: on `0:v 1:a 2:s 3:s`,
 *    `si=2` is rejected with "Unable to locate subtitle stream" while `si=0`
 *    renders stream 2 and `si=1` renders stream 3.
 *
 * Returns null when an embedded track cannot be found in the probed subtitle
 * streams — the caller skips the burn and says so rather than quietly rendering a
 * different language than the one that was picked.
 */
function resolveTextBurnSource(media: MediaInfo, filePath: string, track: SubtitleTrackRef): TextBurnSource | null {
  if (track.source === 'external') {
    return track.path ? { filename: escapeFilterPath(track.path), streamIndex: -1 } : null
  }
  if (track.streamIndex === undefined) return null
  const relative = media.subtitleStreams.findIndex((s) => s.index === track.streamIndex)
  if (relative < 0) return null
  return { filename: escapeFilterPath(filePath), streamIndex: relative }
}

/** What to tell the user when {@link resolveTextBurnSource} found nothing to read. */
function burnSourceMissingWarning(track: SubtitleTrackRef, t: Translate<TranslationKey>): string {
  return track.source === 'embedded'
    ? t('main.cmd.burnSourceMissingEmbedded', { n: track.streamIndex ?? '?' })
    : t('main.cmd.burnSourceMissingExternal')
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
export function describeStreams(media: MediaInfo, language: Language = DEFAULT_COMMAND_LANGUAGE): string {
  const t = translatorFor(language)
  if (media.streams.length === 0) return t('main.cmd.streamsEmpty')
  const parts = media.streams.map((s) => {
    const bits = [`#${s.index}`, s.type, s.codec]
    if (s.type === 'video') bits.push(`${s.width ?? '?'}x${s.height ?? '?'}`, `${s.fps ?? '?'}fps`)
    if (s.type === 'audio') bits.push(`${s.channels ?? '?'}ch`, `${s.sampleRate ?? '?'}Hz`)
    if (s.attachedPic) bits.push(t('main.cmd.attachedPic'))
    if (s.isDefault) bits.push(t('main.cmd.streamDefault'))
    return bits.join(' ')
  })
  return t('main.cmd.streams', { list: parts.join(' | ') })
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
  container: ContainerName | null
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
function flvCodecWarning(codec: VideoCodecName, container: ContainerName | null, t: Translate<TranslationKey>): string | null {
  if (container !== 'flv') return null
  if (codec === 'hevc') return t('main.cmd.hevcEnhancedRtmp')
  if (codec === 'av1') return t('main.cmd.av1EnhancedRtmp')
  return null
}

/**
 * Codec warning for WHIP targets.
 *
 * WebRTC ingest only accepts the codecs the WebRTC stack can carry, and ffmpeg's
 * WHIP muxer does not transcode: H.264 video and Opus audio. Anything else fails
 * at the server (or produces a stream no player can render), which is far less
 * clear than saying so up front.
 */
function whipCodecWarning(
  protocol: StreamProtocol | undefined,
  v: VideoSettings,
  a: AudioSettings,
  t: Translate<TranslationKey>
): string | null {
  if ((protocol ?? DEFAULT_STREAM_PROTOCOL) !== 'whip') return null
  if (v.codec !== 'h264') return t('main.cmd.whipNeedsH264')
  if (a.codec !== 'libopus' && a.codec !== 'none') return t('main.cmd.whipNeedsOpus')
  return null
}

/**
 * Renders the encoder description used by every summary line.
 *
 * Split into key + two templates rather than one sprintf-style string: the mode
 * half ("CRF 20" / "6000kbps") is a different phrase in each language position, and
 * building it here keeps that decision in one place instead of three.
 */
function videoSummary(t: Translate<TranslationKey>, encoder: string, hw: string, v: VideoSettings): string {
  const mode =
    v.rateControl === 'crf'
      ? t('main.cmd.summaryVideoModeCrf', { crf: v.crf })
      : t('main.cmd.summaryVideoModeBitrate', { kbps: v.bitrateKbps })
  return t('main.cmd.summaryVideo', { encoder, hw, mode: `${v.rateControl.toUpperCase()} ${mode}` })
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
  const t = translatorFor(req.language ?? DEFAULT_COMMAND_LANGUAGE)
  // The protocol decides the muxer and the container-specific behaviour; the
  // container itself is no longer a free choice (see `protocol.ts`). `?? rtmp`
  // covers settings objects from older schemas.
  const protocol: StreamProtocol = out.protocol ?? DEFAULT_STREAM_PROTOCOL
  const effContainer = containerForProtocol(protocol)

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
    // Seeking accuracy is left at ffmpeg's default (frame accurate) now that the
    // per-item accuracy setting is gone. Restarts are the only thing that seek
    // inside a file — the playlist starts every entry at its beginning.
    args.push('-ss', String(round2(startPos)))
    summary.push(t('main.cmd.summaryStart', { time: round2(startPos) }))
  }
  if (hasOffset) {
    // `-itsoffset` shifts video, audio and embedded subtitles together.
    // Measured behaviour (no `-copyts`): a negative offset trims the head and the
    // stream still starts at 0; a positive offset delays everything, so the muxed
    // stream opens with that much empty timeline before the first frame.
    args.push('-itsoffset', String(round2(internalOffset)))
    summary.push(t('main.cmd.summaryOffset', { time: round2(internalOffset) }))
    if (internalOffset > 0) {
      warnings.push(t('main.cmd.offsetPositive', { sec: round2(internalOffset) }))
    }
  }
  args.push('-fflags', '+genpts', '-i', item.path)

  let externalSubInput = -1
  if (mode === 'burn' && track && hasExternalSub) {
    // The sidecar carries the same shift so it stays aligned with the video.
    if (hasOffset) args.push('-itsoffset', String(round2(internalOffset)))
    args.push('-i', track.path!)
    externalSubInput = 1
    summary.push(
      t('main.cmd.summaryExternalSub', {
        mode: t(isTextTrack ? 'main.cmd.subModeBurn' : 'main.cmd.subModeOverlay'),
        name: path.basename(track.path!)
      })
    )
  }

  /* ---------------- video filters ---------------- */
  const filters: string[] = []
  const scaleFilter = resolveScaleFilter(v)
  const sourceFps = videoIn?.fps ?? 0
  const wantsFps = !copyVideo && v.fps > 0 && Math.abs(sourceFps - v.fps) > 0.05

  if (!copyVideo) {
    if (scaleFilter) {
      filters.push(`scale=${scaleFilter}:flags=bicubic`)
      summary.push(t('main.cmd.summaryScale', { value: scaleFilter }))
    }
    if (wantsFps) {
      filters.push(`fps=${v.fps}`)
      summary.push(t('main.cmd.summaryFps', { fps: v.fps }))
    }
  } else if (scaleFilter || wantsFps || v.rateControl === 'crf') {
    warnings.push(t('main.cmd.copyIgnoresVideo'))
  }

  /* Burn-in runs last so font sizes match the output resolution. */
  let burnText = false
  if (mode === 'burn' && track && isTextTrack) {
    if (copyVideo) {
      warnings.push(t('main.cmd.copyCannotBurn'))
    } else {
      const burn = resolveTextBurnSource(media, item.path, track)
      if (burn) {
        filters.push(subtitlesFilterArg(burn.filename, burn.streamIndex, sub))
        burnText = true
      } else {
        warnings.push(burnSourceMissingWarning(track, t))
      }
      if (burnText) {
        summary.push(
          `${t('main.cmd.summaryBurn')}${track.source === 'embedded' ? t('main.cmd.summaryBurnEmbedded', { n: track.streamIndex ?? '?' }) : ''}`
        )
      }
    }
  } else if (mode === 'burn' && track && !isTextTrack && !hasExternalSub && !copyVideo) {
    warnings.push(t('main.cmd.embeddedBitmapNoBurn'))
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
    summary.push(t('main.cmd.summaryBitmapOverlay'))
  } else if (videoIn) {
    args.push('-map', `0:${videoIn.index}`)
    if (videoFilterChain) args.push('-vf', videoFilterChain)
  }
  if (audioIn && a.codec !== 'none') args.push('-map', `0:${audioIn.index}`)

  /* ---------------- video encoder ---------------- */
  const spec: EncoderSpec = copyVideo ? { name: 'copy', kind: 'copy' } : encoderArgFor(v.encoder, v.codec, available)
  let vencName = 'copy'
  const flvWarn = flvCodecWarning(v.codec, effContainer, t)
  if (flvWarn) warnings.push(flvWarn)
  const whipWarn = whipCodecWarning(protocol, v, a, t)
  if (whipWarn) warnings.push(whipWarn)

  if (copyVideo) {
    args.push('-c:v', 'copy')
    summary.unshift(t('main.cmd.summaryVideoCopy'))
  } else if (!videoIn) {
    warnings.push(t('main.cmd.noVideoTrack'))
  } else {
    vencName = spec.name
    args.push('-c:v', spec.name, '-pix_fmt', pixelFormatFor(v, spec))
    const fpsForGop = v.fps > 0 ? v.fps : Math.min(120, Math.max(10, Math.round(sourceFps || 30)))
    applyVideoEncoderArgs(args, v, spec, fpsForGop, effContainer)
    if (v.repeatHeaders && effContainer === 'flv') args.push('-flags', '+cgop')
    const hw = spec.kind === 'software' ? '' : t('main.cmd.hardwareTag')
    summary.unshift(videoSummary(t, spec.name, hw, v))
    if (spec.kind === 'software' && v.bitrateKbps > 12000) {
      warnings.push(t('main.cmd.softwareHighBitrate', { encoder: spec.name }))
    }
    if (spec.kind === 'amf' && v.tune === 'zerolatency') {
      warnings.push(t('main.cmd.amfLowLatency'))
    }
  }

  /* ---------------- audio encoder ---------------- */
  let aencName = 'none'
  if (a.codec === 'none') {
    summary.push(t('main.cmd.summaryAudioNone'))
  } else if (!audioIn) {
    warnings.push(t('main.cmd.noAudioTrack'))
  } else if (a.codec === 'copy') {
    aencName = 'copy'
    args.push('-c:a', 'copy')
    summary.push(t('main.cmd.summaryAudioCopy'))
  } else {
    if (a.loudnorm) {
      audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      summary.push(t('main.cmd.summaryLoudnorm'))
    }
    aencName = applyAudioArgs(args, a, audioFilters, audioIn.channels ?? 2)
    const avLayout = (audioIn.channels ?? 2) === 1 ? t('main.cmd.testMono') : t('main.cmd.testStereo')
    summary.push(
      t('main.cmd.summaryAudio', {
        encoder: aencName,
        bitrate: `${a.bitrateKbps}kbps`,
        rate: a.codec === 'libopus' ? 48000 : a.sampleRate,
        layout: avLayout
      })
    )
  }
  if (audioFilters.length > 0) args.push('-af', audioFilters.join(','))

  if (effContainer === 'flv' && aencName === 'libopus') {
    warnings.push(t('main.cmd.opusInFlv'))
  }
  if (effContainer === 'mpegts' && aencName === 'aac') args.push('-bsf:a', 'aac_adtstoasc')

  /* ---------------- subtitle handling result ---------------- */
  let subtitleApplied: SubtitleApplication = 'none'
  if (mode === 'burn' && track && !copyVideo) {
    if (burnText) subtitleApplied = 'burn-text'
    else if (burnBitmapExternal) subtitleApplied = 'burn-bitmap'
  } else if (mode === 'copy' && track) {
    if (!isTextTrack) {
      warnings.push(t('main.cmd.bitmapNoCopy'))
    } else if (track.source === 'embedded') {
      args.push('-map', `0:${track.streamIndex}`, '-c:s', 'copy')
      subtitleApplied = 'copy'
      summary.push(t('main.cmd.summarySubCopy'))
      if (effContainer === 'flv') warnings.push(t('main.cmd.flvNoSubtitleTrack'))
    } else {
      warnings.push(t('main.cmd.externalSubNoTrack'))
    }
  }

  /* ---------------- muxing / output ---------------- */
  if (out.dropLateFrames) args.push('-fflags', '+genpts+igndts', '-max_delay', '0')
  args.push('-max_interleave_delta', '0')
  if (effContainer === 'flv') args.push('-flvflags', 'no_duration_filesize')
  if (out.extraOutputArgs.trim()) args.push(...out.extraOutputArgs.trim().split(/\s+/))
  args.push('-progress', 'pipe:1', '-nostats')

  const target = req.outputOverride ?? buildPushTarget(out.server, out.streamKey, protocol)
  if (!req.outputOverride) {
    // Per-protocol connection behaviour: RTMP lets ffmpeg retry the socket instead
    // of tearing the whole pipeline down; RTSP picks the transport it pushes over;
    // the key protocols that do not carry the key in the address get it here.
    if (protocol === 'rtmp') {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', String(Math.max(1, out.reconnectDelaySec)))
    } else if (protocol === 'rtsp') {
      args.push('-rtsp_transport', networkForProtocol(protocol, out.network))
    }
    args.push(...protocolKeyArgs(protocol, out.streamKey))
  }
  args.push('-f', muxerForProtocol(protocol), target)

  return {
    args,
    commandLine: buildCommandLine(req.ffmpegPath, args),
    summary,
    warnings,
    vencName,
    aencName,
    subtitleApplied,
    remainingDurationSec: remaining,
    ...mappedStreamIndexes(videoIn, audioIn, a.codec)
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
export function buildEncoderArgs(req: Omit<BuildRequest, 'outputOverride'>): BuiltEncoderArgs {
  const { item, settings, media } = req
  const v = settings.video
  const a = settings.audio
  const sub = settings.subtitles
  const out = settings.output
  const available = getAvailableEncoderNames()
  const t = translatorFor(req.language ?? DEFAULT_COMMAND_LANGUAGE)
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
      summary.push(t('main.cmd.summaryScale', { value: scaleFilter }))
    }
    if (wantsFps) {
      filters.push(`fps=${v.fps}`)
      summary.push(t('main.cmd.summaryFps', { fps: v.fps }))
    }
  }

  let burnText = false
  if (mode === 'burn' && track && isTextTrack && !copyVideo) {
    const burn = resolveTextBurnSource(media, item.path, track)
    if (burn) {
      filters.push(subtitlesFilterArg(burn.filename, burn.streamIndex, sub))
      burnText = true
    } else {
      warnings.push(burnSourceMissingWarning(track, t))
    }
    if (burnText) {
      summary.push(
        `${t('main.cmd.summaryBurn')}${track.source === 'embedded' ? t('main.cmd.summaryBurnEmbedded', { n: track.streamIndex ?? '?' }) : ''}`
      )
    }
  }
  if (hasOffset && internalOffset > 0) {
    warnings.push(t('main.cmd.offsetPositive', { sec: round2(internalOffset) }))
  }

  /* ---- mapping ---- */  if (videoIn) {
    args.push('-map', `0:${videoIn.index}`)
    if (filters.length > 0) args.push('-vf', filters.join(','))
  }
  if (audioIn && a.codec !== 'none') args.push('-map', `0:${audioIn.index}`)

  /* ---- video encoder ---- */
  const spec: EncoderSpec = copyVideo ? { name: 'copy', kind: 'copy' } : encoderArgFor(v.encoder, v.codec, available)
  const effContainer = containerForProtocol(out.protocol)
  const flvWarn = flvCodecWarning(v.codec, effContainer, t)
  if (flvWarn) warnings.push(flvWarn)
  const whipWarn = whipCodecWarning(out.protocol, v, a, t)
  if (whipWarn) warnings.push(whipWarn)
  if (copyVideo) {
    args.push('-c:v', 'copy')
    summary.unshift(t('main.cmd.summaryVideoCopy'))
  } else if (!videoIn) {
    warnings.push(t('main.cmd.noVideoTrackEncoder'))
  } else {
    args.push('-c:v', spec.name, '-pix_fmt', pixelFormatFor(v, spec))
    const fpsForGop = v.fps > 0 ? v.fps : Math.min(120, Math.max(10, Math.round(sourceFps || 30)))
    applyVideoEncoderArgs(args, v, spec, fpsForGop, effContainer)
    if (v.repeatHeaders) args.push('-flags', '+cgop')
    const hw = spec.kind === 'software' ? '' : t('main.cmd.hardwareTag')
    summary.unshift(videoSummary(t, spec.name, hw, v))
  }

  /* ---- audio encoder ---- */
  const audioFilters: string[] = []
  if (a.codec === 'none') {
    summary.push(t('main.cmd.summaryAudioNone'))
  } else if (!audioIn) {
    warnings.push(t('main.cmd.noAudioTrack'))
  } else if (a.codec === 'copy') {
    args.push('-c:a', 'copy')
    summary.push(t('main.cmd.summaryAudioCopy'))
  } else {
    if (a.loudnorm) {
      audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      summary.push(t('main.cmd.summaryLoudnorm'))
    }
    const enc = applyAudioArgs(args, a, audioFilters, audioIn.channels ?? 2)
    const copyLayout = (audioIn.channels ?? 2) === 1 ? t('main.cmd.testMono') : t('main.cmd.testStereo')
    summary.push(
      t('main.cmd.summaryAudio', {
        encoder: enc,
        bitrate: `${a.bitrateKbps}kbps`,
        rate: a.codec === 'libopus' ? 48000 : a.sampleRate,
        layout: copyLayout
      })
    )
  }
  if (audioFilters.length > 0) args.push('-af', audioFilters.join(','))

  return { args, summary, warnings, vencName: copyVideo ? 'copy' : spec.name, ...mappedStreamIndexes(videoIn, audioIn, a.codec) }
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

/**
 * Resolution of the synthetic test pattern.
 *
 * The pattern is what stands in for a real file, so it is generated at the size the
 * session would output — otherwise a test at 640x360 says nothing about whether the
 * chosen encoder and bitrate survive the real geometry. It is capped at 720p and
 * falls back to 640x360 so that a 4K preset still answers in seconds instead of
 * burning half a minute of software encoding on a connection check.
 */
const TEST_PATTERN_MAX_WIDTH = 1280
const TEST_PATTERN_MAX_HEIGHT = 720
const TEST_PATTERN_DEFAULT = '640x360'
/**
 * Frame rate of the pattern when the session does not pin one.
 *
 * `fps: 0` means "leave the source frame rate alone", and the pattern has no source
 * to inherit it from, so 30 stands in — the same value the GOP maths already used.
 * A configured `fps` IS honoured, because it is a real encoding parameter (it drives
 * the keyframe interval) rather than a description of the file.
 */
const TEST_DEFAULT_FPS = 30

function testPatternSize(v: VideoSettings): string {
  const filter = resolveScaleFilter(v)
  const m = /^(\d+):(\d+|-2)$/.exec(filter)
  if (!m) return TEST_PATTERN_DEFAULT
  let width = Number(m[1])
  // `-2` is the auto height: derive it from the source aspect ratio, which for the
  // 16:9 test pattern is what `testsrc2` would have produced anyway.
  let height = m[2] === '-2' ? Math.round((width * 9) / 16 / 2) * 2 : Number(m[2])
  if (!(width >= 2) || !(height >= 2)) return TEST_PATTERN_DEFAULT
  const shrink = Math.min(1, TEST_PATTERN_MAX_WIDTH / width, TEST_PATTERN_MAX_HEIGHT / height)
  if (shrink < 1) {
    width = Math.max(2, Math.round((width * shrink) / 2) * 2)
    height = Math.max(2, Math.round((height * shrink) / 2) * 2)
  }
  return `${width}x${height}`
}

/**
 * Synthetic ffmpeg command for the "test connection" action.
 *
 * Everything the connection can depend on comes from the session, through the same
 * helpers the real stream uses: the video/audio codecs, both encoders' rate control
 * and bitrate, the audio sample rate, channel layout and loudness normalisation, the
 * frame rate, keyframe interval, pixel format and container. Only the *source* is
 * synthetic — and so is the one thing that describes it rather than encodes it: the
 * test pattern's geometry is the session's output size (capped, see
 * {@link testPatternSize}) and its duration is the 5 seconds the button promises.
 *
 * The settings that describe a *media file* instead of an encoder have no meaningful
 * test equivalent, and the returned `notes` say so rather than leaving the result
 * looking like they were exercised:
 *  - `audio.codec: 'copy'`: the pattern has no source audio track to copy from, so the
 *    test encodes AAC; `audio.codec: 'none'` drops the audio stream entirely, because
 *    that is exactly what the real stream would send;
 *  - `video.codec: 'copy'`: the pattern exists to be encoded, so the test uses the
 *    software encoder of the same codec.
 *
 * `-re` is deliberately not applied: it would add the configured pipeline's pacing
 * to a five-second clip for no diagnostic gain, and the button promises a quick
 * answer. `-flvflags no_duration_filesize` is applied because the real command always
 * applies it for FLV — RTMP flushes the header immediately — and its absence from the
 * test was itself a difference between the test and the stream.
 */
export function buildTestCommand(settings: SessionSettings, url: string, streamKey: string, language: Language = DEFAULT_COMMAND_LANGUAGE): {
  args: string[]
  summary: string[]
  notes: string[]
} {
  const v = settings.video
  const a = settings.audio
  const out = settings.output
  const available = getAvailableEncoderNames()
  const t = translatorFor(language)
  const summary: string[] = []
  const notes: string[] = []
  const protocol: StreamProtocol = out.protocol ?? DEFAULT_STREAM_PROTOCOL
  const effContainer = containerForProtocol(protocol)
  const target = buildPushTarget(url, streamKey, protocol)
  const pattern = testPatternSize(v)
  const fps = v.fps > 0 ? v.fps : TEST_DEFAULT_FPS

  /* ---------------- inputs ---------------- */
  // `-nostdin` matches the real command: nothing here should ever read the console.
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'info',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${pattern}:rate=${fps}:duration=5`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=5',
    '-map',
    '0:v:0'
  ]
  if (a.codec !== 'none') args.push('-map', '1:a:0')

  /* ---------------- video encoder ---------------- */
  const flv = effContainer === 'flv'
  const wantsCopy = v.codec === 'copy'
  const spec: EncoderSpec = wantsCopy
    ? encoderArgFor('x264', 'h264', available)
    : encoderArgFor(v.encoder, v.codec, available)
  args.push('-c:v', spec.name, '-pix_fmt', pixelFormatFor(v, spec))
  applyVideoEncoderArgs(args, v, spec, fps, out.container)
  if (v.repeatHeaders && flv) args.push('-flags', '+cgop')
  if (wantsCopy) {
    notes.push(t('main.cmd.testCopyVideoNote'))
  }
  const hw = spec.kind === 'software' ? '' : t('main.cmd.hardwareTag')
  summary.push(
    t('main.cmd.testSummaryVideo', {
      encoder: spec.name,
      hw,
      mode: `${v.rateControl.toUpperCase()} ${
        v.rateControl === 'crf' ? t('main.cmd.summaryVideoModeCrf', { crf: v.crf }) : t('main.cmd.summaryVideoModeBitrate', { kbps: v.bitrateKbps })
      }`,
      size: pattern,
      fps
    })
  )

  /* ---------------- audio encoder ---------------- */
  const audioFilters: string[] = []
  if (a.codec === 'none') {
    // No audio track at all: the test must push what the stream would push.
    summary.push(t('main.cmd.testNoAudio'))
  } else {
    // The sine source is a single channel, which is what `applyAudioArgs` needs to
    // know before it decides whether a `pan` downmix is required.
    const enc = applyAudioArgs(args, a, audioFilters, 1)
    if (a.codec === 'copy') {
      notes.push(t('main.cmd.testCopyAudioNote'))
    }
    const rate = enc === 'libopus' ? 48000 : a.sampleRate || 44100
    const layout = Math.max(1, Math.min(2, a.channels || 2)) === 1 ? t('main.cmd.testMono') : t('main.cmd.testStereo')
    const bitrate = a.rateControl === 'vbr' && enc !== 'libopus' ? 'VBR' : `${a.bitrateKbps}kbps`
    summary.push(t('main.cmd.summaryAudio', { encoder: enc, bitrate, rate, layout }))
    if (a.loudnorm) {
      audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      summary.push(t('main.cmd.summaryLoudnorm'))
    }
  }
  if (audioFilters.length > 0) args.push('-af', audioFilters.join(','))

  /*
   * The same container/codec warnings the real stream reports, for the same reason:
   * now that the test pushes the configured codecs, an unsupported combination fails
   * here exactly as it would live (measured: opus into FLV writes zero bytes and exits
   * non-zero) — and "连接失败" would send the user hunting for a network problem that
   * does not exist. Emitted only when the test really encodes that codec.
   */
  const codecWarning = flvCodecWarning(wantsCopy ? 'h264' : v.codec, effContainer, t)
  if (codecWarning) notes.push(codecWarning)
  const whipWarn = whipCodecWarning(protocol, { ...v, codec: wantsCopy ? 'h264' : v.codec }, a, t)
  if (whipWarn) notes.push(whipWarn)
  if (flv && a.codec === 'libopus') notes.push(t('main.cmd.opusInFlv'))

  /* ---------------- muxing / destination ---------------- */
  /*
   * Mirrors the real command's output side: the flags that are always applied for
   * FLV, the user's own extra arguments, and the late-frame policy. The extra
   * arguments can already name any of these, and the real command would then emit
   * the flag twice and let the last one win — here the user's text is the only copy,
   * so the test command stays readable when it is the thing being inspected.
   */
  const extra = out.extraOutputArgs.trim() ? out.extraOutputArgs.trim().split(/\s+/) : []
  const mentions = (flag: string): boolean => extra.includes(flag)
  if (!mentions('-max_interleave_delta')) args.push('-max_interleave_delta', '0')
  if (flv && !mentions('-flvflags')) args.push('-flvflags', 'no_duration_filesize')
  if (out.dropLateFrames && !mentions('-fflags')) args.push('-fflags', '+genpts+igndts', '-max_delay', '0')
  args.push(...extra)
  // Per-protocol destination behaviour, mirroring the real stream: RTSP picks its
  // transport, and protocols whose key does not ride in the address get it here.
  if (protocol === 'rtsp') args.push('-rtsp_transport', networkForProtocol(protocol, out.network))
  args.push(...protocolKeyArgs(protocol, streamKey))
  args.push('-f', muxerForProtocol(protocol), target)

  return { args, summary, notes }
}
