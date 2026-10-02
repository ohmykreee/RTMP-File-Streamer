/**
 * Shared type contracts between the Electron main process (FFmpeg engine) and the renderer UI.
 * Keep this file dependency-free: it is compiled into both bundles.
 */

/* ------------------------------------------------------------------ *
 * Media probing
 * ------------------------------------------------------------------ */

export type VideoCodecName = 'h264' | 'hevc' | 'av1' | 'copy'
export type AudioCodecName = 'aac' | 'libmp3lame' | 'libopus' | 'copy' | 'none'
export type ContainerName = 'flv' | 'mpegts' | 'mkv'

export type SubtitleCodecFamily = 'text' | 'bitmap' | 'unknown'

export interface MediaStreamInfo {
  index: number
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown'
  codec: string
  codecLong?: string
  /** Subtitle streams may be text (SRT/ASS) or bitmap (PGS/DVB). */
  subtitleFamily?: SubtitleCodecFamily
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  sampleRate?: number
  channels?: number
  channelLayout?: string
  /** ISO 639-2 code as reported by ffprobe. */
  language?: string
  title?: string
  isDefault?: boolean
  isForced?: boolean
  /** Video stream that is really embedded cover art (album/MV thumbnail). */
  attachedPic?: boolean
}

export interface MediaInfo {
  path: string
  /** File size in bytes. */
  size: number
  durationSec: number
  formatName: string
  formatLongName?: string
  bitrate?: number
  streams: MediaStreamInfo[]
  videoStreams: MediaStreamInfo[]
  audioStreams: MediaStreamInfo[]
  subtitleStreams: MediaStreamInfo[]
  probeError?: string
}

export type SubtitleSource = 'embedded' | 'external'
export type SubtitleMode = 'off' | 'burn' | 'copy'

/**
 * A single subtitle track either muxed inside the source file (`embedded`,
 * identified by stream index) or loaded from a sidecar file (`external`).
 */
export interface SubtitleTrackRef {
  id: string
  source: SubtitleSource
  /** Present for `external` tracks. */
  path?: string
  /** Present for `embedded` tracks. */
  streamIndex?: number
  codec: string
  family: SubtitleCodecFamily
  language?: string
  title?: string
  isDefault?: boolean
  isForced?: boolean
}

/* ------------------------------------------------------------------ *
 * Playlist
 * ------------------------------------------------------------------ */

export type PlaylistItemStatus = 'pending' | 'preparing' | 'live' | 'done' | 'skipped' | 'error'

export interface PlaylistItem {
  id: string
  /** Absolute path of the video file. */
  path: string
  name: string
  size: number
  durationSec: number
  /** All subtitle tracks available for this item (embedded + sidecar). */
  subtitleTracks: SubtitleTrackRef[]
  /** id of the currently selected track, or null for "no subtitles". */
  selectedSubtitleId: string | null
  mode: SubtitleMode
  /** Per-item offsets applied to video/audio/subtitle timestamps (seconds). */
  syncOffsetSec: number
  subtitleDelaySec: number
  status: PlaylistItemStatus
  error?: string
  /** True when this item's media could not be probed. */
  broken?: boolean
}

/* ------------------------------------------------------------------ *
 * Encoding settings
 * ------------------------------------------------------------------ */

export type VideoRateControl = 'cbr' | 'vbr' | 'crf' | 'abr' | 'auto'
export type AudioRateControl = 'cbr' | 'vbr'

/**
 * Hardware/software encoder choice. `auto` picks the best available encoder for
 * the requested codec on this machine (hardware first).
 */
export type VideoEncoderChoice =
  | 'auto'
  | 'x264'
  | 'x265'
  | 'svt-av1'
  | 'aom-av1'
  | 'h264_nvenc'
  | 'hevc_nvenc'
  | 'av1_nvenc'
  | 'h264_amf'
  | 'hevc_amf'
  | 'av1_amf'
  | 'h264_qsv'
  | 'hevc_qsv'
  | 'av1_qsv'

export interface VideoSettings {
  codec: VideoCodecName
  /** Stream-copy the source video instead of re-encoding (no burn-in possible). */
  encoder: VideoEncoderChoice
  rateControl: VideoRateControl
  bitrateKbps: number
  maxBitrateKbps: number
  /** Encoder buffer size in kbit; 0 = derive from bitrate. */
  bufferSizeKbps: number
  crf: number
  /** Video quality preset, encoder specific (e.g. x264 "veryfast", NVENC "p5"). */
  preset: string
  /** x264/x265 tune value such as `zerolatency`, empty = unset. */
  tune: string
  /** x264/x265 profile, e.g. `high`, `main`. Empty = unset. */
  profile: string
  /** Encoder GOP / keyframe interval in frames. 0 = auto from fps. */
  keyframeIntervalSec: number
  /** B-frames; 0 is required for lowest-latency hardware encoding. */
  bFrames: number
  /** Output resolution; empty string = keep source. */
  scale: string
  /** Width in pixels when resolution scaling is enabled. */
  scaleWidth: number
  /** Height in pixels; ignored when `scaleAuto` is on. */
  scaleHeight: number
  /** Derive the height from the width to preserve the source aspect ratio. */
  scaleAuto: boolean
  fps: number
  /** Pixel format; `yuv420p` is required for maximum RTMP player compatibility. */
  pixelFormat: string
  /** Repeat SPS/PPS headers on every keyframe (needed by some RTMP servers). */
  repeatHeaders: boolean
}

export interface AudioSettings {
  codec: AudioCodecName
  rateControl: AudioRateControl
  bitrateKbps: number
  sampleRate: number
  channels: number
  /** Normalize loudness with the `loudnorm` filter before encoding. */
  loudnorm: boolean
}

export interface SubtitleRenderSettings {
  mode: SubtitleMode
  /**
   * Burn-in style handling:
   *  - `preserve` keeps the original ASS styling (embedded ASS/SSA only)
   *  - `force` applies the provided ForceStyle overrides on top of it
   *  - `plain` renders plain text with the selected font/size/outline
   */
  styleMode: 'preserve' | 'force' | 'plain'
  fontName: string
  fontSize: number
  primaryColor: string
  outlineColor: string
  outlineWidth: number
  shadow: number
  marginVertical: number
  alignment: number
  /** Bold (-1 = on, 0 = off) and italic (-1 = on, 0 = off), libass convention. */
  bold: boolean
  italic: boolean
  /** For `copy` mode: convert bitmap subtitles to text (requires OCR, unavailable) is not supported. */
  allowTranscodeCopy: boolean
}

/**
 * The subset of the obs-websocket v5 protocol this app implements: OBS
 * remote-control clients can drive it, but only stream control is real — any
 * other request that expects no payload gets a generic success.
 */
export interface ObsWebSocketSettings {
  enabled: boolean
  /** Bind address; the default keeps the server on the local machine only. */
  host: string
  port: number
  /** Empty = authentication disabled (the handshake then sends no challenge). */
  password: string
}

export interface ObsWebSocketStatus {
  running: boolean
  host: string
  port: number
  /** Address clients should connect to, e.g. `ws://127.0.0.1:4455`. */
  url: string
  /** Clients that completed the obs-websocket handshake. */
  clients: number
  /** Why the server is not running, e.g. the port is already in use. */
  error: string
}

export interface OutputSettings {
  /**
   * RTMP application address including its trailing `/` (OBS calls this the
   * "server"). The stream key is appended to it directly.
   */
  server: string
  streamKey: string
  container: ContainerName
  /** Extra ffmpeg output options, e.g. `-flvflags no_duration_filesize`. */
  extraOutputArgs: string
  /** Additional `-re`-style pacing: throttle input to real time. */
  realtimePacing: boolean
  /** obs-websocket compatible control server. */
  obsWebSocket: ObsWebSocketSettings
  /**
   * Loop the final playlist instead of stopping. Off by default: the stream ends
   * when the last file finishes.
   */
  loopPlaylist: boolean
  /** Seconds to wait before auto-reconnecting a dropped connection. */
  reconnectDelaySec: number
  /** 0 disables automatic reconnection attempts. */
  maxReconnectAttempts: number
  /**
   * Pause between two playlist entries. The RTMP publish session is closed and
   * reopened, so servers need a moment to release the stream key.
   */
  gapBetweenItemsSec: number
  /** Seek accuracy: fast = keyframe seek, accurate = decode-accurate (slower restart). */
  seekAccuracy: 'fast' | 'accurate'
  /** Optional https/http query parameters appended to the RTMP url. */
  dropLateFrames: boolean
}

export interface SessionSettings {
  video: VideoSettings
  audio: AudioSettings
  subtitles: SubtitleRenderSettings
  output: OutputSettings
}

export interface Preset {
  id: string
  name: string
  settings: SessionSettings
  /** Epoch millis when the preset was written; absent for built-ins. */
  savedAt?: number
  /** Built-in presets ship with the app and cannot be overwritten or deleted. */
  builtin?: boolean
}

/** Where the application keeps its state on disk. */
export interface PresetLocation {
  /** Folder holding settings.json / playlist.json / presets.json. */
  dir: string
  /** Absolute path of presets.json. */
  file: string
  /** Application root the Data folder sits in. */
  appRoot: string
  writable: boolean
}

export interface PresetsPayload {
  location: PresetLocation
  /** Built-ins first, then user presets. */
  presets: Preset[]
}

export interface AppSettings {
  /** Explicit ffmpeg path; empty = auto-detect. */
  ffmpegPath: string
  /** Explicit ffprobe path; empty = auto-detect. */
  ffprobePath: string
  session: SessionSettings
}

/* ------------------------------------------------------------------ *
 * Encoder capabilities
 * ------------------------------------------------------------------ */

export interface EncoderOption {
  value: VideoEncoderChoice
  label: string
  codec: VideoCodecName
  /** `nvenc` | `amf` | `qsv` | `videotoolbox` | `software` */
  kind: string
  /** False when `ffmpeg -encoders` does not list it. */
  available: boolean
  /** Hardware encoder confirmed working by an actual 1-frame encode test. */
  verified?: boolean
  note?: string
  presets: string[]
}

export interface FfmpegCapabilities {
  ffmpegPath: string
  ffprobePath: string
  ffmpegVersion: string
  /** Raw `configuration:` line from `ffmpeg -version`. */
  buildConfiguration: string
  source: 'settings' | 'bundled' | 'path' | 'common-location' | 'missing'
  encoders: EncoderOption[]
  audioEncoders: { value: AudioCodecName; label: string; available: boolean }[]
  containerFormats: { value: ContainerName; label: string; muxer: string; available: boolean }[]
  hasSubtitleFilter: boolean
  hasOverlayFilter: boolean
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * Engine status & events
 * ------------------------------------------------------------------ */

export type EngineState =
  | 'idle'
  | 'preparing'
  | 'connecting'
  | 'live'
  | 'paused'
  | 'reconnecting'
  | 'stopping'
  | 'error'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'ffmpeg'

export interface LogEntry {
  id: number
  ts: number
  level: LogLevel
  message: string
}

export interface EngineStatus {
  state: EngineState
  /** Index into the playlist, or -1 when nothing is loaded. */
  currentIndex: number
  /** Seconds into the current file. */
  positionSec: number
  currentDurationSec: number
  /** Seconds already finished in earlier playlist items. */
  completedSec: number
  totalDurationSec: number
  /** Current encode speed as reported by ffmpeg (`speed=1.02x`). */
  speed: number
  fps: number
  bitrateKbps: number
  droppedFrames: number
  frame: number
  /** Item ids in playback order; used by the UI to render the queue. */
  order: string[]
  itemStatus: Record<string, PlaylistItemStatus>
  itemError: Record<string, string>
  /** The exact ffmpeg argument vector of the running process. */
  commandLine: string
  /** Total reconnect attempts since the session started. */
  reconnectCount: number
  connected: boolean
  startedAt: number | null
  /** Wall-clock seconds elapsed since the session started. */
  elapsedSec: number
}

/* ------------------------------------------------------------------ *
 * IPC surface
 * ------------------------------------------------------------------ */

export interface ProbeRequest {
  path: string
}

export interface ProbeResult {
  info: MediaInfo
  subtitles: SubtitleTrackRef[]
}

export interface SeekRequest {
  /** Absolute position inside the current file, in seconds. */
  positionSec: number
}

export interface RtmpTestRequest {
  url: string
  streamKey: string
  timeoutSec: number
}

export interface RtmpTestResult {
  ok: boolean
  message: string
  /** Captured ffmpeg output, useful for diagnosing auth/network errors. */
  detail: string
  elapsedMs: number
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userDataPath: string
}

/** Where the persisted run log is being written, and how much space it uses. */
export interface PersistedLogInfo {
  dir: string
  currentFile: string
  /** Bytes currently used by the whole Logs folder. */
  totalBytes: number
  fileCount: number
  budgetBytes: number
}

/** Renderer -> main invocations (all promise based). */
export interface StreamerApi {
  getAppInfo(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getCapabilities(force?: boolean): Promise<FfmpegCapabilities>
  pickFfmpeg(): Promise<string | null>
  pickVideoFiles(): Promise<string[]>
  pickSubtitleFiles(): Promise<string[]>
  probe(path: string): Promise<ProbeResult>
  addItems(paths: string[]): Promise<PlaylistItem[]>
  attachSubtitle(itemId: string, path: string): Promise<PlaylistItem | null>
  removeItem(itemId: string): Promise<void>
  clearPlaylist(): Promise<void>
  reorderPlaylist(orderedIds: string[]): Promise<void>
  updateItem(
    itemId: string,
    patch: Partial<Pick<PlaylistItem, 'selectedSubtitleId' | 'mode' | 'syncOffsetSec' | 'subtitleDelaySec'>>
  ): Promise<PlaylistItem | null>
  getPlaylist(): Promise<PlaylistItem[]>
  getStatus(): Promise<EngineStatus>
  getLogs(): Promise<LogEntry[]>
  start(): Promise<EngineStatus>
  pause(): Promise<EngineStatus>
  resume(): Promise<EngineStatus>
  stop(): Promise<EngineStatus>
  skipNext(): Promise<EngineStatus>
  seek(positionSec: number): Promise<EngineStatus>
  jumpToItem(itemId: string): Promise<EngineStatus>
  testRtmp(req: RtmpTestRequest): Promise<RtmpTestResult>
  clearLogs(): Promise<void>
  /** Reveal a file in the OS file manager. */
  showItemInFolder(path: string): Promise<void>
  /** Build (but do not run) the ffmpeg command for the current item, for inspection. */
  previewCommand(): Promise<string>
  /* --- presets: whole-session settings stored in the app's config folder --- */
  getPresets(): Promise<PresetsPayload>
  /** Creates a preset from the current session, overwriting one with the same name. */
  savePreset(name: string, settings: SessionSettings): Promise<PresetsPayload>
  deletePreset(presetId: string): Promise<PresetsPayload>
  renamePreset(presetId: string, name: string): Promise<PresetsPayload>
  /** Reveal the config folder that holds presets.json. */
  openConfigDir(): Promise<void>
  /** Reveal the folder holding the persisted run logs. */
  openLogsDir(): Promise<void>
  /** Size/count of the persisted log files. */
  getLogFileInfo(): Promise<PersistedLogInfo>
  /** Live state of the obs-websocket compatible control server. */
  getObsWebSocketStatus(): Promise<ObsWebSocketStatus>
  /** Restarts the control server after its settings changed. */
  applyObsWebSocket(): Promise<ObsWebSocketStatus>
  /**
   * Resolve the filesystem paths of `File` objects coming from a drag-and-drop
   * event. Needed because Electron no longer exposes `File.path`; the lookup
   * (`webUtils.getPathForFile`) must happen in the preload world.
   */
  getPathsForFiles(files: File[]): string[]
  onStatus(cb: (status: EngineStatus) => void): () => void
  onLog(cb: (entry: LogEntry) => void): () => void
  onPlaylist(cb: (items: PlaylistItem[]) => void): () => void
  /** Settings were changed outside the UI (obs-websocket stream address). */
  onSettings(cb: (settings: AppSettings) => void): () => void
}

export const IPC = {
  getAppInfo: 'app:info',
  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  getCapabilities: 'ffmpeg:capabilities',
  pickFfmpeg: 'dialog:pickFfmpeg',
  pickVideoFiles: 'dialog:pickVideos',
  pickSubtitleFiles: 'dialog:pickSubtitles',
  probe: 'media:probe',
  addItems: 'playlist:add',
  attachSubtitle: 'playlist:attachSubtitle',
  removeItem: 'playlist:remove',
  clearPlaylist: 'playlist:clear',
  reorderPlaylist: 'playlist:reorder',
  updateItem: 'playlist:updateItem',
  getPlaylist: 'playlist:get',
  getStatus: 'engine:status',
  getLogs: 'log:get',
  clearLogs: 'log:clear',
  showItemInFolder: 'shell:showItem',
  getPresets: 'presets:get',
  savePreset: 'presets:save',
  deletePreset: 'presets:delete',
  renamePreset: 'presets:rename',
  openConfigDir: 'presets:openDir',
  openLogsDir: 'logs:openDir',
  getLogFileInfo: 'logs:info',
  getObsWebSocketStatus: 'obs:status',
  applyObsWebSocket: 'obs:apply',
  start: 'engine:start',
  pause: 'engine:pause',
  resume: 'engine:resume',
  stop: 'engine:stop',
  skipNext: 'engine:skipNext',
  seek: 'engine:seek',
  jumpToItem: 'engine:jumpToItem',
  testRtmp: 'engine:testRtmp',
  previewCommand: 'engine:previewCommand',
  evtStatus: 'evt:status',
  evtLog: 'evt:log',
  evtPlaylist: 'evt:playlist',
  /**
   * Sent when the main process changes settings on its own (the obs-websocket
   * endpoint writing the stream address), so the renderer re-reads them.
   */
  evtSettings: 'evt:settings'
} as const

export const SUPPORTED_VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.avi', '.flv', '.ts', '.m2ts', '.webm', '.wmv', '.mpg', '.mpeg', '.m4v', '.vob', '.ogv', '.mxf']
export const SUPPORTED_SUBTITLE_EXT = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup']
