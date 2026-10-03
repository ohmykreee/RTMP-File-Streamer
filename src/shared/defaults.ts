import type {
  AppSettings,
  AudioSettings,
  ContainerName,
  Preset,
  SessionSettings,
  SubtitleRenderSettings,
  VideoSettings
} from './types'

export const DEFAULT_VIDEO: VideoSettings = {
  codec: 'h264',
  encoder: 'auto',
  rateControl: 'cbr',
  bitrateKbps: 6000,
  maxBitrateKbps: 6000,
  bufferSizeKbps: 12000,
  crf: 22,
  preset: 'veryfast',
  tune: '',
  profile: 'high',
  keyframeIntervalSec: 2,
  bFrames: 0,
  scale: '',
  scaleWidth: 1920,
  scaleHeight: 1080,
  scaleAuto: true,
  fps: 0,
  pixelFormat: 'yuv420p',
  repeatHeaders: true
}

export const DEFAULT_AUDIO: AudioSettings = {
  codec: 'aac',
  rateControl: 'cbr',
  bitrateKbps: 160,
  sampleRate: 44100,
  channels: 2,
  loudnorm: false
}

export const DEFAULT_SUBTITLES: SubtitleRenderSettings = {
  mode: 'burn',
  styleMode: 'force',
  fontName: 'Microsoft YaHei',
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  shadow: 0,
  marginVertical: 24,
  alignment: 2,
  bold: false,
  italic: false,
  allowTranscodeCopy: false
}

/**
 * Bounds for how far the encoder may run ahead of the publisher, in seconds.
 *
 * The floor is not a taste decision: the publisher is paced at 1x and takes what the
 * encoder handed over, so a file change is only seamless if the buffer covers it.
 * Measured on a real 12-file buffered session, the gap between one pass ending and
 * the next producing its first packets was 5.8–7.5 s (engine gap + ffmpeg start +
 * AMF/filter init), so anything below ~12 s starves the publisher at every entry
 * boundary.
 *
 * Above the floor it is a straight trade, and the ceiling is deliberately high: every
 * second of lead is `bitrate / 8` KB held in memory until the publisher has aired it
 * (300 s at 4 Mbps ≈ 150 MB) and buys one second of tolerance for an encoder that dips
 * under 1x. Five minutes is enough to ride out a slow file without the buffer ever
 * reaching the size the unbounded queue used to.
 *
 * The single-process pipeline is what "no buffer" means, and that is what the
 * `buffered` switch selects — not a delay of zero, which would leave the publisher
 * with nothing to read. Declared before `DEFAULT_SESSION` because that is where the
 * default value comes from.
 */
export const BUFFER_SEC_MIN = 12
export const BUFFER_SEC_MAX = 300
/** Lead applied when the buffered playout is switched on from a smaller value. */
export const BUFFER_SEC_DEFAULT = BUFFER_SEC_MIN

export const DEFAULT_SESSION: SessionSettings = {
  video: DEFAULT_VIDEO,
  audio: DEFAULT_AUDIO,
  subtitles: DEFAULT_SUBTITLES,
  output: {
    // The address carries the full application path (trailing `/` included);
    // the stream key is appended directly to it, with no extra separator.
    server: 'rtmp://127.0.0.1/live/',
    streamKey: '',
    container: 'flv',
    extraOutputArgs: '',
    realtimePacing: true,
    // obs-websocket's own default endpoint, bound to the local machine only.
    obsWebSocket: { enabled: false, host: '127.0.0.1', port: 4455, password: '' },
    // Buffered two-process playout: the encoder runs flat out and a separate
    // publisher puts the result out at exactly 1x, so a slow stretch of encoding is
    // absorbed by the buffer instead of stalling every viewer. A new file only
    // restarts the encoder, which leaves the RTMP session — and the viewers'
    // connections — alone.
    //
    /*
     * The requested file is usually already inside the buffer, behind content the
     * viewer has not watched, and a published timeline cannot be rewound — but the
     * buffer is bounded by `bufferSec`, so what a skip discards is seconds, not the
     * hours the old unbounded queue used to hold.
     */
    buffered: true,
    // How far the encoder may lead the publisher: it is held back once it is further
    // ahead than this (see `BUFFER_SEC_MIN`), which is what keeps the queue from
    // growing into the whole playlist. The publisher is the clock, so this is memory
    // and stall tolerance rather than viewer latency.
    bufferSec: BUFFER_SEC_DEFAULT,
    loopPlaylist: false,
    reconnectDelaySec: 3,
    maxReconnectAttempts: 10,
    gapBetweenItemsSec: 1,
    dropLateFrames: false
  }
}

/** Bounds enforced by the UI and the control server. */
export const OBS_PORT_MIN = 1024
export const OBS_PORT_MAX = 65535

/**
 * How many log entries the run keeps in memory.
 *
 * Shared by the main process (the app-side ring buffer) and the renderer (its
 * copy of the history): they must agree, or a reload would silently drop entries
 * the main process still holds and the level filter would look like it only
 * covers the most recent part of the run.
 */
export const LOG_HISTORY_LIMIT = 5000

/** Resolution presets offered by the two-field scale control. */
export const SCALE_PRESETS: { label: string; width: number; height: number }[] = [
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: '2K (2560×1440)', width: 2560, height: 1440 },
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '900p (1600×900)', width: 1600, height: 900 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '480p (854×480)', width: 854, height: 480 },
  { label: '360p (640×360)', width: 640, height: 360 }
]

const scaled = (width: number, height: number, auto: boolean): Partial<VideoSettings> => ({
  scale: auto ? `${width}:-2` : `${width}:${height}`,
  scaleWidth: width,
  scaleHeight: height,
  scaleAuto: auto
})

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'builtin:1080p60-cbr',
    name: '1080p60 · H.264 CBR 6 Mbps (通用直播)',
    builtin: true,
    settings: {
      ...DEFAULT_SESSION,
      video: { ...DEFAULT_VIDEO, ...scaled(1920, 1080, true), codec: 'h264', rateControl: 'cbr', bitrateKbps: 6000, maxBitrateKbps: 6000, bufferSizeKbps: 12000, fps: 60, keyframeIntervalSec: 2 }
    }
  },
  {
    id: 'builtin:1080p30-balanced',
    name: '1080p30 · H.264 VBR 4.5 Mbps (省流量)',
    builtin: true,
    settings: {
      ...DEFAULT_SESSION,
      video: { ...DEFAULT_VIDEO, ...scaled(1920, 1080, true), codec: 'h264', rateControl: 'vbr', bitrateKbps: 4500, maxBitrateKbps: 6000, bufferSizeKbps: 9000, fps: 30, preset: 'faster' },
      audio: { ...DEFAULT_AUDIO, bitrateKbps: 128 }
    }
  },
  {
    id: 'builtin:720p-quality',
    name: '720p30 · H.264 CRF 20 (画质优先)',
    builtin: true,
    settings: {
      ...DEFAULT_SESSION,
      video: { ...DEFAULT_VIDEO, ...scaled(1280, 720, true), codec: 'h264', rateControl: 'crf', crf: 20, fps: 30, preset: 'medium', tune: 'film' },
      audio: { ...DEFAULT_AUDIO, bitrateKbps: 160 }
    }
  },
  {
    id: 'builtin:hevc-4k',
    name: '4K · HEVC CBR 20 Mbps (硬件优先)',
    builtin: true,
    settings: {
      ...DEFAULT_SESSION,
      video: { ...DEFAULT_VIDEO, ...scaled(3840, 2160, true), codec: 'hevc', rateControl: 'cbr', bitrateKbps: 20000, maxBitrateKbps: 20000, bufferSizeKbps: 40000, fps: 60, encoder: 'auto', bFrames: 0 },
      audio: { ...DEFAULT_AUDIO, bitrateKbps: 192 }
    }
  },
  {
    id: 'builtin:lowlatency-720p',
    name: '720p30 · 低延迟零缓冲 (远程控制/游戏)',
    builtin: true,
    settings: {
      ...DEFAULT_SESSION,
      video: { ...DEFAULT_VIDEO, ...scaled(1280, 720, true), codec: 'h264', rateControl: 'cbr', bitrateKbps: 3500, maxBitrateKbps: 3500, bufferSizeKbps: 3500, fps: 30, keyframeIntervalSec: 1, tune: 'zerolatency', preset: 'ultrafast' },
      audio: { ...DEFAULT_AUDIO, bitrateKbps: 128 },
      output: { ...DEFAULT_SESSION.output, dropLateFrames: true }
    }
  }
]

export const DEFAULT_SETTINGS: AppSettings = {
  ffmpegPath: '',
  ffprobePath: '',
  session: DEFAULT_SESSION
}

export const CONTAINER_MUXER: Record<ContainerName, string> = {
  flv: 'flv',
  mpegts: 'mpegts',
  mkv: 'matroska'
}
