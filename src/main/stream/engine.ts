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
import type { Language } from '@shared/types'
import { mainT } from '../i18n'
import { Playout } from './playout'
import { buildRtmpTarget } from '@shared/rtmp'
import { BUFFER_SEC_MIN, CONTAINER_MUXER } from '@shared/defaults'

export interface EngineDeps {
  getFfmpegPath: () => string
  getSettings: () => SessionSettings
  /** Probe results are provided by the caller so the engine stays I/O free. */
  getMedia: (itemPath: string) => MediaInfo | undefined
  probeMedia: (filePath: string) => Promise<MediaInfo>
  /**
   * The language the log is written in.
   *
   * Supplied rather than imported from the settings store for the same reason as
   * the probes: the engine is driven by integration tests that run it without the
   * application's stores, and the summary/warning text the command builder produces
   * is part of what those tests assert on.
   */
  getLanguage: () => Language
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
 * Delay before the next encoder pass is spawned, in buffered mode.
 *
 * Not a pause between files: the publisher keeps airing through a file change, so the
 * only thing a delay does here is spend the buffer that exists to cover the hand-over.
 * It is kept purely so the next pass is not spawned inside the exit handler of the one
 * before it.
 */
const NEXT_PASS_DELAY_MS = 150

/**
 * Pause before the next file in the single-process pipeline, in milliseconds.
 *
 * That pipeline closes and reopens the RTMP publish session for every file, so the
 * server has to release the stream key first; connecting into a key that is still held
 * makes the ingest reject the publish. It used to be a user setting ("文件间停顿"),
 * which could only ever be wrong: too small and the publish is refused, larger and it
 * is dead air. One second is the value that setting defaulted to.
 */
const REPUBLISH_DELAY_MS = 1000

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
  private encoderPass: { index: number; startSec: number; itemDurationSec: number; tsOffset: number } | null = null
  /**
   * Which entry the ENCODER is working on, and how long it is.
   *
   * Deliberately not `currentIndex`: in buffered mode the encoder is seconds to
   * minutes ahead of the viewer, so the entry being encoded is not the entry on
   * screen. Keeping the two apart is what makes the progress bar honest — driving it
   * from the encoder's entry made it jump to the next file the moment the encoder
   * started it, and jump back when the pusher's next report arrived (measured: the
   * bar sat at 20.0s of 35s for 327ms in the middle of file A). These fields are
   * only read for reporting the encoder's own work (command preview, file path).
   */
  private encoderIndex = -1
  private encoderItemDuration = 0
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
   * A pass that finished while the session was being replaced (see `onEncoderExit`).
   *
   * Replayed once the restart has finished, because dropping it leaves the queue stuck
   * on a file that is already fully encoded.
   */
  private deferredEncoderExit: { index: number; code: number | null; materialSec: number } | null = null
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
   *
   * Everything here describes the VIEWER's position, so in buffered mode it may only
   * be called from the published position, or on the user's own instruction (a skip
   * or a jump restarts the RTMP session, so the viewer really does move at once).
   * Calling it from encoder progress is what made the bar jump ahead at a file change.
   */
  private setPosition(positionSec: number): void {
    const max = this.itemDuration > 0 ? this.itemDuration : positionSec
    const clamped = Math.max(0, Math.min(positionSec, max))
    this.positionSec = clamped
    this.completedSec = this.sumDurationsBefore(this.currentIndex) + clamped
  }

  /**
   * Moves the viewer to an entry and a position inside it.
   *
   * Used only where the viewer's timeline genuinely restarts: opening a session, and
   * a skip/jump that retries or replaces the publish session. A buffered file change
   * does NOT come through here — there the viewer stays where the pusher is until it
   * reports crossing into the next entry.
   *
   * `durationSec` is passed in rather than read from the fields: this is the one place
   * the viewer's file is known before the encoder has confirmed it, and taking the
   * duration from `encoderItemDuration` would silently depend on whether the caller
   * had already stamped the new pass into it. In buffered mode that stale value would
   * be the PREVIOUS file's length; in the single-process pipeline it would be the
   * playlist's own guess instead of what ffprobe measured.
   */
  private moveViewerTo(index: number, positionSec: number, durationSec: number): void {
    this.currentIndex = index
    this.startPositionSec = positionSec
    this.itemDuration = durationSec || this.items[index]?.durationSec || 0
    this.setPosition(positionSec)
  }

  /**
   * Clears the figures that belong to a SESSION rather than to one pass.
   *
   * These describe live output (`speed`, `fps`, `bitrate`, `frame`, the raw ffmpeg
   * timeline), so they are reset once when a run opens and once when it closes — not
   * per encoder pass. Resetting them on every pass blanked the whole status line at
   * each buffered file change, even though the viewer was still mid-file and the
   * pusher had not missed a frame.
   */
  private resetSessionStats(): void {
    this.outTimeSec = 0
    this.speed = 0
    this.fps = 0
    this.bitrateKbps = 0
    this.frame = 0
    this.droppedFrames = 0
    this.encoderStats = null
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
      this.log('warn', mainT('main.engine.playlistEmpty'))
      return this.getStatus()
    }
    if (this.state === 'live' || this.state === 'connecting' || this.state === 'preparing') {
      this.log('info', mainT('main.engine.alreadyStreaming'))
      return this.getStatus()
    }
    this.cancelTimers()
    const ffmpeg = this.deps.getFfmpegPath()
    if (!ffmpeg) {
      this.log('error', mainT('main.engine.noFfmpeg'))
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
    this.resetSessionStats()
    // A new session starts a new RTMP timeline, so the pass log and the published
    // position must not carry over from the previous run.
    this.airedPasses = []
    this.publishedSec = 0
    this.drain = null
    this.encoderPass = null
    this.encoderIndex = -1
    this.encoderItemDuration = 0
    const firstIndex = atIndex !== undefined ? Math.max(0, Math.min(atIndex, this.items.length - 1)) : 0
    /*
     * Opening the session moves the viewer to the first entry, whichever pipeline runs.
     * In buffered mode `launchCurrentFrom` deliberately leaves the viewer's fields
     * alone (the encoder about to start is not what the viewer is watching), so the bar
     * would otherwise sit empty until the pusher's first report — and the item the
     * session is starting at is decided here, not there.
     */
    this.moveViewerTo(firstIndex, 0, this.items[firstIndex]?.durationSec || 0)
    this.emitPlaylist()

    const settings = this.deps.getSettings()
    const target = buildRtmpTarget(settings.output.server, settings.output.streamKey)
    // The full target (which contains the stream key) is only shown in the debug
    // log, not in the UI and not in the info log.
    this.log('info', mainT('main.engine.sessionStarting'))
    this.log('debug', `${mainT('main.engine.streamTarget')}: ${target}`)
    this.log('info', mainT('main.engine.playlistReady', { n: this.items.length, duration: formatDuration(this.items.reduce((s, i) => s + (i.durationSec || 0), 0)) }))

    await this.launchCurrent(0, 'session-start')
    return this.getStatus()
  }

  async stop(): Promise<EngineStatus> {
    if (this.state === 'idle') return this.getStatus()
    this.stopping = true
    this.cancelTimers()
    this.state = 'stopping'
    this.emitStatus()
    this.log('info', mainT('main.engine.stopping'))
    await this.killChild(true)
    // The buffered playout owns two processes; stopping it flushes whatever the
    // pusher still had in hand before the RTMP session is closed.
    if (this.playout) {
      const playout = this.playout
      this.playout = null
      await playout.stop()
    }
    this.encoderPass = null
    this.drain = null
    this.airedPasses = []
    this.publishedSec = 0
    this.state = 'idle'
    this.connected = false
    this.currentIndex = -1
    this.encoderIndex = -1
    this.encoderItemDuration = 0
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
    this.log('info', mainT('main.engine.stopped'))
    return this.getStatus()
  }

  /** Skip to the next playlist entry; the last entry ends the session. */
  async skipNext(reason = mainT('main.engine.skipManual')): Promise<EngineStatus> {
    if (this.currentIndex < 0 || this.state === 'idle') {
      this.log('warn', mainT('main.engine.nothingStreaming'))
      return this.getStatus()
    }
    this.log('info', mainT('main.engine.skipReason', { reason }))
    this.setItemStatus(this.currentIndex, 'skipped')
    await this.advanceTo(this.currentIndex + 1, 'skip')
    return this.getStatus()
  }

  /** Jump straight to a specific playlist entry. */
  async jumpToItem(itemId: string): Promise<EngineStatus> {
    const index = this.items.findIndex((i) => i.id === itemId)
    if (index < 0) {
      this.log('warn', mainT('main.engine.itemNotFound'))
      return this.getStatus()
    }
    for (let i = 0; i < index; i += 1) {
      const st = this.items[i].status
      if (st !== 'done') this.items[i].status = 'skipped'
    }
    this.emitPlaylist()
    this.log('info', mainT('main.engine.jumpingTo', { name: this.items[index].name }))
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
        this.log('info', mainT('main.engine.playlistLooping'))
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
            mainT('main.engine.drainingBuffer', { time: formatDuration(waitingForSec - published) })
          )
          return
        }
      }
      this.log('info', mainT('main.engine.playlistFinished'))
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
    /*
     * Everything below describes what the VIEWER sees, so in buffered mode it is the
     * pusher's job — not this function's. Starting an encoder pass says nothing about
     * where the viewer is: the encoder runs ahead on purpose, so moving the viewer's
     * entry and position here is what made the progress bar jump to the next file the
     * moment the encoder began it and snap back on the pusher's next report, and the
     * per-pass reset of `speed`/`fps`/`bitrate` blanked the status line at every file
     * change. `launchBuffered` sets the encoder-side fields instead; the viewer's move
     * when the pusher actually reaches the entry (or at once, for a skip/jump, which
     * replaces the session the viewer is watching).
     */
    const viewerStateFromThisPass = !bufferedMode(this.deps.getSettings().output)
    if (viewerStateFromThisPass) {
      this.encoderIndex = index
      this.encoderItemDuration = item.durationSec || 0
      this.moveViewerTo(index, positionSec, this.encoderItemDuration)
      // Raw ffmpeg timeline: rebased to zero by an input seek, so it starts at 0 for
      // every pass regardless of where the pass begins.
      this.outTimeSec = 0
      this.speed = 0
      this.fps = 0
      this.bitrateKbps = 0
      this.frame = 0
      this.droppedFrames = 0
    }
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
      const msg = media.probeError || mainT('main.engine.mediaUnreadable')
      this.log('error', mainT('main.engine.itemSkipped', { name: item.name, message: msg }))
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
        this.log('info', mainT('main.engine.av1SingleProcess'))
      }
    }

    let built: BuiltCommand
    try {
      built = buildStreamCommand({
        ffmpegPath: this.deps.getFfmpegPath(),
        media,
        item,
        settings,
        startPositionSec: positionSec,
        // The command builder writes the summary/warning text, so it has to know
        // which language the log is being written in.
        language: this.deps.getLanguage()
      })
    } catch (err) {
      this.log('error', mainT('main.engine.buildFailed', { error: String(err) }))
      this.setItemStatus(index, 'error', String(err))
      this.state = 'error'
      this.emitStatus()
      return
    }
    this.commandLine = built.commandLine
    this.lastWarnings = built.warnings

    if (reason !== 'retry' || positionSec === 0) {
      this.log(
        'info',
        mainT('main.engine.preparingItem', { name: item.name }) +
          (positionSec > 0 ? mainT('main.engine.preparingFrom', { time: formatDuration(positionSec) }) : '')
      )
      // Log exactly what was found, so "the stream had no video" is diagnosable
      // from the log alone.
      this.log('debug', `   ${mainT('main.engine.itemPath')}: ${item.path}`)
      this.log('debug', `   ${describeStreams(media, this.deps.getLanguage())}`)
      if (built.videoStreamIndex >= 0) {
        const v = media.videoStreams.find((s) => s.index === built.videoStreamIndex)
        this.log(
          'debug',
          `   ${mainT('main.engine.selectedVideo', { index: built.videoStreamIndex })}${v ? ` (${v.codec} ${v.width}x${v.height} @ ${v.fps ?? '?'}fps)` : ''}`
        )
      }
      if (built.audioStreamIndex >= 0) {
        const a = media.audioStreams.find((s) => s.index === built.audioStreamIndex)
        this.log(
          'debug',
          `   ${mainT('main.engine.selectedAudio', { index: built.audioStreamIndex })}${a ? ` (${a.codec} ${a.channels ?? '?'}ch @ ${a.sampleRate ?? '?'}Hz)` : ''}`
        )
      }
      for (const line of built.summary) this.log('debug', `   ${line}`)
    }
    if (built.videoStreamIndex < 0) {
      this.log('warn', mainT('main.engine.noVideoSelected'))
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
      this.log('error', mainT('main.engine.spawnFailed', { error: String(err) }))
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
      this.log('error', mainT('main.engine.processError', { error: err.message }))
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
      const built = buildEncoderArgs({ ffmpegPath: ffmpeg, media, item, settings, startPositionSec: positionSec, language: this.deps.getLanguage() })
      args = built.args
      this.lastWarnings = built.warnings
      if (reason !== 'retry' || positionSec === 0) {
        this.log(
          'info',
          mainT('main.engine.preparingItem', { name: item.name }) +
            (positionSec > 0 ? mainT('main.engine.preparingFrom', { time: formatDuration(positionSec) }) : '')
        )
        this.log('debug', `   ${mainT('main.engine.itemPath')}: ${item.path}`)
        this.log('debug', `   ${describeStreams(media, this.deps.getLanguage())}`)
        for (const line of built.summary) this.log('debug', `   ${line}`)
      }
      for (const w of built.warnings) this.log('warn', w)
      if (generation !== this.generation) return
    } catch (err) {
      this.log('error', mainT('main.engine.buildEncoderFailed', { error: String(err) }))
      this.setItemStatus(index, 'error', String(err))
      this.state = 'error'
      this.emitStatus()
      return
    }

    // The encoder's own view of this pass. The viewer's fields are NOT touched here:
    // see the note in `launchCurrentFrom`. What the encoder is producing is reported
    // as a buffer lead (`encodedSec`) and as per-entry "准备中" status, both of which
    // stay on the encoder's side of the line.
    this.encoderIndex = index
    this.encoderItemDuration = media.durationSec || item.durationSec || 0

    /*
     * A pass that has to open the publish session itself: either the playout does not
     * exist yet (a retry after the pusher died drops it — see `onPusherExit`), or the
     * pass is about to replace the session (skip / jump). Either way the published
     * timeline starts over at this entry, so this is also where the viewer moves.
     */
    const resetViewer = !this.playout
    if (!this.playout) {
      this.playout = new Playout(
        ffmpeg,
        this.buildPusherArgs(settings),
        bufferLeadLimitSec(settings.output),
        {
          log: (level, message) => this.log(level, message),
          onPublished: (seconds) => this.onPublished(seconds),
          onPusherExit: (code) => this.onPusherExit(code),
          onEncoderExit: (code, materialSec) => this.onEncoderExit(code, materialSec),
          // The playout writes its own buffer/health lines, so it needs the same
          // lookup the engine uses — resolved per call, so a language switch applies
          // to the next line rather than at the next session.
          t: (key, params) => mainT(key, params)
        }
      )
      this.log(
        'info',
        mainT('main.engine.bufferedEnabled', { sec: bufferLeadLimitSec(settings.output) })
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
    const expectedSec = Math.max(0, this.encoderItemDuration - positionSec)
    if (restartSession) {
      // The timeline restarts with the session, so what the viewer is watching is
      // reported against the new one from here on.
      this.airedPasses = []
      this.publishedSec = 0
      this.drain = null
    }
    /*
     * A new publish session means the viewer's timeline restarts at this entry, so it
     * moves now rather than when the new publisher first reports — and for a skip or a
     * jump that is also what the user just asked for, so waiting would look like the
     * click was ignored. This is the only way a buffered file change moves the viewer;
     * a plain `finish` advance leaves it where the pusher is.
     */
    if (resetViewer || restartSession) this.moveViewerTo(index, positionSec, this.encoderItemDuration)
    this.encoderPass = { index, startSec: positionSec, itemDurationSec: this.encoderItemDuration, tsOffset }
    // Recorded before the encoder starts, so a pusher that crosses into this pass
    // while it is still being built is already reported as watching it.
    if (this.airedPasses.at(-1)?.tsOffset !== tsOffset) this.airedPasses.push({ ...this.encoderPass })

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
      this.encoderPass = { index, startSec: positionSec, itemDurationSec: this.encoderItemDuration, tsOffset }
      this.airedPasses = [{ ...this.encoderPass }]
      /*
       * A pass that finished during the restart was held back (see `onEncoderExit`) and
       * has to be accounted for now: the new publisher is up, so this is the point at
       * which "the file is finished" can be acted on without tearing down the session
       * that was just opened.
       */
      const deferred = this.deferredEncoderExit
      if (deferred) {
        this.deferredEncoderExit = null
        this.handleEncoderExit(deferred.index, deferred.code, deferred.materialSec)
      }
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
      this.log('info', mainT('main.engine.bufferAired', { sec: this.publishedSec.toFixed(1) }))
      playedOut = true
    } else if (now - drain.lastProgressAt > DRAIN_STALL_MS) {
      this.log(
        'warn',
        mainT('main.engine.publisherStalled', { sec: this.publishedSec.toFixed(1), delivered: drain.waitingForSec.toFixed(1) })
      )
    } else if ((now - drain.startedAt) / 1000 > drain.waitingForSec + DRAIN_MAX_SEC) {
      this.log('warn', mainT('main.engine.drainTooLong', { sec: drain.waitingForSec.toFixed(1) }))
    } else {
      return
    }
    // The drained queue itself is the queue played out; a stalled publisher is not.
    void this.finishSession(playedOut)
  }

  /** An encoder pass ended: what it produced is now part of the stream. */
  private onEncoderExit(code: number | null, materialSec: number): void {
    if (this.stopping || !this.encoderPass) return
    const index = this.encoderPass.index
    /*
     * A pass that ends while the session is being replaced cannot be acted on yet: the
     * publisher that is coming up has not connected, and advancing the queue would
     * treat a restart that has not finished as a completed file. It cannot simply be
     * dropped either — a fast encoder finishes a short file inside the restart window
     * (measured: the whole 15 s fixture, while the republish waits for the server to
     * release the key), and a dropped completion leaves the run sitting on a finished
     * file with an empty buffer, never advancing and never ending. So it is held here
     * and replayed when the restart finishes (see `launchBuffered`).
     */
    if (this.restartingSession) {
      this.deferredEncoderExit = { index, code, materialSec }
      return
    }
    this.handleEncoderExit(index, code, materialSec)
  }

  /** Accounts for a finished pass: reports it, then queues the next file. */
  private handleEncoderExit(index: number, code: number | null, materialSec: number): void {
    const item = this.items[index]
    if (code !== 0) {
      this.log(
        'warn',
        mainT('main.engine.encoderCrashed', { name: item?.name ?? mainT('main.engine.file'), code: code ?? mainT('main.engine.unknown') })
      )
      this.setItemStatus(index, 'error', mainT('main.engine.encoderExitCode', { code: code ?? mainT('main.engine.unknown') }))
      this.emitStatus()
    }
    this.log(
      'info',
      mainT('main.engine.encoderDone', { name: item?.name ?? mainT('main.engine.file'), sec: materialSec.toFixed(1) })
    )
    /*
     * Being encoded is NOT being streamed, so the entry is not marked done here.
     *
     * In buffered mode the encoder hands over a whole file long before the viewer
     * finishes it — it can have the entire queue done while the viewer is still in
     * the first entry. The status is advanced from the published position instead
     * (see `markPlayedThrough`), which is what the viewer actually received and is
     * equally right for the single-process pipeline.
     */
    // Buffered mode publishes this file's successor through the SAME RTMP session, so
    // there is nothing to wait for: any pause here is airtime taken out of the buffer
    // that exists to cover the hand-over (measured 5.8–7.5 s of encoder restart). The
    // short delay that remains only keeps the next pass from being spawned inside this
    // pass's own exit handler.
    this.restartTimer = setTimeout(() => {
      void this.advanceTo(index + 1, 'finish')
    }, NEXT_PASS_DELAY_MS)
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
        mainT('main.engine.publisherRetry', {
          code: code ?? mainT('main.engine.unknown'),
          delay: delayMs / 1000,
          n: this.reconnectCount,
          max: settings.output.maxReconnectAttempts
        })
      )
      this.reconnectTimer = setTimeout(() => {
        if (this.stopping) return
        void this.launchCurrentFrom(this.currentIndex, Math.max(0, this.positionSec), 'retry')
      }, delayMs)
      return
    }
    this.state = 'error'
    this.emitStatus()
    this.log('error', mainT('main.engine.publisherLost', { code: code ?? mainT('main.engine.unknown') }))
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
              this.log('info', mainT('main.engine.rtmpAccepted'))
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
      this.log('info', mainT('main.engine.itemDone', { name: item?.name ?? mainT('main.engine.file') }))
      // Single-process only: each file is its own RTMP publish session, so the server
      // needs a moment to release the stream key before the next publish takes it. The
      // buffered pipeline never republishes at a file change and does not wait at all.
      this.state = 'preparing'
      this.emitStatus()
      this.restartTimer = setTimeout(() => {
        void this.advanceTo(index + 1, 'finish')
      }, REPUBLISH_DELAY_MS)
      return
    }

    /* Premature exit: attempt reconnection. */
    const detail =
      code === null
        ? mainT('main.engine.signal', { name: signal ?? mainT('main.engine.unknown') })
        : mainT('main.engine.exitCode', { code })
    if (settings.output.maxReconnectAttempts <= 0 || this.reconnectCount >= settings.output.maxReconnectAttempts) {
      this.log('error', mainT('main.engine.crashNoRetry', { detail }))
      this.setItemStatus(index, 'error', mainT('main.engine.crashDetail', { detail }))
      this.state = 'error'
      this.emitStatus()
      return
    }

    this.reconnectCount += 1
    const delay = Math.max(1, settings.output.reconnectDelaySec) * 1000
    this.state = 'reconnecting'
    this.emitStatus()
    this.log(
      'warn',
      mainT('main.engine.reconnecting', {
        detail,
        delay: delay / 1000,
        time: formatDuration(this.positionSec),
        n: this.reconnectCount,
        max: settings.output.maxReconnectAttempts
      })
    )
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

  /**
   * The entry the preview and the "show in folder" action should describe.
   *
   * The ENCODER's entry, not the viewer's: this answers "what is this app encoding
   * right now", and in buffered mode the two are different files for most of a
   * session. Falls back to the viewer's entry (and then to the first one) before any
   * encoder pass has been started.
   */
  private encoderItem(): PlaylistItem | undefined {
    return this.items[this.encoderIndex] ?? this.items[this.currentIndex] ?? this.items[0]
  }

  getCommandPreview(): string {
    if (this.commandLine) return this.commandLine
    const item = this.encoderItem()
    if (!item) return mainT('main.engine.previewEmpty')
    const media = this.deps.getMedia(item.path)
    if (!media) return mainT('main.engine.previewProbing')
    try {
      return buildStreamCommand({
        ffmpegPath: this.deps.getFfmpegPath() || 'ffmpeg',
        media,
        item,
        settings: this.deps.getSettings(),
        startPositionSec: 0,
        language: this.deps.getLanguage()
      }).commandLine
    } catch (err) {
      return mainT('main.engine.previewFailed', { error: String(err) })
    }
  }

  getLastWarnings(): string[] {
    return this.lastWarnings
  }

  isActive(): boolean {
    return this.state !== 'idle' && this.state !== 'error'
  }

  getCurrentItemPath(): string | null {
    const item = this.encoderItem()
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
