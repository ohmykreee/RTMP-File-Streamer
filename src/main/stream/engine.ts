import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type {
  EngineState,
  EngineStatus,
  LogEntry,
  LogLevel,
  MediaInfo,
  PlaylistItem,
  PlaylistItemStatus,
  SessionSettings
} from '@shared/types'
import { buildEncoderArgs, buildStreamCommand, describeStreams, type BuiltCommand } from '../ffmpeg/command'
import { Playout } from './playout'
import { buildRtmpTarget } from '@shared/rtmp'
import { BUFFER_SEC_MIN, CONTAINER_MUXER } from '@shared/defaults'

export interface EngineDeps {
  getFfmpegPath: () => string
  getSettings: () => SessionSettings
  /** Probe results are provided by the caller so the engine stays I/O free. */
  getMedia: (itemPath: string) => MediaInfo | undefined
  probeMedia: (filePath: string) => Promise<MediaInfo>
}

export interface EngineSink {
  status: (status: EngineStatus) => void
  log: (entry: LogEntry) => void
  playlist: (items: PlaylistItem[]) => void
}

/** How close to the end of a file counts as "finished normally". */
const COMPLETION_TOLERANCE_SEC = 1.5

/**
 * How far the pusher may lag the encoder's hand-off point and still count as
 * "everything has aired".
 *
 * The final pass's span is only known once its process ends, and the pusher's last
 * reported position arrives with it, so the two never meet exactly. Half a second
 * is below one progress interval and far below anything a viewer would notice.
 */
const DRAIN_TOLERANCE_SEC = 0.5

/** Backstop for the drain wait: content, not a stuck process, decides the end. */
const DRAIN_MAX_SEC = 300
const DRAIN_STALL_MS = 45_000

/**
 * Gap left between what the pusher has published and where the next pass starts.
 *
 * Larger than a frame, smaller than anything a viewer would notice, and it keeps the
 * splice strictly forward even when the encoder's reported span was rounded down.
 */
const PASS_START_MARGIN_SEC = 0.25

/**
 * Whether this session runs the buffered two-process playout.
 *
 * The switch is the authority; the delay only decides how deep the buffer is. A
 * delay below the floor is clamped rather than treated as "off", because a caller
 * that asked for buffering and a tiny delay wants buffering — with the smallest
 * buffer that actually works — not a silent fallback to a different pipeline.
 */
function bufferedMode(output: SessionSettings['output']): boolean {
  return output.buffered === true && output.bufferSec > 0
}

/**
 * How far the buffered encoder may run ahead of the publisher, in seconds.
 *
 * `bufferSec` is the operator's setting and the floor is enforced here as well as in
 * the settings, so a value that never passed through `normaliseOutput` (a preset
 * written by hand, the control API) cannot leave the playout with a buffer too small
 * to cover a file change.
 */
function bufferLeadLimitSec(output: SessionSettings['output']): number {
  return Math.max(BUFFER_SEC_MIN, output.bufferSec)
}

/**
 * Whether the buffered playout's MPEG-TS relay can carry the requested codec.
 *
 * MPEG-TS carries H.264 and HEVC but not AV1: the MPEG-TS muxer writes AV1 as a
 * private data stream and the demuxer reads it back as `bin_data`, so the video
 * would be dropped before it ever reaches the FLV muxer. AV1 must therefore use
 * the single-process FLV path, where ffmpeg writes the Enhanced-RTMP `av01` tag
 * directly.
 */
function bufferedRelaySupportsCodec(settings: SessionSettings): boolean {
  return settings.video.codec !== 'av1'
}

export class StreamEngine {
  private readonly deps: EngineDeps
  private sink: EngineSink = { status: () => {}, log: () => {}, playlist: () => {} }

  private items: PlaylistItem[] = []
  private state: EngineState = 'idle'
  private currentIndex = -1
  private positionSec = 0
  private startPositionSec = 0
  private completedSec = 0
  private speed = 0
  private fps = 0
  private bitrateKbps = 0
  private droppedFrames = 0
  private frame = 0
  private connected = false
  private startedAt: number | null = null
  private reconnectCount = 0
  private commandLine = ''
  private lastWarnings: string[] = []

  private child: ChildProcessWithoutNullStreams | null = null
  private generation = 0
  private stdoutBuf = ''
  private stderrBuf = ''
  private outTimeSec = 0
  private itemDuration = 0
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private logSeq = 1
  private lastStderrLine = ''
  private lastStderrRepeat = 0

  /* --- two-process playout (bufferSec > 0) --- */
  private playout: Playout | null = null
  /** Encoder pass being produced, i.e. what the pusher is heading into. */
  private pass: { index: number; startSec: number; itemDurationSec: number; tsOffset: number } | null = null
  /**
   * Set once every playlist entry is encoded but the pusher is still publishing
   * what it holds. In buffered mode the encoder deliberately runs ahead of the
   * viewer, so "the last file was encoded" is not "the stream is over" — a 35s
   * playlist is fully encoded in a few seconds and still needs 35s of airtime.
   */
  private drain: { startedAt: number; lastProgressAt: number; waitingForSec: number } | null = null
  /**
   * True while a skip or a jump is replacing the RTMP session.
   *
   * A session restart discards the buffer and opens a new publish session, which
   * takes a moment; the passes being torn down and started during that window report
   * events that belong to neither the session that ended nor the one that is coming.
   */
  private restartingSession = false
  /**
   * Every pass handed to the pusher, in timeline order.
   *
   * The pusher airs them at 1x while the encoder races ahead, and it outlives the
   * encoder, so this log is the only way to answer "what is the viewer watching"
   * once several passes are in flight — or once none are.
   */
  private airedPasses: { index: number; startSec: number; itemDurationSec: number; tsOffset: number }[] = []
  /** Highest timeline value the pusher has reported (seconds, session timeline). */
  private publishedSec = 0

  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  setSink(sink: EngineSink): void {
    this.sink = sink
  }

  /* ------------------------------------------------------------ *
   * Playlist
   * ------------------------------------------------------------ */

  getPlaylist(): PlaylistItem[] {
    return this.items
  }

  setPlaylist(items: PlaylistItem[]): void {
    this.items = items
    this.emitPlaylist()
    this.emitStatus()
  }

  private setItemStatus(index: number, status: PlaylistItemStatus, error?: string): void {
    const item = this.items[index]
    if (!item) return
    item.status = status
    if (error !== undefined) item.error = error
    else if (status !== 'error') delete item.error
    this.emitPlaylist()
  }

  /** Encoder-side figures, only meaningful in buffered (two-process) mode. */
  private encoderStats: { speed: number; fps: number; bitrateKbps: number; leadSec: number } | null = null

  /* ------------------------------------------------------------ *
   * Status / logging
   * ------------------------------------------------------------ */

  getStatus(): EngineStatus {
    const total = this.items.reduce((sum, i) => sum + (i.durationSec || 0), 0)
    const encoded = this.encodedSec()
    const itemStatus: Record<string, PlaylistItemStatus> = {}
    const itemError: Record<string, string> = {}
    for (const i of this.items) {
      itemStatus[i.id] = i.status
      if (i.error) itemError[i.id] = i.error
    }
    return {
      state: this.state,
      currentIndex: this.currentIndex,
      positionSec: this.positionSec,
      currentDurationSec: this.itemDuration,
      completedSec: this.completedSec,
      totalDurationSec: total,
      speed: this.speed,
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
      droppedFrames: this.droppedFrames,
      frame: this.frame,
      order: this.items.map((i) => i.id),
      itemStatus,
      itemError,
      commandLine: this.commandLine,
      reconnectCount: this.reconnectCount,
      connected: this.connected,
      startedAt: this.startedAt,
      elapsedSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      buffered: this.playout !== null,
      ...(this.playout && this.encoderStats ? { encoder: this.encoderStats } : {}),
      ...(encoded !== null ? { encodedSec: encoded } : {})
    }
  }

  /**
   * Session-timeline position the encoder has reached, for the buffer display.
   *
   * Taken from the playout rather than derived from a lead measurement: the playout
   * knows how much it has handed over in total, which stays right across a pass
   * boundary where the hand-off point jumps forward while the viewer does not. Never
   * reported below what has already been published, so the buffer can only be drawn
   * as a span ahead of the viewer. Buffered mode only.
   */
  private encodedSec(): number | null {
    if (!this.playout || !this.encoderStats) return null
    return Math.max(this.completedSec, this.playout.getEncodedSec())
  }

  private emitStatus(): void {
    this.sink.status(this.getStatus())
  }

  /**
   * Sets the position inside the current file and derives the session total from
   * it, so the two can never disagree.
   *
   * `positionSec` is always "seconds into the current file" — including the part
   * a seek skipped — which is what the progress bar and the completion check
   * need. Deriving `completedSec` here (instead of in each caller) is what keeps
   * a seek from leaving a stale total behind.
   */
  private setPosition(positionSec: number): void {
    const max = this.itemDuration > 0 ? this.itemDuration : positionSec
    const clamped = Math.max(0, Math.min(positionSec, max))
    this.positionSec = clamped
    this.completedSec = this.sumDurationsBefore(this.currentIndex) + clamped
  }

  private emitPlaylist(): void {
    this.sink.playlist([...this.items])
  }

  log(level: LogLevel, message: string): void {
    this.sink.log({ id: this.logSeq++, ts: Date.now(), level, message })
  }

  /* ------------------------------------------------------------ *
   * Control
   * ------------------------------------------------------------ */

  async start(atIndex?: number): Promise<EngineStatus> {
    if (this.items.length === 0) {
      this.log('warn', '播放列表为空，无法开始串流。')
      return this.getStatus()
    }
    if (this.state === 'live' || this.state === 'connecting' || this.state === 'preparing') {
      this.log('info', '串流已在进行中。')
      return this.getStatus()
    }
    this.cancelTimers()
    const ffmpeg = this.deps.getFfmpegPath()
    if (!ffmpeg) {
      this.log('error', '未找到 ffmpeg，无法开始串流。请在“设置”中指定 ffmpeg 路径。')
      this.state = 'error'
      this.emitStatus()
      return this.getStatus()
    }

    for (const item of this.items) {
      item.status = 'pending'
      delete item.error
    }
    this.completedSec = 0
    this.startedAt = Date.now()
    this.reconnectCount = 0
    this.stopping = false
    // A new session starts a new RTMP timeline, so the pass log and the published
    // position must not carry over from the previous run.
    this.airedPasses = []
    this.publishedSec = 0
    this.drain = null
    this.currentIndex = atIndex !== undefined ? Math.max(0, Math.min(atIndex, this.items.length - 1)) : 0
    this.emitPlaylist()

    const settings = this.deps.getSettings()
    const target = buildRtmpTarget(settings.output.server, settings.output.streamKey)
    // The full target (which contains the stream key) is only shown in the debug
    // log, not in the UI and not in the info log.
    this.log('info', '开始串流会话。')
    this.log('debug', `推流目标: ${target}`)
    this.log('info', `播放列表共 ${this.items.length} 个文件，预计总时长 ${formatDuration(this.items.reduce((s, i) => s + (i.durationSec || 0), 0))}`)

    await this.launchCurrent(0, 'session-start')
    return this.getStatus()
  }

  async stop(): Promise<EngineStatus> {
    if (this.state === 'idle') return this.getStatus()
    this.stopping = true
    this.cancelTimers()
    this.state = 'stopping'
    this.emitStatus()
    this.log('info', '正在停止串流…')
    await this.killChild(true)
    // The buffered playout owns two processes; stopping it flushes whatever the
    // pusher still had in hand before the RTMP session is closed.
    if (this.playout) {
      const playout = this.playout
      this.playout = null
      await playout.stop()
    }
    this.pass = null
    this.drain = null
    this.airedPasses = []
    this.publishedSec = 0
    this.state = 'idle'
    this.connected = false
    this.currentIndex = -1
    this.positionSec = 0
    this.startPositionSec = 0
    this.completedSec = 0
    this.itemDuration = 0
    this.speed = 0
    this.bitrateKbps = 0
    this.startedAt = null
    for (const item of this.items) {
      if (item.status === 'live' || item.status === 'preparing') item.status = 'pending'
    }
    this.emitPlaylist()
    this.emitStatus()
    this.log('info', '串流已停止。')
    return this.getStatus()
  }

  /** Skip to the next playlist entry; the last entry ends the session. */
  async skipNext(reason = '手动跳过'): Promise<EngineStatus> {
    if (this.currentIndex < 0 || this.state === 'idle') {
      this.log('warn', '当前没有正在串流的文件。')
      return this.getStatus()
    }
    this.log('info', `${reason}：切到下一个文件。`)
    this.setItemStatus(this.currentIndex, 'skipped')
    await this.advanceTo(this.currentIndex + 1, 'skip')
    return this.getStatus()
  }

  /** Jump straight to a specific playlist entry. */
  async jumpToItem(itemId: string): Promise<EngineStatus> {
    const index = this.items.findIndex((i) => i.id === itemId)
    if (index < 0) {
      this.log('warn', '找不到指定的播放列表项。')
      return this.getStatus()
    }
    for (let i = 0; i < index; i += 1) {
      const st = this.items[i].status
      if (st !== 'done') this.items[i].status = 'skipped'
    }
    this.emitPlaylist()
    this.log('info', `跳转到「${this.items[index].name}」。`)
    if (this.state === 'idle') {
      return this.start(index)
    }
    await this.advanceTo(index, 'jump')
    return this.getStatus()
  }

  /* ------------------------------------------------------------ *
   * Launch / lifecycle
   * ------------------------------------------------------------ */

  private cancelTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private async killChild(graceful: boolean): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, graceful ? 3500 : 400)
      child.once('close', () => {
        clearTimeout(t)
        resolve()
      })
    })
    if (graceful) {
      try {
        child.stdin.write('q')
      } catch {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    await done
  }

  private async advanceTo(index: number, reason: 'finish' | 'skip' | 'jump' | 'retry'): Promise<void> {
    const settings = this.deps.getSettings()
    if (index >= this.items.length) {
      if (settings.output.loopPlaylist) {
        this.log('info', '播放列表结束，按设置循环回第一个文件。')
        for (const item of this.items) item.status = 'pending'
        this.completedSec = 0
        this.emitPlaylist()
        await this.launchCurrentFrom(0, 0, reason)
        return
      }
      // Buffered playout: the files are all encoded, but the pusher is paced at
      // 1x and still holds a backlog. Closing the session here would cut the
      // viewer off mid-file and reset the RTMP timeline, so the run waits for the
      // backlog to air first.
      if (this.playout && this.playout.isPusherRunning()) {
        const waitingForSec = this.playout.getNextOffset()
        const published = this.playout.getPublishedSec()
        if (published < waitingForSec - DRAIN_TOLERANCE_SEC) {
          const now = Date.now()
          this.drain = { startedAt: now, lastProgressAt: now, waitingForSec }
          this.state = 'draining'
          this.emitStatus()
          this.log(
            'info',
            `播放列表已全部编码完成，正在按 1× 播出剩余缓冲（还需约 ${formatDuration(waitingForSec - published)}）。`
          )
          return
        }
      }
      this.log('info', '播放列表全部完成，串流结束。')
      await this.finishSession(true)
      return
    }
    await this.launchCurrentFrom(index, 0, reason)
  }

  /**
   * Closes the RTMP session and returns the engine to idle.
   *
   * `playedOut` says whether the queue actually ran to the end. Entry statuses are
   * driven by the published position (see `markPlayedThrough`), which by design marks
   * an entry done only when the pusher moves PAST it — so the final entry is still
   * `live` when the queue finishes. This is where that last one is closed out, and
   * only when the queue really did play out: after a manual stop or a failure, an
   * entry that never aired must not be reported as finished.
   */
  private async finishSession(playedOut = false): Promise<void> {
    this.drain = null
    /*
     * Resolve the queue BEFORE anything is awaited.
     *
     * `state = 'idle'` is what tells the UI (and the tests) the session is over, and
     * it is reached only after the publisher is stopped. Marking the entries after
     * that await leaves a window where the session already reads as finished while
     * the queue still shows the last entry as `live` — a snapshot taken in that window
     * says the run ended without playing its final file.
     */
    if (playedOut) {
      let changed = false
      for (const item of this.items) {
        if (item.status === 'live' || item.status === 'preparing' || item.status === 'pending') {
          item.status = 'done'
          changed = true
        }
      }
      if (changed) this.emitPlaylist()
    }
    await this.killChild(true)
    // The playout owns the RTMP session, so ending the run has to end it too. It
    // must also be dropped here: a kept-but-stopped playout still holds its dead
    // pusher, and the next session would hand it new encoder passes that nobody
    // publishes (`Playout.start` returns early while it believes a pusher exists).
    if (this.playout) {
      const playout = this.playout
      this.playout = null
      await playout.stop()
    }
    this.state = 'idle'
    this.connected = false
    this.positionSec = 0
    this.currentIndex = -1
    this.startedAt = null
    this.emitStatus()
  }

  private async launchCurrent(positionSec: number, reason: string): Promise<void> {
    await this.launchCurrentFrom(this.currentIndex, positionSec, reason)
  }

  private async launchCurrentFrom(index: number, positionSec: number, reason: string): Promise<void> {
    const item = this.items[index]
    if (!item) return

    await this.killChild(true)
    this.cancelTimers()
    const generation = ++this.generation
    this.currentIndex = index
    this.startPositionSec = positionSec
    // Position and the derived session total are set together, so a seek cannot
    // leave the total pointing at where playback used to be.
    this.setPosition(positionSec)
    // Raw ffmpeg timeline: rebased to zero by an input seek, so it starts at 0 for
    // every pass regardless of where the pass begins.
    this.outTimeSec = 0
    this.speed = 0
    this.fps = 0
    this.bitrateKbps = 0
    this.frame = 0
    this.droppedFrames = 0
    this.connected = false
    this.stopping = false
    this.emitStatus()

    /* --- probe (cached) --- */
    this.state = 'preparing'
    this.setItemStatus(index, 'preparing')
    this.emitStatus()
    let media = this.deps.getMedia(item.path)
    if (!media) {
      media = await this.deps.probeMedia(item.path)
    }
    if (generation !== this.generation) return

    if (!media.videoStreams.length && !media.audioStreams.length) {
      const msg = media.probeError || '无法读取媒体流信息'
      this.log('error', `「${item.name}」${msg}，已跳过该文件。`)
      this.setItemStatus(index, 'error', msg)
      this.state = 'error'
      this.emitStatus()
      this.restartTimer = setTimeout(() => {
        void this.advanceTo(index + 1, 'finish')
      }, 800)
      return
    }

    this.itemDuration = media.durationSec || item.durationSec || 0
    if (media.durationSec && Math.abs(media.durationSec - item.durationSec) > 1) {
      item.durationSec = media.durationSec
      this.emitPlaylist()
    }

    /* --- build the command --- */
    const settings = this.deps.getSettings()

    /* Two-process playout: encoder ahead of a pacing pusher.
     *
     * With buffering enabled the session runs as encoder -> TS buffer -> pusher
     * (see playout.ts). The pusher owns the RTMP session and outlives every encoder
     * restart, which is what makes a file change cheap and absorbs short encoding
     * stalls. The MPEG-TS relay carries H.264 and HEVC but not AV1, so AV1 falls
     * back to the single-process FLV path below (ffmpeg writes AV1 as Enhanced-RTMP
     * `av01` directly). */
    if (bufferedMode(settings.output)) {
      if (bufferedRelaySupportsCodec(settings)) {
        await this.launchBuffered(index, item, media, positionSec, reason, generation)
        return
      }
      if (reason !== 'retry') {
        this.log('info', 'AV1 无法通过 MPEG-TS 缓冲中转（MPEG-TS 不支持 AV1），本次改用单进程直推 FLV（Enhanced-RTMP av01）。')
      }
    }

    let built: BuiltCommand
    try {
      built = buildStreamCommand({
        ffmpegPath: this.deps.getFfmpegPath(),
        media,
        item,
        settings,
        startPositionSec: positionSec
      })
    } catch (err) {
      this.log('error', `构建 ffmpeg 命令失败: ${String(err)}`)
      this.setItemStatus(index, 'error', String(err))
      this.state = 'error'
      this.emitStatus()
      return
    }
    this.commandLine = built.commandLine
    this.lastWarnings = built.warnings

    if (reason !== 'retry' || positionSec === 0) {
      this.log('info', `▸ 正在准备「${item.name}」${positionSec > 0 ? `（从 ${formatDuration(positionSec)} 开始）` : ''}`)
      // Log exactly what was found, so "the stream had no video" is diagnosable
      // from the log alone.
      this.log('debug', `   文件: ${item.path}`)
      this.log('debug', `   ${describeStreams(media)}`)
      if (built.videoStreamIndex >= 0) {
        const v = media.videoStreams.find((s) => s.index === built.videoStreamIndex)
        this.log(
          'debug',
          `   选用视频流 #${built.videoStreamIndex}${v ? ` (${v.codec} ${v.width}x${v.height} @ ${v.fps ?? '?'}fps)` : ''}`
        )
      }
      if (built.audioStreamIndex >= 0) {
        const a = media.audioStreams.find((s) => s.index === built.audioStreamIndex)
        this.log(
          'debug',
          `   选用音频流 #${built.audioStreamIndex}${a ? ` (${a.codec} ${a.channels ?? '?'}ch @ ${a.sampleRate ?? '?'}Hz)` : ''}`
        )
      }
      for (const line of built.summary) this.log('debug', `   ${line}`)
    }
    if (built.videoStreamIndex < 0) {
      this.log('warn', '本次编码没有选中任何视频流，推流将是纯音频。')
    }
    for (const w of built.warnings) this.log('warn', w)
    this.log('ffmpeg', built.commandLine)

    /* --- spawn --- */
    const ffmpeg = this.deps.getFfmpegPath()
    this.state = 'connecting'
    this.emitStatus()

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(ffmpeg, built.args, { windowsHide: true }) as ChildProcessWithoutNullStreams
    } catch (err) {
      this.log('error', `无法启动 ffmpeg: ${String(err)}`)
      this.setItemStatus(index, 'error', String(err))
      this.state = 'error'
      this.emitStatus()
      return
    }
    this.child = child
    this.state = 'live'
    this.connected = true
    this.setItemStatus(index, 'live')
    this.emitStatus()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk, generation))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk, generation))
    child.on('error', (err) => {
      if (generation !== this.generation) return
      this.log('error', `ffmpeg 进程错误: ${err.message}`)
      this.setItemStatus(index, 'error', err.message)
    })
    child.on('close', (code, signal) => {
      void this.onClose(generation, index, code, signal)
    })
  }

  /* ------------------------------------------------------------ *
   * Two-process playout (bufferSec > 0)
   * ------------------------------------------------------------ */

  /**
   * Feeds one playlist entry to the buffered playout.
   *
   * The pusher is created once per session and then left alone: every later call
   * (next file, skip, seek) only replaces the encoder, so the RTMP publish
   * session survives and the player never re-buffers. Each pass carries a
   * timeline offset so the published stream stays continuous across restarts.
   */
  private async launchBuffered(
    index: number,
    item: PlaylistItem,
    media: MediaInfo,
    positionSec: number,
    reason: string,
    generation: number
  ): Promise<void> {
    const settings = this.deps.getSettings()
    const ffmpeg = this.deps.getFfmpegPath()

    let args: string[]
    try {
      const built = buildEncoderArgs({ ffmpegPath: ffmpeg, media, item, settings, startPositionSec: positionSec })
      args = built.args
      this.lastWarnings = built.warnings
      if (reason !== 'retry' || positionSec === 0) {
        this.log('info', `▸ 正在准备「${item.name}」${positionSec > 0 ? `（从 ${formatDuration(positionSec)} 开始）` : ''}`)
        this.log('debug', `   文件: ${item.path}`)
        this.log('debug', `   ${describeStreams(media)}`)
        for (const line of built.summary) this.log('debug', `   ${line}`)
      }
      for (const w of built.warnings) this.log('warn', w)
      if (generation !== this.generation) return
    } catch (err) {
      this.log('error', `构建编码参数失败: ${String(err)}`)
      this.setItemStatus(index, 'error', String(err))
      this.state = 'error'
      this.emitStatus()
      return
    }

    this.itemDuration = media.durationSec || item.durationSec || 0
    this.currentIndex = index
    this.startPositionSec = positionSec
    this.positionSec = positionSec

    if (!this.playout) {
      this.playout = new Playout(
        ffmpeg,
        this.buildPusherArgs(settings),
        bufferLeadLimitSec(settings.output),
        {
          log: (level, message) => this.log(level, message),
          onPublished: (seconds) => this.onPublished(seconds),
          onPusherExit: (code) => this.onPusherExit(code),
          onEncoderExit: (code, materialSec) => this.onEncoderExit(code, materialSec)
        }
      )
      this.log(
        'info',
        `已启用缓冲推流：编码最多领先推流 ${bufferLeadLimitSec(settings.output)}s（超出即暂停编码输出），换文件时靠这段缓冲过渡。`
      )
    }

    /*
     * Whether this file continues the session or opens a new one.
     *
     * `finish` (and the natural start of the queue) means the previous file simply
     * ended: the pusher has aired everything handed to it, so only the encoder is
     * replaced and the RTMP session — and every viewer's connection — survives. That
     * is the entire point of running two processes.
     *
     * `skip` and `jump` are different in kind. The encoder runs ahead on purpose, so
     * the requested file is usually already encoded and sitting in the buffer behind
     * content the viewer has not watched. A published timeline only moves forward, so
     * that backlog cannot be skipped over: the session is ended and reopened at the
     * requested file, and the buffer is discarded with it.
     */
    const restartSession = this.playout.isPusherRunning() && (reason === 'skip' || reason === 'jump')
    const tsOffset = restartSession
      ? positionSec > 0.05
        ? PASS_START_MARGIN_SEC
        : 0
      : this.playout.getNextOffset() + (positionSec > 0.05 ? PASS_START_MARGIN_SEC : 0)
    const expectedSec = Math.max(0, this.itemDuration - positionSec)
    if (restartSession) {
      // The timeline restarts with the session, so what the viewer is watching is
      // reported against the new one from here on.
      this.airedPasses = []
      this.publishedSec = 0
      this.drain = null
    }
    this.pass = { index, startSec: positionSec, itemDurationSec: this.itemDuration, tsOffset }
    // Recorded before the encoder starts, so a pusher that crosses into this pass
    // while it is still being built is already reported as watching it.
    if (this.airedPasses.at(-1)?.tsOffset !== tsOffset) this.airedPasses.push({ ...this.pass })

    const pass = { input: item.path, args, startPositionSec: positionSec, tsOffset, expectedSec }
    if (restartSession) {
      /*
       * The session is being replaced, so nothing the playout reports until it is
       * back counts as progress: the old pass is being killed and the new one may
       * finish encoding long before the new publisher has even connected. Treating
       * that as "a file completed" ends the playlist — which tears down the very
       * session the restart is opening (measured: the jump was cancelled by the
       * completion of the file it was jumping to).
       */
      this.restartingSession = true
      try {
        await this.playout.restartSession(pass)
      } finally {
        this.restartingSession = false
      }
      // The new pass has been handed over and will air from the start of the file.
      this.pass = { index, startSec: positionSec, itemDurationSec: this.itemDuration, tsOffset }
      this.airedPasses = [{ ...this.pass }]
    } else if (this.playout.isPusherRunning()) {
      this.playout.restartEncoder(pass)
    } else {
      await this.playout.start(pass)
    }

    this.state = 'live'
    this.connected = true
    /*
     * The entry is marked `preparing`, not `live`.
     *
     * "Live" means the viewer can see it, and in this pipeline being handed to the
     * encoder is not that: the encoder runs ahead, so an entry can be fully encoded
     * while the viewer is still several files back. `markPlayedThrough` promotes it
     * to `live` when the publisher actually reaches it, which is the same rule that
     * marks earlier entries `done`.
     */
    this.setItemStatus(index, 'preparing')
    this.emitStatus()
  }

  /** The pusher's arguments: the muxer, extra flags and the RTMP destination. */
  private buildPusherArgs(settings: SessionSettings): string[] {
    const out = settings.output
    return [
      '-flvflags',
      'no_duration_filesize',
      ...(out.extraOutputArgs.trim() ? out.extraOutputArgs.trim().split(/\s+/) : []),
      '-f',
      CONTAINER_MUXER[out.container],
      buildRtmpTarget(out.server, out.streamKey)
    ]
  }

  /**
   * The pusher reported how far it has published.
   *
   * Its timeline is the session timeline and only moves forward, so the media
   * position is that value minus the offset of the pass the pusher has reached.
   */
  private onPublished(seconds: number): void {
    /*
     * A publisher that is being torn down keeps reporting for a moment, and those
     * late blocks still name the pass that just aired. Acting on them re-opens an
     * entry the session already closed out — measured: the final entry was marked
     * done by `finishSession` and then flipped straight back to `live` by the last
     * report of the dead pusher, so the queue claimed the run ended mid-file.
     */
    if (this.stopping || this.state === 'idle') return
    // Progress, not elapsed time, is what proves the pusher is still working, so
    // the drain stall guard measures inactivity rather than duration.
    if (seconds > this.publishedSec && this.drain) this.drain.lastProgressAt = Date.now()
    this.publishedSec = seconds
    // In buffered mode the encoder runs ahead of the viewer, so what is on screen
    // is decided by which pass boundary the pusher has crossed — not by the pass
    // currently being encoded. Reporting the latter would jump the progress bar to
    // a file the viewer has not reached yet, and during the drain phase (no encoder
    // running at all) it would leave the position stuck at the last file's start.
    const live = this.passAt(seconds)
    if (live) {
      this.itemDuration = live.itemDurationSec
      this.currentIndex = live.index
      this.setPosition(live.startSec + Math.max(0, seconds - live.tsOffset))
      this.markPlayedThrough(live)
    }
    // In buffered mode the live figures belong to the *encoder* (which runs at its
    // own pace, above 1x), so they travel separately instead of being mixed into
    // the numbers that describe what the viewer receives.
    const enc = this.playout?.getEncoderStats()
    if (enc) this.encoderStats = enc
    this.emitStatus()
    this.checkDrainComplete()
  }

  /**
   * Marks playlist entries as aired, driven ONLY by the published position.
   *
   * This is the viewer's progress, and it is the only progress a playlist status may
   * reflect in either pipeline: what the encoder has finished is not what has been
   * sent, and in buffered mode the two can be a long way apart — the encoder can have
   * the whole queue done while the viewer is still in the first file. Marking on the
   * encoder's exit used to paint the entire list "已完成" within seconds of starting
   * and leave it there for the rest of the session.
   *
   * The current entry is reported `live`; every entry the pusher has passed is
   * `done`. Entries already resolved by the user (`skipped`) or by an error keep
   * whatever they were given — a skip is a decision, not a playback state, and
   * overwriting it would make the queue look like it played everything.
   */
  private markPlayedThrough(live: { index: number; startSec: number; tsOffset: number }): void {
    let changed = false
    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i]
      /*
       * The session timeline only moves forward, so an entry the viewer has already
       * passed can never become current again. Holding onto `done` is what makes the
       * queue immune to a report that arrives out of order or after the fact.
       */
      const desired: PlaylistItemStatus | null =
        item.status === 'done' ? 'done' : i < live.index ? 'done' : i === live.index ? 'live' : null
      // Entries the user resolved (`skipped`) or that failed keep what they were
      // given: a skip is a decision, not a playback state, and overwriting it would
      // make the queue claim it played something it never did.
      if (desired === null || item.status === 'skipped' || item.status === 'error') continue
      if (item.status !== desired) {
        item.status = desired
        changed = true
      }
    }
    if (changed) this.emitPlaylist()
  }

  /**
   * The pass the pusher is currently airing: the last boundary it has reached.
   *
   * Both the start of the session and the very first seconds of a pass fall before
   * that pass's first reported timestamp, so the newest pass whose offset lies
   * below the published position is the right answer, with the oldest pass as the
   * fallback while the pusher is still waiting for its first packet.
   */
  private passAt(
    seconds: number
  ): { index: number; startSec: number; itemDurationSec: number; tsOffset: number } | null {
    let found: { index: number; startSec: number; itemDurationSec: number; tsOffset: number } | null = null
    for (const p of this.airedPasses) {
      if (seconds >= p.tsOffset - 0.001) found = p
      else break
    }
    return found ?? this.airedPasses.at(-1) ?? null
  }

  /**
   * Ends the session once the pusher has published everything that was encoded.
   *
   * Buffered playout only: the encoder finishes the whole playlist in a few
   * seconds and the material then takes its own length to air, so the run is over
   * when the timeline the pusher reports catches up with the timeline the encoder
   * handed over. The stall guard exists because a publisher that stops reporting
   * while still running is a fault (a dead RTMP connection), not content.
   */
  private checkDrainComplete(): void {
    const drain = this.drain
    if (!drain || this.stopping) return
    const now = Date.now()
    let playedOut = false
    if (this.publishedSec >= drain.waitingForSec - DRAIN_TOLERANCE_SEC) {
      this.log('info', `缓冲已全部播出（${this.publishedSec.toFixed(1)}s），串流结束。`)
      playedOut = true
    } else if (now - drain.lastProgressAt > DRAIN_STALL_MS) {
      this.log(
        'warn',
        `推流进程在 ${this.publishedSec.toFixed(1)}s 处停止推进（已交付 ${drain.waitingForSec.toFixed(1)}s），提前结束会话。`
      )
    } else if ((now - drain.startedAt) / 1000 > drain.waitingForSec + DRAIN_MAX_SEC) {
      this.log('warn', `播出剩余缓冲超过预期上限（${drain.waitingForSec.toFixed(1)}s），提前结束会话。`)
    } else {
      return
    }
    // The drained queue itself is the queue played out; a stalled publisher is not.
    void this.finishSession(playedOut)
  }

  /** An encoder pass ended: what it produced is now part of the stream. */
  private onEncoderExit(code: number | null, materialSec: number): void {
    // A restart is tearing this pass down; the parts belong to the session that is
    // being closed, not to the queue (see `restartingSession`).
    if (this.stopping || this.restartingSession || !this.pass) return
    const index = this.pass.index
    const item = this.items[index]
    if (code !== 0) {
      this.log('warn', `「${item?.name ?? '文件'}」编码进程异常结束（退出码 ${code ?? '未知'}），已产出的部分仍会继续播放。`)
      this.setItemStatus(index, 'error', `编码进程退出码 ${code ?? '未知'}`)
      this.emitStatus()
    }
    this.log('info', `✔ 「${item?.name ?? '文件'}」编码完成，已交给推流进程（${materialSec.toFixed(1)}s）。`)
    /*
     * Being encoded is NOT being streamed, so the entry is not marked done here.
     *
     * In buffered mode the encoder hands over a whole file long before the viewer
     * finishes it — it can have the entire queue done while the viewer is still in
     * the first entry. The status is advanced from the published position instead
     * (see `markPlayedThrough`), which is what the viewer actually received and is
     * equally right for the single-process pipeline.
     */
    const gapMs = Math.max(0, Math.min(30, this.deps.getSettings().output.gapBetweenItemsSec ?? 1)) * 1000
    this.restartTimer = setTimeout(() => {
      void this.advanceTo(index + 1, 'finish')
    }, Math.max(150, gapMs))
  }

  /** The pusher died: that *is* the RTMP session, so the run is over. */
  private onPusherExit(code: number | null): void {
    if (this.stopping) return
    this.connected = false
    // The buffered playout is the RTMP session, so a dead publisher takes it with
    // it: without this the engine keeps handing encoder passes to a playout whose
    // reader is gone, and a later attempt to continue silently publishes nothing.
    if (this.playout) {
      const playout = this.playout
      this.playout = null
      this.airedPasses = []
      this.publishedSec = 0
      this.drain = null
      void playout.stop()
    }
    /*
     * A publish that failed is retried before the run is given up on.
     *
     * This matters most right after a skip or a jump, which ends one publish session
     * and immediately opens another: the server may still be tearing the previous one
     * down, and losing the session to that race would turn a working skip into a
     * dropped stream. Retrying replays the position the viewer is at rather than
     * resuming mid-buffer, because the playout — and its buffer — are gone.
     */
    const settings = this.deps.getSettings()
    if (settings.output.maxReconnectAttempts > 0 && this.reconnectCount < settings.output.maxReconnectAttempts) {
      this.reconnectCount += 1
      const delayMs = Math.max(1, settings.output.reconnectDelaySec) * 1000
      this.state = 'reconnecting'
      this.emitStatus()
      this.log(
        'warn',
        `推流进程结束（退出码 ${code ?? '未知'}），${delayMs / 1000}s 后重试（第 ${this.reconnectCount}/${settings.output.maxReconnectAttempts} 次）…`
      )
      this.reconnectTimer = setTimeout(() => {
        if (this.stopping) return
        void this.launchCurrentFrom(this.currentIndex, Math.max(0, this.positionSec), 'retry')
      }, delayMs)
      return
    }
    this.state = 'error'
    this.emitStatus()
    this.log('error', `推流进程结束（退出码 ${code ?? '未知'}），串流中断。`)
  }

  private sumDurationsBefore(index: number): number {
    let sum = 0
    for (let i = 0; i < index && i < this.items.length; i += 1) sum += this.items[i].durationSec || 0
    return sum
  }

  /* ------------------------------------------------------------ *
   * ffmpeg output parsing
   * ------------------------------------------------------------ */

  private onStdout(chunk: string, generation: number): void {
    if (generation !== this.generation) return
    this.stdoutBuf += chunk
    const lines = this.stdoutBuf.split(/\r?\n/)
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      switch (key) {
        case 'out_time_us':
        case 'out_time_ms': {
          const micro = Number(value)
          if (Number.isFinite(micro)) {
            const elapsed = micro / 1_000_000
            // ffmpeg's `-progress` timeline is relative to the *output*, and after
            // an input seek the output is rebased to zero: seeking to 12s in a 20s
            // file reports 8s of material, not 20s. `positionSec` therefore has to
            // be the seek offset plus what ffmpeg has produced since — using the
            // reported value directly made the bar jump backwards at every seek and
            // never reach the end.
            if (elapsed > this.outTimeSec - 1) {
              this.outTimeSec = elapsed
              // ffmpeg's `-progress` timeline is relative to the *output*, and after
              // an input seek the output is rebased to zero: seeking to 12s in a 20s
              // file reports 8s of material, not 20s. The position inside the file is
              // therefore the seek offset plus what ffmpeg has produced since — using
              // the reported value directly made the bar jump backwards at every seek
              // and never reach the end.
              this.setPosition(this.startPositionSec + elapsed)
            }
          }
          break
        }
        case 'speed': {
          const v = Number(value.replace('x', ''))
          if (Number.isFinite(v)) this.speed = v
          break
        }
        case 'fps': {
          const v = Number(value)
          if (Number.isFinite(v) && v > 0) this.fps = v
          break
        }
        case 'bitrate': {
          const v = Number(value.replace(/kbits\/s/i, '').trim())
          if (Number.isFinite(v) && v > 0) {
            this.bitrateKbps = v
            if (!this.connected) {
              this.connected = true
              this.log('info', 'RTMP 服务器已接收数据流。')
            }
          }
          break
        }
        case 'frame': {
          const v = Number(value)
          if (Number.isFinite(v)) this.frame = v
          break
        }
        case 'drop_frames': {
          const v = Number(value)
          if (Number.isFinite(v)) this.droppedFrames = v
          break
        }
        case 'progress': {
          this.emitStatus()
          break
        }
        default:
          break
      }
    }
  }

  private isNoisy(line: string): boolean {
    if (!line.trim()) return true
    // Periodic per-stream statistics; `-progress` already gives us these numbers.
    if (/^\s*(frame=|size=|video:|audio:|subtitle:)/.test(line)) return true
    return false
  }

  private classifyStderr(line: string): LogLevel {
    const l = line.toLowerCase()
    if (l.includes('error') || l.includes('failed') || l.includes('invalid') || l.includes('unable to')) return 'error'
    if (l.includes('warning') || l.includes('deprecated')) return 'warn'
    return 'ffmpeg'
  }

  private onStderr(chunk: string, generation: number): void {
    if (generation !== this.generation) return
    this.stderrBuf += chunk
    const lines = this.stderrBuf.split(/\r?\n/)
    this.stderrBuf = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')
      if (this.isNoisy(line)) continue
      if (line === this.lastStderrLine) {
        this.lastStderrRepeat += 1
        if (this.lastStderrRepeat % 50 === 0) this.log('ffmpeg', `${line}  (×${this.lastStderrRepeat + 1})`)
        continue
      }
      this.lastStderrLine = line
      this.lastStderrRepeat = 0
      this.log(this.classifyStderr(line), line)
      if (/Connection|Server error|Unauthorized|timed out|Broken pipe|Cannot open connection|av_interleaved_write_frame/i.test(line)) {
        this.connected = false
        this.emitStatus()
      }
    }
  }

  private async onClose(
    generation: number,
    index: number,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    if (generation !== this.generation) return
    this.child = null
    this.connected = false

    if (this.stopping) {
      this.emitStatus()
      return
    }

    const item = this.items[index]
    const settings = this.deps.getSettings()
    /**
     * A publish that ends on its own had nothing left to send, so it counts as
     * finishing the file. This must not depend solely on `positionSec`: the
     * position is derived from ffmpeg's progress reports, and the last report of
     * a short tail (after a seek, or a file whose last block is cut mid-second)
     * can sit just under the end. A premature exit is a non-zero code, and a
     * forced stop is filtered out above.
     */
    const reachedEnd = this.itemDuration > 0 && this.positionSec >= this.itemDuration - COMPLETION_TOLERANCE_SEC
    const cleanExit = code === 0 || signal === 'SIGINT'

    if (reachedEnd || cleanExit) {
      this.setItemStatus(index, 'done')
      this.completedSec = this.sumDurationsBefore(index) + (item?.durationSec ?? 0)
      this.positionSec = item?.durationSec ?? this.positionSec
      this.emitStatus()
      this.log('info', `✔ 「${item?.name ?? '文件'}」串流完成。`)
      // Advancing opens a fresh RTMP publish session, so give the server a moment
      // to release the stream key before the next ffmpeg connects.
      const gapMs = Math.max(0, Math.min(30, settings.output.gapBetweenItemsSec ?? 1)) * 1000 + 300
      this.state = 'preparing'
      this.emitStatus()
      this.restartTimer = setTimeout(() => {
        void this.advanceTo(index + 1, 'finish')
      }, gapMs)
      return
    }

    /* Premature exit: attempt reconnection. */
    const detail = code === null ? `信号 ${signal ?? '未知'}` : `退出码 ${code}`
    if (settings.output.maxReconnectAttempts <= 0 || this.reconnectCount >= settings.output.maxReconnectAttempts) {
      this.log('error', `ffmpeg 异常结束（${detail}），已达到最大重连次数。`)
      this.setItemStatus(index, 'error', `ffmpeg 异常结束（${detail}）`)
      this.state = 'error'
      this.emitStatus()
      return
    }

    this.reconnectCount += 1
    const delay = Math.max(1, settings.output.reconnectDelaySec) * 1000
    this.state = 'reconnecting'
    this.emitStatus()
    this.log('warn', `ffmpeg 异常结束（${detail}），${delay / 1000}s 后从 ${formatDuration(this.positionSec)} 重连（第 ${this.reconnectCount}/${settings.output.maxReconnectAttempts} 次）…`)
    this.reconnectTimer = setTimeout(() => {
      void this.launchCurrentFrom(index, Math.max(0, this.positionSec - 1), 'retry')
    }, delay)
  }

  /* ------------------------------------------------------------ *
   * External helpers
   * ------------------------------------------------------------ */

  /** Merge freshly probed media info into a playlist item without touching playback. */
  updateItemMedia(itemId: string, media: MediaInfo): void {
    const item = this.items.find((i) => i.id === itemId)
    if (!item) return
    item.durationSec = media.durationSec || item.durationSec
    item.size = media.size || item.size
    this.emitPlaylist()
  }

  getCommandPreview(): string {
    if (this.commandLine) return this.commandLine
    const item = this.items[this.currentIndex] ?? this.items[0]
    if (!item) return '（播放列表为空，请先添加视频文件）'
    const media = this.deps.getMedia(item.path)
    if (!media) return '（正在等待媒体信息探测完成）'
    try {
      return buildStreamCommand({
        ffmpegPath: this.deps.getFfmpegPath() || 'ffmpeg',
        media,
        item,
        settings: this.deps.getSettings(),
        startPositionSec: 0
      }).commandLine
    } catch (err) {
      return `（无法生成命令: ${String(err)}）`
    }
  }

  getLastWarnings(): string[] {
    return this.lastWarnings
  }

  isActive(): boolean {
    return this.state !== 'idle' && this.state !== 'error'
  }

  getCurrentItemPath(): string | null {
    const item = this.items[this.currentIndex]
    return item ? path.resolve(item.path) : null
  }
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export { COMPLETION_TOLERANCE_SEC }
