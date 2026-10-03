import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { LogLevel } from '@shared/types'

/**
 * Two-process playout: an encoder writes MPEG-TS segments, a long-lived pusher
 * publishes them to RTMP.
 *
 *   encoder ffmpeg --(MPEG-TS on stdout)--> Node relay --> pusher stdin --(-re)--> RTMP
 *
 * Why it is split in two:
 *  - the encoder runs FLAT OUT (no `-re`). It is limited by the encoder rather
 *    than by wall clock, so a hardware encoder that needs a moment to warm up, or
 *    that dips below 1x on a hard scene, no longer dictates what the viewer gets;
 *  - the pusher paces the published stream with `-re` at exactly 1x, and it is a
 *    separate process, so a file change only restarts the encoder.
 *
 * ## File descriptors are part of the contract
 *
 * MPEG-TS is binary and every byte of it matters, so it gets a file descriptor to
 * itself and NOTHING else is allowed on it:
 *
 *   fd 1  encoder stdout -> raw MPEG-TS, relayed to the pusher's stdin verbatim
 *   fd 2  encoder stderr -> ffmpeg's own log
 *   fd 3  `-progress`    -> machine-readable progress, parsed for the timeline
 *
 * The previous revision put `-progress pipe:1` on the SAME stdout as the TS and
 * then called `setEncoding('utf8')` on that stream to read it. Both halves of that
 * were fatal, and both are measured on a 12s encode:
 *  - setting an encoding decodes every chunk through `StringDecoder`, and MPEG-TS
 *    is not text. Invalid UTF-8 byte sequences come back as U+FFFD, so rebuilding a
 *    Buffer from the string does NOT restore the original bytes: 1,721,176 bytes
 *    were forwarded where ffmpeg wrote 409,283, and only 45 of 9155 packets still
 *    started with the 0x47 sync byte. ffprobe on the result: "Invalid data found
 *    when processing input";
 *  - with a second listener attached, `-progress` was also draining the pipe, and
 *    its text lines landed in the middle of the transport stream (398,872 bytes of
 *    them in that same run).
 *
 * A reader handed that stream does not error loudly: it simply never finds a PAT,
 * so it resolves no streams, publishes nothing, and reports no `out_time_us`. That
 * is exactly the "pusher alive, encoder producing, RTMP ingest received 0 bytes"
 * symptom. Keep progress off fd 1 and never set an encoding on fd 1.
 *
 * ## When the publisher is restarted, and when it is not
 *
 * One publisher serves a whole playlist: a file ending only replaces the encoder,
 * which is what keeps the RTMP session — and every viewer's connection — alive.
 * A skip or a jump is the exception and restarts both (see `restartSession`),
 * because the requested file is usually already buffered behind content the viewer
 * has not watched, and a published timeline cannot be rewound.
 *
 * Why a pipe rather than a file, a manifest or datagrams — all measured here with
 * ffmpeg on Windows:
 *  - the `concat` demuxer parses its manifest ONCE (`concat_read_header` →
 *    `concat_parse_script`) and latches EOF when the list runs out
 *    (`open_next_file` sets `cat->eof` once `++fileno >= cat->nb_files`). Tested
 *    deliberately: a pusher given a one-segment list exited at the end of that
 *    segment, and appending a second entry seven seconds later changed nothing
 *    (0 extra bytes, 6.04s of output, `progress=end`). A growing list of files
 *    therefore cannot feed a live publisher;
 *  - `-follow 1` reads zero bytes from a local file or a manifest (and belongs to
 *    the http protocol anyway);
 *  - `udp_read()` has no EOF path at all, so a datagram reader simply waits for
 *    the next packet. Verified: a publisher rode out a 4s silent gap and resumed
 *    on a NEW encoder that started at a different offset — which no file,
 *    manifest, HTTP or pipe transport allows.
 *
 * Timestamp continuity is carried by the passes themselves: each one is encoded
 * with `-output_ts_offset` set to the published timeline length, so the seam
 * between two passes stays continuous even though the encoder process changed.
 *
 * Because the published timeline cannot move backwards, content requested from
 * earlier in a file cannot be reached without opening a new publish session — that
 * is the whole reason a skip restarts both processes rather than only the encoder.
 *
 * ## The buffer is bounded, and that is what keeps the session alive
 *
 * The encoder runs FLAT OUT and the publisher only takes material at 1x, so the
 * difference has to be held somewhere in this process. Nothing used to limit it:
 * `relay` fed the publisher's stdin as fast as the encoder produced, the write queue
 * absorbed the backlog, and the buffer was therefore the rest of the playlist.
 * Measured on a 12-file (4h51m) buffered session: 7.2 GB relayed against 488 MB
 * published, i.e. ~6.7 GB queued in memory, until libuv's write to the pipe failed
 * with ENOBUFS. The publisher then saw EOF and exited 0 — exactly what a clean end
 * of stream looks like — and the engine, reading that as a dead RTMP session,
 * reconnected from the viewer's position and threw the pre-encoded hours away.
 *
 * Pausing the encoder's stdout is the cheapest backpressure available: it stops
 * reading, the pipe fills, and ffmpeg blocks in `write()` until it is resumed. The
 * lead is therefore capped at `leadLimitSec` and the queue stays a few seconds deep
 * instead of hours. That cap is also what makes the playout file-granular in
 * practice: the encoder can never be more than `leadLimitSec` into the next entry,
 * so a file is only ever rendered while the one before it is on air — never two
 * files ahead, and never the whole queue.
 */

export interface PlayoutCallbacks {
  log: (level: LogLevel, message: string) => void
  /** Timeline position reached by the pusher (seconds, measured from session start). */
  onPublished: (seconds: number) => void
  /** The pusher process ended (unexpectedly unless `stopping`). */
  onPusherExit: (code: number | null) => void
  /** The encoder process ended; `materialSec` is what it added to the timeline. */
  onEncoderExit: (code: number | null, materialSec: number) => void
}

export interface EncoderPass {
  /** Absolute path of the source file to encode. */
  input: string
  /** Extra input/output arguments (filters, mapping, encoder options). */
  args: string[]
  /** Where to start inside the source, in seconds. */
  startPositionSec: number
  /** Timeline value the pass must start at, so the published stream stays continuous. */
  tsOffset: number
  /** Expected amount of material, used only for logging. */
  expectedSec: number
  /**
   * Identity of this pass, assigned by {@link Playout.startEncoder}.
   *
   * A replaced encoder does not stop instantly — the kill arrives while data is
   * still in its pipes — so whatever it reports afterwards has to be attributable
   * to the pass that produced it and ignored if that pass is no longer the current
   * one. Callers leave this unset.
   */
  seq?: number
  /**
   * Set when this pass is being killed to make room for another one.
   *
   * Its output is discarded with the buffer, so it must report nothing at all — not
   * even "the pass completed", which the engine would otherwise read as the queue
   * having finished. Callers leave this unset.
   */
  abandoned?: boolean
}

const FFMPEG_INPUT_SEEK = '-ss'
/** MPEG-TS packets are fixed size; the relay must never split one. */
const TS_PACKET = 188
/**
 * Safety margin added to the timeline offset of every pass after the first.
 *
 * `-output_ts_offset` is applied to the pass's own timestamps, which start at zero,
 * so this value is where the pass's first frame lands on the published timeline.
 * The previous pass, however, does not end exactly at the span it reported: its
 * last audio frame can sit past it. Starting a hair late is invisible; starting a
 * hair early makes the reader reject packets as non-monotonic.
 */
const PASS_SPLICE_MARGIN_SEC = 0.05

/**
 * How much of the buffer is spent before a held encoder is released again.
 *
 * The release is driven by the publisher's own progress — it resumes when the buffer
 * has actually drained to this mark — rather than by a timer. A timer has to predict
 * how long that takes, and the prediction is made from a lead that is up to one
 * `-progress` interval stale, so the hold ends up a little too long every cycle: the
 * encoder drifts below 1x, the publisher has nothing to read, and a live viewer
 * starves. Measured on a real 19-minute session that drift cost 10–23% of real time
 * (0.77–0.90x of material produced per wall second), which is exactly what a client
 * sees as stuttering with the position jumping around.
 *
 * The margin has to exceed what the publisher keeps inside itself (its demuxer and
 * pipe hold a second or two), or the mark is never reached and the hold never ends;
 * the floor of 4 s covers that, and 25% keeps it proportional on a large buffer.
 */
function leadReleaseMarginSec(leadLimitSec: number): number {
  return Math.max(4, leadLimitSec * 0.25)
}

/**
 * A hold that outlives this is not throttle hysteresis, it is a publisher that has
 * stopped sending: the buffer cannot drain if nothing is being aired. The hold is
 * lifted anyway so the pipeline keeps trying, and the caller reports it.
 */
function leadHoldBackstopSec(leadLimitSec: number): number {
  return leadLimitSec * 2 + 10
}

/** How often the buffered pipeline reports its own health. */
const HEALTH_INTERVAL_MS = 30_000
/**
 * Head start the encoder gets over the publisher on a first start, in milliseconds.
 *
 * Hard-coded and short on purpose: it is not a user-facing delay, it is the warm-up
 * the encoder needs (ffmpeg start, hardware encoder init, first frames) so that the
 * publisher begins with material already queued instead of opening an RTMP session and
 * then stalling on its first read. The queue cannot run away while nobody is reading
 * it: the lead limit is enforced during this window too.
 */
const PUSHER_HEAD_START_MS = 600
/**
 * The same head start after a publisher failure or a skip: longer, because the server
 * has to release the previous publish session before a new one can take the key.
 */
const PUSHER_HEAD_START_RETRY_MS = 1500
/**
 * Production below this share of real time starves the publisher: it can only air
 * what it is given, and it is paced at 1x.
 */
const HEALTH_MIN_RATE = 0.98
/**
 * How long the publisher may go without reporting progress before it counts as
 * blocked rather than merely pacing.
 *
 * It reports every ~0.5s while it is moving — `-re` pacing still reads and muxes a
 * packet at a time — so several seconds of silence is a write to the server that is
 * not completing, which is what a network stall looks like from here.
 */
const PUSHER_SILENCE_WARN_SEC = 5

/** Prefix of this class's scratch folders in the OS temp area. */
const TEMP_PREFIX = 'rtmp-streamer-'

/**
 * Removes scratch folders a previous run left behind.
 *
 * `stop()` cleans up its own folder, but a killed app or a killed test never gets
 * there, and each session creates one. Sweeping the siblings at startup bounds the
 * leak without touching anything that is not ours (the prefix is app-specific).
 */
function sweepStaleTempDirs(): void {
  const tmp = os.tmpdir()
  let entries: string[]
  try {
    entries = fs.readdirSync(tmp)
  } catch {
    return
  }
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue
    const full = path.join(tmp, entry)
    try {
      // Only folders that have been idle for an hour: a second app instance (or a
      // concurrently running test) may own a fresh one.
      if (Date.now() - fs.statSync(full).mtimeMs < cutoff) continue
      fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

sweepStaleTempDirs()

/** Rounds a pass offset up to the millisecond ffmpeg is given, plus the margin. */
function passStartOffset(tsOffset: number): number {
  return Math.ceil((tsOffset + PASS_SPLICE_MARGIN_SEC) * 1000) / 1000
}

export class Playout {
  private readonly ffmpegPath: string
  private readonly outputArgs: string[]
  /**
   * How far the encoder may run ahead of the publisher, in seconds.
   *
   * Below one file change's worth of material the publisher starves at every entry
   * boundary — measured on a real 12-file session: 5.8–7.5 s from the previous pass
   * ending to the next one producing its first packets — so the engine floors this
   * value (see `BUFFER_SEC_MIN`).
   */
  private readonly leadLimitSec: number
  private readonly callbacks: PlayoutCallbacks
  /** Scratch folder for anything a pass needs on disk (logs, sidecars). */
  private readonly dir: string

  private pusher: ChildProcess | null = null
  private encoder: ChildProcess | null = null
  private seq = 0
  /** Timeline value the next encoder pass must start at. */
  private nextOffset = 0
  /** Highest timeline value the pusher has reached. */
  private publishedSec = 0
  /** Timeline value the encoder has produced up to (per its own progress). */
  private encodedSec = 0
  private encSpeed = 0
  private encFps = 0
  private encBitrate = 0
  /** Timeline offset of the pass currently being encoded. */
  private passOffsetSec = 0
  private stopping = false
  /** The pass whose encoder is currently running, for reporting decisions. */
  private currentPass: EncoderPass | null = null
  /** True while the encoder's stdout is paused to keep the buffer bounded. */
  private encoderHeld = false
  /** When the current hold started, and the backstop that ends it regardless. */
  private holdStartedAt = 0
  private holdBackstop: NodeJS.Timeout | null = null
  /** The hold is worth one log line per pass, not one per pause/resume cycle. */
  private holdReported = false
  /** Encoder position when the last hold ended, for the burst accounting in the log. */
  private burstFromSec = 0
  private burstFromMs = 0
  /** Counters behind the periodic health line. */
  private holdCount = 0
  private healthAt = 0
  private healthEncodedSec = 0
  private healthPublishedSec = 0
  private healthWallMs = 0
  private lowRateWindows = 0
  /** What the publisher itself reports: its own pace and how much it has sent. */
  private pusherSpeed = 0
  private pusherSentBytes = 0
  private pusherLastReportAt = 0
  /** True once the "publisher has gone quiet" warning was written for this silence. */
  private pusherSilenceReported = false
  /**
   * True while the publisher is being stopped on purpose (see `stopPusher`).
   */
  private suppressPusherExit = false
  private pusherProgressBuf = ''
  private encoderProgressBuf = ''
  /** Bytes accepted from the encoder but not yet taken by the publisher. */
  private pending: Buffer | null = null
  /** Partial MPEG-TS packet held back at a pass boundary (see `relay`). */
  private carry: Buffer = Buffer.alloc(0)
  /** Bytes that came out of an encoder and looked like MPEG-TS. */
  private relayedBytes = 0
  /** Bytes actually handed to the publisher's stdin. */
  private pumpedBytes = 0
  /**
   * Lowest and highest video PTS seen in the transport stream, per pass.
   *
   * The relay is the only place that sees the exact bytes both processes agree on,
   * so when the published timeline and the encoded timeline disagree (measured on
   * a skip: 50s published against 35s encoded), this says which side invented the
   * difference. Diag only — nothing depends on it.
   */
  private tsPts = { pass: 0, first: NaN, last: NaN, packets: 0, videoHeaders: 0, suspended: false }

  constructor(ffmpegPath: string, outputArgs: string[], leadLimitSec: number, callbacks: PlayoutCallbacks) {
    this.ffmpegPath = ffmpegPath
    this.outputArgs = outputArgs
    this.leadLimitSec = Math.max(0, leadLimitSec)
    this.callbacks = callbacks
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  }

  /* ------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------ */

  /**
   * Starts the publisher and the first encoder pass.
   *
   * The encoder goes first and the publisher follows a fixed, short moment later (see
   * `PUSHER_HEAD_START_MS`): the encoder needs a warm-up before it produces at speed
   * (ffmpeg start, hardware encoder init, first frames through the filters), and a
   * publisher that starts on an empty pipe spends that time as an open RTMP session
   * receiving nothing, then plays catch-up once the data arrives — stutter at exactly
   * the moment the two-process playout exists to prevent it.
   *
   * `retry` is set when this follows a publisher that failed rather than a first
   * start: a session restart (a skip or a jump) has to re-establish the RTMP
   * connection, and a server that is still tearing the previous publish down — or a
   * test harness that needs a moment to accept again — would otherwise turn a
   * deliberate re-publish into a lost session.
   */
  async start(pass: EncoderPass, retry = false): Promise<void> {
    // A publisher that has already exited is NOT a running publisher: keeping the
    // handle would silently swallow every later pass, because the encoder writes
    // into a pipe whose reader is gone.
    if (this.isPusherRunning()) return
    this.pusher = null
    this.stopping = false
    // The encoder goes first. Its output is read and queued as it comes (bounded by
    // the lead limit, which is enforced while the publisher is still starting), so the
    // publisher finds material already waiting the moment it exists.
    this.startEncoder(pass)
    // A session restart has to re-establish the RTMP connection, and the server may
    // still be tearing the previous publish down; a first start only has to let the
    // encoder come up to speed.
    const waitMs = retry ? PUSHER_HEAD_START_RETRY_MS : PUSHER_HEAD_START_MS
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    if (this.stopping) return
    this.startPusher()
  }

  /** Replaces the encoder pass; the pusher (and the RTMP session) is untouched. */
  restartEncoder(pass: EncoderPass): void {
    this.killEncoder()
    this.startEncoder(pass)
  }

  /**
   * Throws the buffer away and starts a BRAND NEW RTMP session for `pass`.
   *
   * This is what a skip or a jump uses, and the reason is structural rather than
   * convenient: the encoder runs ahead of the publisher on purpose, so by the time
   * the viewer asks for a different file the material they asked for is usually
   * already inside the buffer — behind content they have not watched yet. A
   * published timeline can only move forward, so the buffered remainder cannot be
   * skipped over; the only way to honour the request is to end this publish session
   * and open another one whose timeline starts at the new file.
   *
   * The cost is a re-publish: the ingest sees the stream end and a new one begin,
   * and the viewer waits for the reconnect. That is bounded and predictable, which
   * the alternative (a skip that silently does nothing for as long as the buffer is
   * deep) is not.
   *
   * A natural end of file does NOT come through here: when a file simply finishes
   * the pusher has already aired everything that was handed to it, so the encoder is
   * replaced on its own and the RTMP session continues untouched (see
   * {@link restartEncoder}).
   */
  async restartSession(pass: EncoderPass): Promise<void> {
    /*
     * The encoder goes first, before anything is awaited.
     *
     * Killing it is what makes the abandoned file stop being relayed and, just as
     * important, stops its completion from being reported: an encoder left running
     * across the wait below would finish the file the user skipped over and that
     * "pass complete" would be attributed to the pass that replaced it, advancing
     * the timeline by the wrong amount and marking the wrong playlist entry done.
     */
    this.killEncoder(true)
    // Forced: the buffered audio/video is being thrown away, so there is nothing to
    // flush and no reason to wait for the publisher to end the session politely.
    await this.stopPusher(true)
    // New session, new timeline: the counters describe the session that just ended.
    this.nextOffset = 0
    this.publishedSec = 0
    this.encodedSec = 0
    this.pending = null
    this.carry = Buffer.alloc(0)
    this.relayedBytes = 0
    this.pumpedBytes = 0
    this.passMaterial.clear()
    this.tsPts = { pass: 0, first: NaN, last: NaN, packets: 0, videoHeaders: 0, suspended: false }
    this.stopping = false
    this.callbacks.log('info', '已丢弃缓冲并重开 RTMP 会话（跳转时需要这样做：缓冲里的内容无法撤回）。')
    await this.start(pass, true)
  }

  /** Stops both processes and removes the buffer directory. */
  async stop(): Promise<void> {
    this.stopping = true
    this.killEncoder()
    await this.stopPusher()
    this.cleanup()
  }

  /**
   * Ends the publish session and waits for the process to be gone.
   *
   * Closing stdin is what makes the pusher flush and leave the publish session
   * cleanly instead of being killed mid-packet; the kill is the backstop for a
   * publisher wedged on a dead socket. `forced` marks the stop as deliberate, so its
   * exit is never reported as the stream breaking.
   */
  private async stopPusher(forced = false): Promise<void> {
    const pusher = this.pusher
    this.pusher = null
    if (!pusher || pusher.exitCode !== null) return
    const wasStopping = this.stopping
    this.suppressPusherExit = true
    try {
      if (forced) pusher.kill('SIGKILL')
      else pusher.stdin?.end()
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          pusher.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 2500)
      pusher.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.suppressPusherExit = false
    this.stopping = wasStopping
  }

  /** Live figures of the encoder process (speed/fps/bitrate). */
  getEncoderStats(): { speed: number; fps: number; bitrateKbps: number; leadSec: number } {
    return {
      speed: this.encSpeed,
      fps: this.encFps,
      bitrateKbps: this.encBitrate,
      // How far the encoder has run ahead of what has been published: the buffer
      // depth that absorbs a slow stretch.
      leadSec: Math.max(0, this.encodedSec - this.publishedSec)
    }
  }

  /**
   * Byte counters for the relay path.
   *
   * "The publisher is running but nothing reaches the ingest" is otherwise a
   * guess: these numbers say whether the encoder produced anything (`relayed`)
   * and whether it was handed over (`pumped`). A large gap between them is
   * backpressure, not a fault.
   */
  getRelayStats(): { relayedBytes: number; pumpedBytes: number; pendingBytes: number; carryBytes: number } {
    return {
      relayedBytes: this.relayedBytes,
      pumpedBytes: this.pumpedBytes,
      pendingBytes: this.pending?.length ?? 0,
      carryBytes: this.carry.length
    }
  }

  /**
   * Session-timeline position the encoder has reached, in seconds.
   *
   * `nextOffset` covers the passes that have been handed over; the pass still running
   * adds whatever it has produced so far. This is what the buffer display needs: the
   * distance between here and what the publisher has aired is the buffer depth, and
   * unlike a position derived from a lead measurement it stays correct across a pass
   * boundary — where the hand-off point jumps forward while the viewer does not.
   */
  getEncodedSec(): number {
    return Math.max(this.nextOffset, this.encodedSec)
  }

  /** Where the pusher has published up to (seconds on the session timeline). */
  getPublishedSec(): number {
    return this.publishedSec
  }

  /** The timeline value the next pass will start at. */
  getNextOffset(): number {
    return this.nextOffset
  }

  isPusherRunning(): boolean {
    return this.pusher !== null && this.pusher.exitCode === null
  }

  /* ------------------------------------------------------------ *
   * Timeline accounting
   * ------------------------------------------------------------ */

  /**
   * Records the span a finished pass contributed.
   *
   * Nothing is buffered on disk: the encoder streams into the socket, so what
   * stands between the two processes is the UDP receive buffer plus whatever the
   * encoder has already pushed. The span only has to move the timeline so the
   * next pass continues exactly where this one stopped.
   */
  private publishSegment(durationSec: number): void {
    this.nextOffset += Math.max(0.001, durationSec)
  }

  private cleanup(): void {
    this.clearEncoderHold()
    try {
      fs.rmSync(this.dir, { recursive: true, force: true })
    } catch {
      /* best effort: the folder lives in the OS temp area */
    }
  }

  /* ------------------------------------------------------------ *
   * Pusher
   * ------------------------------------------------------------ */

  private startPusher(): void {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'info',
      // `-re` on the *input* is what paces publication: the encoder may be
      // seconds ahead, the viewer still receives exactly one second per second.
      '-re',
      // MPEG-TS arriving on stdin, fed by this process. A pipe is the only
      // transport whose reader never has to know that the producer changed: the
      // writer side here outlives every encoder pass, so the RTMP session is
      // untouched by a seek or a file change. (Files, concat manifests, HTTP and
      // named pipes all hand the reader an EOF it cannot recover from; UDP hides
      // it but the reader aborted at the first pass boundary in testing.)
      '-f',
      'mpegts',
      '-i',
      'pipe:0',
      '-c',
      'copy',
      '-max_interleave_delta',
      '0',
      // Progress goes to its own descriptor so that fd 2 stays ffmpeg's log. When
      // both shared stderr, a reader could not tell a progress block from a real
      // message, and the log had to be discarded to avoid double-counting the
      // numbers — which is what hid every publishing failure from this app.
      '-progress',
      'pipe:3',
      '-nostats',
      ...this.outputArgs
    ]
    this.callbacks.log('debug', `推流进程: ${args.join(' ')}`)
    // stdin is piped and owned by this process for the WHOLE session: encoder
    // passes come and go, the reader never sees EOF, and the RTMP session is
    // untouched by a seek or a file change.
    const child = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    })
    this.pusher = child
    this.pusherProgressBuf = ''
    this.callbacks.log('info', `推流进程已启动（pid ${child.pid ?? '?'}），编码进程可在其背后重启。`)
    // Hand over whatever the encoder produced during the head start. Nothing else will:
    // this only runs on a `drain`, and the queue was filled before the publisher existed.
    this.pump()
    child.stdout?.on('data', () => {})
    // fd 3 is the progress pipe (`stdio: ['pipe','pipe','pipe','pipe']`), so it is
    // a readable stream here even though `ChildProcess['stdio']` is typed loosely.
    const pusherProgress = child.stdio[3] as Readable | null
    pusherProgress?.setEncoding('utf8')
    pusherProgress?.on('data', (chunk: string) => this.onPusherOutput(chunk))
    // The pusher's own log is the only place RTMP failures surface ("Cannot open
    // connection", "Server error", muxer complaints). It used to be swallowed:
    // `-progress` came in on stderr and every non-progress line was dropped, so a
    // publisher that never connected looked identical to one that was streaming.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.onPusherLog(chunk))
    child.stdin?.on('drain', () => this.pump())
    // A publisher that dies mid-write (or is stopped) makes its stdin fail. That
    // is a normal teardown path here, not an exception: without a handler the
    // error escapes as an uncaught exception and takes the whole app down.
    //
    // It is NOT a quiet path though: the publisher reads the failed pipe as a clean
    // end of stream, so it exits 0 and the engine sees "the RTMP session ended"
    // rather than a write failure. A long buffered session died this way (ENOBUFS on
    // a queue of ~6.7 GB), so the code is reported as an error.
    child.stdin?.on('error', (err) => {
      // An intentional teardown closes this pipe from under an in-flight write, which
      // surfaces here as EOF/EPIPE on every stop and every jump; only a failure while
      // the session is supposed to be running means anything (see below).
      if (this.stopping || this.suppressPusherExit) return
      const code = (err as NodeJS.ErrnoException).code ?? err.message
      this.callbacks.log('error', `写入推流进程失败（${code}）：推流进程会读到流结束而退出，本次发布会话将中断。`)
    })
    child.on('error', (err) => {
      this.callbacks.log('error', `推流进程错误: ${err.message}`)
    })
    child.on('exit', (code) => {
      if (this.pusher === child) this.pusher = null
      // A restart stops the publisher deliberately; reporting that as a fault would
      // make the engine abandon the session the restart was opening.
      if (this.stopping || this.suppressPusherExit) return
      this.callbacks.log('warn', `推流进程结束（退出码 ${code ?? '未知'}）`)
      this.callbacks.onPusherExit(code)
    })
  }

  /* ------------------------------------------------------------ *
   * Relay: encoder stdout -> this process -> publisher stdin
   * ------------------------------------------------------------ */

  /** Hands encoder bytes to the publisher, keeping MPEG-TS packets aligned. */
  private relay(raw: Buffer | Uint8Array | string): void {
    // A session being torn down will never take another byte: queueing here would only
    // grow this process's memory with material nobody can publish (that path is what
    // ended a long session: ~6.7 GB queued, then the write failed). A publisher that
    // simply does not exist yet is different — that queue IS the head start — and it
    // stays bounded because the lead limit applies to it too.
    if (this.stopping) return
    // The pipe must be handled as bytes: if the chunk ever arrives as a string
    // (an encoding set somewhere upstream), converting it back keeps `subarray`
    // valid and the 188-byte alignment intact. Note that this conversion is lossy
    // for non-UTF-8 data, which is why nothing is allowed to set an encoding on
    // fd 1 in the first place — see the header comment.
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array | string)
    const buf = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk
    // A pass boundary can land mid-packet, and forwarding a partial 188-byte TS
    // packet makes the reader report "Packet corrupt" (measured). The remainder is
    // held back and prepended to the next pass's first bytes.
    const whole = buf.length - (buf.length % TS_PACKET)
    this.carry = whole === buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(whole))
    if (whole === 0) return
    const ready = whole === buf.length ? buf : Buffer.from(buf.subarray(0, whole))
    this.noteTsPts(ready)
    this.relayedBytes += ready.length
    this.pending = this.pending ? Buffer.concat([this.pending, ready]) : ready
    this.pump()
    this.updateEncoderHold()
  }

  /**
   * Holds the encoder back while it is further ahead of the publisher than allowed.
   *
   * The publisher is the clock — it takes material at exactly 1x — so anything the
   * encoder produces beyond the buffer is material this process has to keep in
   * memory until its turn comes, hours later on a long playlist. Pausing the
   * encoder's stdout is the backpressure that bounds it (see the class header).
   *
   * A hold ends when the publisher has actually drained the buffer back to the release
   * mark (see `leadReleaseMarginSec`). That feedback is what keeps the encoder at 1x on
   * average: a hold that ends early merely announces itself again, while one that ends
   * late takes real time out of the stream and starves every viewer. A timer cannot do
   * this — it has to predict how long the drain takes from a lead that is up to one
   * `-progress` interval stale, which is how a real session ended up producing only
   * 0.77–0.90s per wall second.
   */
  private updateEncoderHold(): void {
    /*
     * `publishedSec` stays at 0 until the publisher exists and reports, so the same
     * limit bounds the head start: a publisher that never comes up (a failed spawn)
     * cannot leave the encoder filling this process's memory, it just means the hold
     * ends on its backstop instead of on the publisher catching up.
     */
    const stdout = this.encoder?.stdout
    if (!stdout) return
    const lead = this.encodedSec - this.publishedSec
    if (!this.encoderHeld) {
      if (lead <= this.leadLimitSec) return
      this.encoderHeld = true
      this.holdStartedAt = Date.now()
      this.holdCount += 1
      stdout.pause()
      const burstSec = this.encodedSec - this.burstFromSec
      const burstWallSec = Math.max(0.001, (this.holdStartedAt - this.burstFromMs) / 1000)
      if (!this.holdReported) {
        this.holdReported = true
        this.callbacks.log(
          'debug',
          `编码已领先推流 ${lead.toFixed(1)}s（上限 ${this.leadLimitSec.toFixed(1)}s），暂停编码进程输出等待推流追平——缓冲不再随播放列表增长。`
        )
      }
      this.callbacks.log(
        'debug',
        `第 ${this.seq} 段突发产出 ${burstSec.toFixed(1)}s / 用时 ${burstWallSec.toFixed(2)}s（≈${(burstSec / burstWallSec).toFixed(1)}×），当前领先 ${lead.toFixed(1)}s；等推流把领先吃到 ${(this.leadLimitSec - leadReleaseMarginSec(this.leadLimitSec)).toFixed(1)}s 以内再恢复编码。`
      )
      // Backstop only: a publisher that has stopped reporting cannot drain anything.
      this.holdBackstop = setTimeout(() => {
        this.holdBackstop = null
        if (!this.encoderHeld) return
        const heldSec = (Date.now() - this.holdStartedAt) / 1000
        this.callbacks.log(
          'warn',
          `编码已暂停 ${heldSec.toFixed(1)}s 仍未见推流进程推进（领先 ${(this.encodedSec - this.publishedSec).toFixed(1)}s）：推流端可能已卡住或网络中断，先恢复编码继续排空缓冲。`
        )
        this.releaseEncoderHold()
      }, leadHoldBackstopSec(this.leadLimitSec) * 1000)
      return
    }
    if (lead > this.leadLimitSec - leadReleaseMarginSec(this.leadLimitSec)) return
    const heldSec = (Date.now() - this.holdStartedAt) / 1000
    this.releaseEncoderHold()
    this.callbacks.log(
      'debug',
      `推流已把缓冲吃到领先 ${lead.toFixed(1)}s，恢复编码进程输出（本次暂停 ${heldSec.toFixed(1)}s）。`
    )
  }

  /** Lifts a hold and starts the burst accounting for the next one. */
  private releaseEncoderHold(): void {
    if (this.holdBackstop) {
      clearTimeout(this.holdBackstop)
      this.holdBackstop = null
    }
    this.encoderHeld = false
    this.burstFromSec = this.encodedSec
    this.burstFromMs = Date.now()
    this.encoder?.stdout?.resume()
  }

  /** Cancels a hold: the encoder it applied to is gone (see `startEncoder`). */
  private clearEncoderHold(): void {
    if (this.holdBackstop) {
      clearTimeout(this.holdBackstop)
      this.holdBackstop = null
    }
    this.encoderHeld = false
  }

  /**
   * Periodic account of what the buffered pipeline is actually doing.
   *
   * The number that matters is the publisher's own rate: it is paced at 1x, so if it
   * airs less material per wall second than that, the stream itself is running slow —
   * a live client then runs out of data and stutters no matter how full the buffer is.
   * That state is invisible without this line, because nothing is in error: the buffer
   * stays at its limit, the encoder is merely held to match, and the only symptom is
   * on the viewer's screen. Two different things produce it, and both are reported
   * separately:
   *  - the publisher sends slower than real time (a saturated link or a server that
   *    cannot take the bitrate) — its own `speed` figure says so;
   *  - the publisher stops reporting at all, which means it is blocked inside a write
   *    (a network stall) rather than pacing.
   */
  private reportHealth(): void {
    const now = Date.now()
    if (this.healthAt === 0) {
      this.healthAt = now
      this.healthEncodedSec = this.encodedSec
      this.healthPublishedSec = this.publishedSec
      this.healthWallMs = now
      return
    }
    const silentSec = this.pusherLastReportAt > 0 ? (now - this.pusherLastReportAt) / 1000 : 0
    if (silentSec > PUSHER_SILENCE_WARN_SEC) {
      if (!this.pusherSilenceReported) {
        this.pusherSilenceReported = true
        this.callbacks.log(
          'warn',
          `推流进程已 ${silentSec.toFixed(0)}s 没有上报进度：它多半卡在向服务器写入（网络拥塞或服务器不收），此时缓冲区是满的、编码进程也被暂停，观众端会先缓冲再突然快进。`
        )
      }
    } else {
      this.pusherSilenceReported = false
    }
    if (now - this.healthAt < HEALTH_INTERVAL_MS) return
    const wallSec = (now - this.healthWallMs) / 1000
    const producedSec = this.encodedSec - this.healthEncodedSec
    const airedSec = this.publishedSec - this.healthPublishedSec
    const encodeRate = wallSec > 0 ? producedSec / wallSec : 0
    const airRate = wallSec > 0 ? airedSec / wallSec : 0
    const relay = this.getRelayStats()
    // `writableLength` is what libuv has accepted from us but the publisher has not
    // read yet. It separates the two ways the egress can stall: a queue that keeps
    // growing means the publisher is not reading (it is stuck inside a write to the
    // server), while an empty queue with a flat published position means it is reading
    // and simply cannot send any faster.
    const pusherQueuedKb = (this.pusher?.stdin?.writableLength ?? 0) / 1024
    this.callbacks.log(
      'debug',
      `缓冲状态：推流已播 ${this.publishedSec.toFixed(1)}s（本窗口 ${airedSec.toFixed(1)}s ÷ ${wallSec.toFixed(1)}s = ${airRate.toFixed(2)}×，推流进程自报 ${this.pusherSpeed.toFixed(2)}×，已发送 ${(this.pusherSentBytes / 1048576).toFixed(1)}MB）；编码已产 ${this.encodedSec.toFixed(1)}s（本窗口 ${encodeRate.toFixed(2)}×），领先 ${(this.encodedSec - this.publishedSec).toFixed(1)}s / 上限 ${this.leadLimitSec.toFixed(1)}s，暂停 ${this.holdCount} 次；转发 ${(relay.relayedBytes / 1048576).toFixed(1)}MB，写入推流进程 ${(relay.pumpedBytes / 1048576).toFixed(1)}MB（其内部待写 ${pusherQueuedKb.toFixed(0)}KB / 我方待写 ${(relay.pendingBytes / 1024).toFixed(0)}KB）。`
    )
    if (airRate < HEALTH_MIN_RATE) {
      this.lowRateWindows += 1
      this.callbacks.log(
        'warn',
        `推流端本窗口只送出 ${airedSec.toFixed(1)}s / ${wallSec.toFixed(1)}s = ${airRate.toFixed(2)}×（低于实时，连续 ${this.lowRateWindows} 个窗口）：缓冲是满的、编码也在等它，所以瓶颈在推流链路（上行带宽 / 服务器接收 / 网络抖动），观众端会卡顿并在缓冲后用快进追赶。建议降低码率，或检查到服务器的链路质量。`
      )
    } else {
      this.lowRateWindows = 0
    }
    this.healthAt = now
    this.healthEncodedSec = this.encodedSec
    this.healthPublishedSec = this.publishedSec
    this.healthWallMs = now
  }

  /** Writes what the publisher will accept; the rest waits for its next drain. */
  private pump(): void {
    const stdin = this.pusher?.stdin
    // `writable` guards the teardown race: the publisher can exit between the
    // encoder writing and this call, and writing to a finished stream throws
    // "write EOF" instead of failing quietly.
    if (!stdin || !stdin.writable || stdin.destroyed) return
    while (this.pending && this.pending.length > 0) {
      const chunk = this.pending
      this.pending = null
      try {
        // Backpressure is the buffer: when the publisher is behind, the encoder's
        // own pipe fills and it simply blocks. Nothing is buffered without bound.
        //
        // `false` means "queued, wait for drain" — the chunk itself was accepted,
        // so it is dropped from `pending` either way and the next one waits for
        // the `drain` handler to re-enter here.
        if (!stdin.write(chunk)) {
          this.pumpedBytes += chunk.length
          return
        }
        this.pumpedBytes += chunk.length
      } catch (err) {
        this.callbacks.log('debug', `写入推流进程失败（${String(err)}）。`)
        return
      }
    }
  }

  /**
   * Records the video PTS span of the transport stream being relayed.
   *
   * Reads the 188-byte packet grid directly: sync byte, PID, payload-unit-start
   * flag, then the PTS from the adaptation field. Anything unexpected is ignored
   * rather than guessed at — this is a diagnostic, and a wrong number here would be
   * worse than no number.
   */
  private noteTsPts(buf: Buffer): void {
    for (let i = 0; i + TS_PACKET <= buf.length; i += TS_PACKET) {
      if (buf[i] !== 0x47) continue
      if ((buf[i + 1] & 0x40) === 0) continue // no payload-unit-start: no PTS
      const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2]
      if (pid !== 256) continue // pinned video PID (see `-mpegts_start_pid`)
      const afc = (buf[i + 3] >> 4) & 0x03
      /*
       * The PTS lives in the PES header, NOT in the adaptation field: what that field
       * carries here is a PCR (ffmpeg writes one every ~20 ms), and reading its bytes as
       * a PTS is what made this diagnostic report nonsense — "on-wire video PTS
       * 22427–44006s" for a 23-minute pass, numbers an operator reasonably reads as a
       * timestamp fault in the stream. So: skip packets without a payload, step over the
       * adaptation field, then read PTS_DTS_flags from the PES header.
       */
      if (afc === 0 || afc === 2) continue // adaptation only: no payload, no PES header
      const afLen = afc === 3 ? buf[i + 4] : 0
      const pes = i + 4 + (afc === 3 ? 1 + afLen : 0)
      if (pes + 14 > i + TS_PACKET) continue
      if (buf[pes] !== 0 || buf[pes + 1] !== 0 || buf[pes + 2] !== 1) continue // start code
      if (((buf[pes + 7] >> 6) & 0x03) < 2) continue // PTS_DTS_flags: no PTS present
      const s = pes + 9
      const raw =
        (BigInt(buf[s] & 0x0e) << 29n) |
        (BigInt(buf[s + 1]) << 22n) |
        (BigInt(buf[s + 2] & 0xfe) << 14n) |
        (BigInt(buf[s + 3]) << 7n) |
        (BigInt(buf[s + 4]) >> 1n)
      const seconds = Number(raw) / 90_000
      this.tsPts.packets += 1
      // Video PES headers arrive one per frame, so their count is the frame count.
      if (pid === 256) this.tsPts.videoHeaders += 1
      if (Number.isNaN(this.tsPts.first)) this.tsPts.first = seconds
      this.tsPts.last = seconds
    }
  }

  /** Video PTS span of everything handed to the publisher (diagnostic). */
  getTsPtsSpan(): { packets: number; videoHeaders: number; firstSec: number; lastSec: number } {
    return {
      packets: this.tsPts.packets,
      videoHeaders: this.tsPts.videoHeaders,
      firstSec: this.tsPts.first,
      lastSec: this.tsPts.last
    }
  }

  /**
   * Keeps the pusher's own log, which is where RTMP failures are reported.
   *
   * Nothing here is a progress block (those come in on fd 3), so every line is
   * passed through: "Cannot open connection", an authentication rejection or a
   * muxer complaint is otherwise invisible and a publisher that never connected
   * looks exactly like one that is streaming.
   */
  private onPusherLog(chunk: string): void {
    this.pusherLogBuf += chunk
    const lines = this.pusherLogBuf.split(/\r?\n/)
    this.pusherLogBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const level: LogLevel = /error|failed|cannot|refused|denied|unable to/i.test(line) ? 'error' : 'ffmpeg'
      this.callbacks.log(level, line)
    }
  }

  private pusherLogBuf = ''

  /**
   * Reads `-progress` blocks from the pusher's stderr.
   *
   * The pusher's own timeline is the session timeline: it starts at 0 and only
   * ever moves forward, no matter how many times the encoder was restarted.
   */
  private onPusherOutput(chunk: string): void {
    this.pusherProgressBuf += chunk
    const lines = this.pusherProgressBuf.split(/\r?\n/)
    this.pusherProgressBuf = lines.pop() ?? ''
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      // The publisher reports every ~0.5s whether or not it is moving, which makes it
      // the only clock the health line can rely on while the encoder is held.
      this.pusherLastReportAt = Date.now()
      this.reportHealth()
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const micro = Number(value)
        if (!Number.isFinite(micro)) continue
        const sec = micro / 1_000_000
        if (sec > this.publishedSec) {
          this.publishedSec = sec
          this.callbacks.onPublished(sec)
          // A publisher that is falling further behind is what starts a hold; one
          // already in flight ends on its own when the buffer has drained (see
          // `updateEncoderHold`).
          this.updateEncoderHold()
        }
      } else if (key === 'total_size') {
        // Bytes the publisher has actually handed to the muxer, i.e. what left the
        // process towards the server.
        const bytes = Number(value)
        if (Number.isFinite(bytes) && bytes > 0) this.pusherSentBytes = bytes
      } else if (key === 'speed') {
        // The publisher's own pace. `-re` should hold it at ~1x; anything below that
        // is the stream running slow, whatever the buffer looks like.
        const v = Number(value.replace('x', ''))
        if (Number.isFinite(v) && v > 0) this.pusherSpeed = v
      } else if (key === 'progress' && value === 'end') {
        // The publisher has caught up with the encoder; it simply waits for the
        // next datagram, which is why this transport survives encoder restarts.
        this.callbacks.log('debug', '推流进程已追平编码进度，等待后续内容。')
      } else if (key === 'speed') {
        // no-op: the pusher is paced by -re, so this is always ~1x
      }
    }
  }

  /* ------------------------------------------------------------ *
   * Encoder
   * ------------------------------------------------------------ */

  private startEncoder(pass: EncoderPass): void {
    this.seq += 1
    // The pass carries its own identity from here on, so every later report can be
    // matched against the pass it belongs to rather than against a shared counter.
    pass.seq = this.seq
    this.passOffsetSec = pass.tsOffset
    // A fresh pass starts unheld, whatever the pass before it was doing: it has to be
    // free to produce its first packets, which is precisely what the publisher needs
    // while a file change is in flight.
    this.clearEncoderHold()
    this.holdReported = false
    // Baseline for the burst accounting in the hold log: a pass that is never released
    // must not report a duration measured from the epoch (Date.now() default of 0).
    this.burstFromSec = this.encodedSec
    this.burstFromMs = Date.now()
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'info',
      ...(pass.startPositionSec > 0.05
        ? [FFMPEG_INPUT_SEEK, String(Math.round(pass.startPositionSec * 100) / 100), '-noaccurate_seek']
        : []),
      '-fflags',
      '+genpts',
      '-i',
      pass.input,
      // Stream selection belongs to `pass.args` (see `buildEncoderArgs`), which maps
      // the streams it actually found. Mapping here as well duplicated every stream
      // — the same frames encoded twice, into two stream sets — and `-map 0:a:0`
      // aborted the pass outright on a file with no audio track.
      ...pass.args,
      // Every pass must OPEN on a keyframe: the seam between two passes is a
      // splice mid-stream, and a reader that joins on a P/B frame cannot decode
      // until the next IDR (this is the failure mode ffmpeg documents for
      // `-restart_with_keyframe`/`drop_pkts_on_overflow`). Forcing frame 0 of each
      // pass to be an IDR makes the seam decodable.
      '-force_key_frames',
      'expr:eq(n,0)',
      // The viewer's timeline must not step backwards when a pass is replaced,
      // so the new pass continues exactly where the published stream already is.
      //
      // The offset is rounded UP and carries a margin, because rounding it to the
      // nearest millisecond can land it *below* the previous pass's last timestamp —
      // AAC frames are 23ms long, so a pass can end past its nominal duration, and
      // an offset a few milliseconds short made the reader report "Packet corrupt /
      // Non-monotonic DTS" at every boundary (measured). Landing slightly late
      // instead leaves a gap smaller than one video frame.
      ...(pass.tsOffset > 0 ? ['-output_ts_offset', String(passStartOffset(pass.tsOffset))] : []),
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      // Keep the MPEG-TS program identity identical in every pass. Without this
      // each encoder run invents its own PAT/PMT and PID layout, so a reader that
      // is mid-stream sees the program change underneath it and can abort (this is
      // what produced the access violation at the first pass boundary). Pinning
      // the PIDs, the service id and the stream types makes two consecutive passes
      // look like one uninterrupted program.
      '-mpegts_start_pid',
      '256',
      '-mpegts_pmt_start_pid',
      '4096',
      '-mpegts_service_id',
      '1',
      '-mpegts_service_type',
      'digital_tv',
      '-mpegts_flags',
      '+resend_headers',
      // The span this pass contributes has to be measured, and `-progress` is the
      // only reliable source for it (a muxer-level measurement would also miss the
      // frames still in flight when the process is killed).
      //
      // It goes to fd 3, NEVER to fd 1: fd 1 carries the MPEG-TS itself, and
      // sharing the two is what produced the "pusher alive, ingest received 0
      // bytes" bug (see the header comment).
      '-progress',
      'pipe:3',
      '-nostats',
      // MPEG-TS to stdout, which this process relays into the publisher's stdin.
      // The encoder is free to run faster than real time — that is the entire
      // point of the split — and nothing is written to disk.
      '-flush_packets',
      '1',
      '-f',
      'mpegts',
      'pipe:1'
    ]
    this.callbacks.log('debug', `编码进程（第 ${this.seq} 段）: ${args.join(' ')}`)
    this.tsPts = { pass: this.seq, first: NaN, last: NaN, packets: 0, videoHeaders: 0, suspended: false }
    // fd 0 is ignored (`-nostdin`), fd 1 is the transport stream, fd 2 is the log,
    // fd 3 is progress. fd 1 gets exactly one reader and is never given an encoding.
    const child = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe']
    })
    this.encoder = child
    this.currentPass = pass
    this.encoderProgressBuf = ''
    /*
     * Every listener below is gated on the pass still being the CURRENT one.
     *
     * This is not defensive tidiness: `kill('SIGKILL')` does not stop data that is
     * already in the pipe, so a replaced encoder keeps delivering chunks for a
     * moment. Ungated, those stale bytes were relayed into the publisher — an
     * abandoned file's picture appearing AFTER the file the user asked for — and its
     * exit was even accounted as the new pass completing, which advanced the timeline
     * by the wrong amount and ended the whole playlist.
     */
    const isCurrent = (): boolean => this.encoder === child
    child.stdout?.on('data', (chunk: Buffer) => {
      if (isCurrent()) this.relay(chunk)
    })
    this.callbacks.log('info', `编码进程已启动（第 ${this.seq} 段，pid ${child.pid ?? '?'}）。`)
    // `-progress pipe:3` reports how much material the pass has produced, which is
    // what the next pass must offset its timeline by. fd 1 keeps zero readers
    // besides the relay and is never decoded as text.
    const encoderProgress = child.stdio[3] as Readable | null
    encoderProgress?.setEncoding('utf8')
    encoderProgress?.on('data', (chunk: string) => {
      if (isCurrent()) this.onEncoderOutput(chunk, pass.seq ?? 0)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.onEncoderLog(chunk))
    child.on('error', (err) => {
      this.callbacks.log('error', `编码进程错误: ${err.message}`)
    })
    child.on('exit', (code) => {
      const wasCurrent = this.encoder === child
      if (wasCurrent) this.encoder = null
      if (this.stopping || !wasCurrent) return
      // A kill is asynchronous: by the time this fires the engine may already have
      // been handed the next file, and that exit is the one that must be accounted.
      // `pass.seq` is carried on the pass so the report cannot be attributed twice.
      if (pass.seq !== this.seq) return
      // Abandoned on purpose (a skip or a jump is replacing it): this pass produced
      // nothing the viewer will hear, so it must not be reported. Reporting it makes
      // the engine account for material that is being thrown away — and when that
      // happens to be the last entry of the queue it looks exactly like "the playlist
      // finished", which tears down the session the restart was opening.
      if (pass.abandoned) {
        this.passMaterial.delete(pass.seq ?? 0)
        return
      }
      // The pass is complete (or died): account for what it produced. The
      // publisher keeps reading the socket either way.
      this.finishPass(pass, code)
    })
  }

  /** Tracks how much material the pass has produced, for its timeline span. */
  private onEncoderOutput(chunk: string, passSeq: number): void {
    this.encoderProgressBuf += chunk
    const lines = this.encoderProgressBuf.split(/\r?\n/)
    this.encoderProgressBuf = lines.pop() ?? ''
    let sawProgressBlock = false
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const micro = Number(value)
        if (Number.isFinite(micro)) {
          const sec = micro / 1_000_000
          this.passMaterial.set(passSeq, Math.max(this.passMaterial.get(passSeq) ?? 0, sec))
          // The encoder's own position on the published timeline: its pass offset
          // plus what this pass has produced so far.
          this.encodedSec = this.passOffsetSec + sec
        }
      } else if (key === 'speed') {
        const v = Number(value.replace('x', ''))
        if (Number.isFinite(v)) this.encSpeed = v
      } else if (key === 'fps') {
        const v = Number(value)
        if (Number.isFinite(v) && v > 0) this.encFps = v
      } else if (key === 'bitrate') {
        const v = Number(value.replace(/kbits\/s/i, '').trim())
        if (Number.isFinite(v) && v > 0) this.encBitrate = v
      } else if (key === 'progress') {
        sawProgressBlock = true
      }
    }
    // One line per progress block (every ~0.5s of material): proof that the
    // transport really is moving, which is the one thing that was impossible to
    // tell apart from "the publisher is silently doing nothing".
    if (sawProgressBlock) {
      const s = this.getRelayStats()
      const produced = this.passMaterial.get(passSeq) ?? 0
      this.callbacks.log(
        'debug',
        `第 ${passSeq} 段已编码 ${produced.toFixed(1)}s，转发 ${(s.relayedBytes / 1024).toFixed(0)}KB / 已写入推流进程 ${(s.pumpedBytes / 1024).toFixed(0)}KB（缓冲 ${(s.pendingBytes / 1024).toFixed(0)}KB）`
      )
    }
  }

  /** Keeps a sample of the encoder's own log so failures stay diagnosable. */
  private onEncoderLog(chunk: string): void {
    this.encoderLogBuf += chunk
    const lines = this.encoderLogBuf.split(/\r?\n/)
    this.encoderLogBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const level: LogLevel = /error|failed|invalid|unable to/i.test(line) ? 'error' : 'ffmpeg'
      this.callbacks.log(level, line)
    }
  }

  private encoderLogBuf = ''

  /** Material produced by each pass, keyed by `EncoderPass.seq`. */
  private readonly passMaterial = new Map<number, number>()

  /**
   * A pass finished: account for its span and let the caller start the next one.
   *
   * There is no segment file to inspect — the pass streamed its output into the
   * socket — so the span comes from the last progress report, falling back to what
   * the pass was asked to produce.
   */
  private finishPass(pass: EncoderPass, code: number | null): void {
    // `seq` is always set by `startEncoder`; the fallback only satisfies the type.
    const seq = pass.seq ?? 0
    // Keyed by pass, not shared: a replaced encoder can still report progress for a
    // moment, and a single field would let one pass overwrite another's measurement.
    const materialSec = this.passMaterial.get(seq) ?? 0
    this.passMaterial.delete(seq)
    if (code !== 0) {
      this.callbacks.log('warn', `编码进程以退出码 ${code ?? '未知'} 结束（文件 ${path.basename(pass.input)}）。`)
    }
    if (materialSec <= 0) {
      if (code === 0) this.callbacks.log('debug', '本次编码没有产出可推流的数据。')
      this.callbacks.onEncoderExit(code, 0)
      return
    }
    // Prefer the measured span; fall back to what the pass was asked to produce.
    const span = materialSec > 0 ? materialSec : pass.expectedSec
    this.publishSegment(span)
    const pts = this.getTsPtsSpan()
    this.callbacks.log(
      'debug',
      `第 ${pass.seq} 段完成（${span.toFixed(2)}s），时间线推进到 ${this.nextOffset.toFixed(2)}s；片上视频 PTS ${Number.isNaN(pts.firstSec) ? '?' : pts.firstSec.toFixed(2)}–${Number.isNaN(pts.lastSec) ? '?' : pts.lastSec.toFixed(2)}s（${pts.videoHeaders} 帧 / ${(this.relayedBytes / 1024).toFixed(0)}KB）`
    )
    this.callbacks.onEncoderExit(code, span)
  }

  /**
   * Kills the current encoder, if any.
   *
   * `abandon` marks it as discarded rather than finished: a kill is asynchronous, so
   * the process can still exit normally afterwards, and without this the engine
   * would be told that a file it just skipped over had completed.
   */
  private killEncoder(abandon = false): void {
    const child = this.encoder
    this.encoder = null
    if (abandon && this.currentPass) this.currentPass.abandoned = true
    // The pass will never report again: its exit handler ignores a replaced encoder,
    // so nothing else would remove its measurement from the map.
    if (this.currentPass?.seq !== undefined) this.passMaterial.delete(this.currentPass.seq)
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}
