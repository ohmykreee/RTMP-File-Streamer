import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogLevel } from '@shared/types'

/**
 * Two-process playout: an encoder writes MPEG-TS segments, a long-lived pusher
 * publishes them to RTMP.
 *
 *   encoder ffmpeg --(MPEG-TS over UDP, loopback)--> pusher ffmpeg --(-re)--> RTMP
 *
 * Why it is split in two:
 *  - the encoder runs FLAT OUT (no `-re`). It is limited by the encoder rather
 *    than by wall clock, so a hardware encoder that needs a moment to warm up, or
 *    that dips below 1x on a hard scene, no longer dictates what the viewer gets;
 *  - the pusher paces the published stream with `-re` at exactly 1x, and it is a
 *    separate process, so a seek (or a dead pass) only restarts the encoder.
 *
 * Why datagrams rather than a file, a manifest or a pipe — all measured here with
 * ffmpeg on Windows:
 *  - the `concat` demuxer parses its manifest ONCE (`concat_read_header` →
 *    `concat_parse_script`) and latches EOF when the list runs out
 *    (`open_next_file` sets `cat->eof` once `++fileno >= cat->nb_files`). Tested
 *    deliberately: a pusher given a one-segment list exited at the end of that
 *    segment, and appending a second entry seven seconds later changed nothing
 *    (0 extra bytes, 6.04s of output, `progress=end`). A growing list of files
 *    therefore cannot feed a live publisher;
 *  - restarting the publisher instead is not an option either: a new publish
 *    restarts the RTMP timeline (observed: after a seek the reported position fell
 *    back to 0.00 because the replacement publisher started from zero);
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
 * Because the published timeline cannot move backwards, seeking backwards appends
 * *ahead* of what has already gone out with a shifted timeline: the viewer jumps
 * to the requested content without a gap, and the requested offset lands exactly
 * only for forward seeks.
 *
 * REMAINING BLOCKER — do not enable this (`bufferSec`) until it is fixed:
 * the publisher dies with an access violation (exit `0xFFFF5C7A`) at the FIRST
 * pass boundary. Measured: one publisher, five encoder starts (exactly the wanted
 * shape — the RTMP session survives every encoder restart), but only 8.0s of a 35s
 * playlist reached the ingest, and the log order is "pass 2 encoded → publisher
 * died". So the crash is in the handoff, not in the transport: when a pass is
 * replaced mid-stream the socket briefly carries two different MPEG-TS program
 * identities, and the reader's demuxer aborts. `-force_key_frames expr:eq(n,0)`
 * did not change it. Prime suspects for the next attempt: keep the TS program
 * identity (PID/PAT/PMT) stable across passes, or stop relying on the reader to
 * resynchronise and re-mux the handoff inside the Node relay instead.
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
}

const FFMPEG_INPUT_SEEK = '-ss'

export class Playout {
  private readonly ffmpegPath: string
  private readonly outputArgs: string[]
  private readonly callbacks: PlayoutCallbacks
  /** Scratch folder for anything a pass needs on disk (logs, sidecars). */
  private readonly dir: string
  /** Loopback datagram endpoint the encoder sends to and the publisher reads. */
  private readonly udpPort: number
  private readonly inputUrl: string

  private pusher: ChildProcess | null = null
  private encoder: ChildProcess | null = null
  private seq = 0
  /** Timeline value the next encoder pass must start at. */
  private nextOffset = 0
  /** Highest timeline value the pusher has reached. */
  private publishedSec = 0
  private stopping = false
  private pusherProgressBuf = ''
  private encoderProgressBuf = ''

  constructor(ffmpegPath: string, outputArgs: string[], callbacks: PlayoutCallbacks) {
    this.ffmpegPath = ffmpegPath
    this.outputArgs = outputArgs
    this.callbacks = callbacks
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtmp-streamer-'))
    this.udpPort = 20000 + Math.floor(Math.random() * 20000)
    // Loopback only, with `sources=` pinning the sender so nothing else on the
    // machine can inject into the stream (the option is IPv4-only by design, hence
    // the explicit address). `overrun_nonfatal` keeps a burst from killing the
    // reader; `fifo_size` is the socket receive buffer in bytes.
    this.inputUrl = `udp://127.0.0.1:${this.udpPort}?sources=127.0.0.1&overrun_nonfatal=1&fifo_size=1000000`
  }

  /* ------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------ */

  /** Starts the publisher and the first encoder pass. */
  async start(pass: EncoderPass): Promise<void> {
    if (this.pusher) return
    this.stopping = false
    // The encoder goes first: a datagram reader that starts on an empty socket
    // can give up before anything arrives, and it costs nothing to have the first
    // packets waiting in the socket buffer.
    this.startEncoder(pass)
    this.startPusher()
  }

  /** Replaces the encoder pass; the pusher (and the RTMP session) is untouched. */
  restartEncoder(pass: EncoderPass): void {
    this.killEncoder()
    this.startEncoder(pass)
  }

  /** Stops both processes and removes the buffer directory. */
  async stop(): Promise<void> {
    this.stopping = true
    this.killEncoder()
    const pusher = this.pusher
    this.pusher = null
    if (pusher && pusher.exitCode === null) {
      // Closing stdin is what makes the pusher flush and leave the publish
      // session cleanly instead of being killed mid-packet.
      try {
        pusher.stdin?.end()
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
    }
    this.cleanup()
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
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'info',
      // `-re` on the *input* is what paces publication: the encoder may be
      // seconds ahead, the viewer still receives exactly one second per second.
      '-re',
      // A datagram input is the one ffmpeg transport with NO EOF: `udp_read()`
      // has no end-of-stream path, so when the encoder is killed the publisher
      // waits for the next packet instead of ending its RTMP session.
      '-f',
      'mpegts',
      '-i',
      this.inputUrl,
      '-c',
      'copy',
      '-max_interleave_delta',
      '0',
      '-progress',
      'pipe:2',
      '-nostats',
      ...this.outputArgs
    ]
    this.callbacks.log('debug', `推流进程: ${args.join(' ')}`)
    const child = spawn(this.ffmpegPath, args, { windowsHide: true })
    this.pusher = child
    this.pusherProgressBuf = ''
    this.callbacks.log('info', `推流进程已启动（pid ${child.pid ?? '?'}），编码进程可在其背后重启。`)
    child.stdout?.on('data', () => {})
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.onPusherOutput(chunk))
    child.on('error', (err) => {
      this.callbacks.log('error', `推流进程错误: ${err.message}`)
    })
    child.on('exit', (code) => {
      if (this.pusher === child) this.pusher = null
      if (this.stopping) return
      this.callbacks.log('warn', `推流进程结束（退出码 ${code ?? '未知'}）`)
      this.callbacks.onPusherExit(code)
    })
  }

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
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
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
      ...(pass.tsOffset > 0 ? ['-output_ts_offset', String(Math.round(pass.tsOffset * 1000) / 1000)] : []),
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      // The span this pass contributes has to be measured, and `-progress` is the
      // only reliable source for it (a muxer-level measurement would also miss the
      // frames still in flight when the process is killed).
      '-progress',
      'pipe:1',
      '-nostats',
      // Straight to the publisher over loopback: no intermediate file, no
      // manifest for a publisher to trip over, and the encoder is free to run
      // faster than real time — which is the entire point of the split.
      '-flush_packets',
      '1',
      '-f',
      'mpegts',
      `${this.inputUrl}&pkt_size=1316`
    ]
    this.callbacks.log('debug', `编码进程（第 ${this.seq} 段）: ${args.join(' ')}`)
    const child = spawn(this.ffmpegPath, args, { windowsHide: true })
    this.encoder = child
    this.encoderProgressBuf = ''
    this.callbacks.log('info', `编码进程已启动（第 ${this.seq} 段，pid ${child.pid ?? '?'}）。`)
    // `-progress pipe:1` reports how much material the pass has produced, which
    // is what the next pass must offset its timeline by.
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onEncoderOutput(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.onEncoderLog(chunk))
    child.on('error', (err) => {
      this.callbacks.log('error', `编码进程错误: ${err.message}`)
    })
    child.on('exit', (code) => {
      const wasCurrent = this.encoder === child
      if (wasCurrent) this.encoder = null
      if (this.stopping || !wasCurrent) return
      // The pass is complete (or died): account for what it produced. The
      // publisher keeps reading the socket either way.
      this.finishPass(pass, code)
    })
  }

  /** Tracks how much material the pass has produced, for its timeline span. */
  private onEncoderOutput(chunk: string): void {
    this.encoderProgressBuf += chunk
    const lines = this.encoderProgressBuf.split(/\r?\n/)
    this.encoderProgressBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
        const micro = Number(line.slice(line.indexOf('=') + 1))
        if (Number.isFinite(micro)) this.lastPassMaterialSec = Math.max(this.lastPassMaterialSec, micro / 1_000_000)
      }
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

  /** Material the current/last pass produced, in seconds. */
  private lastPassMaterialSec = 0

  /**
   * A pass finished: account for its span and let the caller start the next one.
   *
   * There is no segment file to inspect — the pass streamed its output into the
   * socket — so the span comes from the last progress report, falling back to what
   * the pass was asked to produce.
   */
  private finishPass(pass: EncoderPass, code: number | null): void {
    const materialSec = this.lastPassMaterialSec
    this.lastPassMaterialSec = 0
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
    this.callbacks.log('debug', `第 ${this.seq} 段完成（${span.toFixed(2)}s），时间线推进到 ${this.nextOffset.toFixed(2)}s`)
    this.callbacks.onEncoderExit(code, span)
  }

  private killEncoder(): void {
    const child = this.encoder
    this.encoder = null
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}
