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
  /** True while a publisher is being stopped on purpose (see `stopPusher`). */
  private suppressPusherExit = false
  /**
   * True between spawning an encoder and spawning its publisher.
   *
   * The encoder's stdout is PAUSED for this window. The encoder runs as fast as it
   * can, so a relay that accepts "just until the publisher is up" will happily
   * swallow the whole file — measured: a 1.5s publisher delay let a 15s file finish
   * encoding before the publisher existed, after which there was nothing left to
   * publish and the pass reported completion for material nobody had aired.
   *
   * Pausing (rather than dropping or buffering) is what makes the wait bounded: the
   * bytes stay in the pipe, the pipe fills, and ffmpeg blocks in `write()` — the same
   * backpressure the design relies on everywhere else.
   */
  private awaitingPusher = false
  /** The stream to un-pause once the publisher is up (see `awaitingPusher`). */
  private pausedStdout: Readable | null = null
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

  constructor(ffmpegPath: string, outputArgs: string[], callbacks: PlayoutCallbacks) {
    this.ffmpegPath = ffmpegPath
    this.outputArgs = outputArgs
    this.callbacks = callbacks
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  }

  /* ------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------ */

  /**
   * Starts the publisher and the first encoder pass.
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
    // `-re` means the publisher paces the read; until it exists the encoder must be
    // held by the pipe rather than by this process's memory (see `awaitingPusher`).
    // Set BEFORE the encoder spawns, because that is where the pause is applied.
    this.awaitingPusher = true
    // The encoder goes first: a reader that starts on an empty pipe would sit
    // waiting for a stream header, and it costs nothing to have the first packets
    // already in flight.
    this.startEncoder(pass)
    // A session restart has to re-establish the RTMP connection, and the server may
    // still be tearing the previous publish down; a first start only has to let the
    // ingest come up.
    const waitMs = retry ? 1500 : 400
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    if (this.stopping) {
      this.pausedStdout = null
      this.awaitingPusher = false
      return
    }
    this.awaitingPusher = false
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
    // Un-pause the encoder first: from here on the publisher is what paces it, and
    // either the pipe or the publisher's `-re` throttling provides the backpressure.
    this.pausedStdout?.resume()
    this.pausedStdout = null
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
    child.stdin?.on('error', (err) => {
      this.callbacks.log('debug', `推流进程输入已关闭（${(err as NodeJS.ErrnoException).code ?? err.message}）。`)
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
      if (afc !== 2 && afc !== 3) continue
      const afLen = buf[i + 4]
      if (afLen < 5 || (buf[i + 5] & 0x10) === 0) continue // need the PTS field
      const raw =
        (BigInt(buf[i + 6] & 0x0e) << 29n) |
        (BigInt(buf[i + 7]) << 22n) |
        (BigInt(buf[i + 8] & 0xfe) << 14n) |
        (BigInt(buf[i + 9]) << 7n) |
        (BigInt(buf[i + 10]) >> 1n)
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
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const micro = Number(value)
        if (!Number.isFinite(micro)) continue
        const sec = micro / 1_000_000
        if (sec > this.publishedSec) {
          this.publishedSec = sec
          this.callbacks.onPublished(sec)
        }
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
    // Pause BEFORE attaching the reader: adding a `data` listener puts the stream in
    // flowing mode, so a pause issued afterwards would still let the first chunks
    // through and the whole point — keeping the encoder blocked in the pipe while the
    // publisher is coming up — would be lost. `startPusher` resumes it.
    if (this.awaitingPusher && child.stdout) {
      child.stdout.pause()
      this.pausedStdout = child.stdout
    }
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
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}
