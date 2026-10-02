import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogLevel } from '@shared/types'

/**
 * Two-process playout: an encoder writes MPEG-TS segments, a long-lived pusher
 * publishes them to RTMP.
 *
 *   encoder ffmpeg --(seg-N.ts)--> manifest.txt --(-re -follow 1, concat)--> pusher ffmpeg --> RTMP
 *
 * Why it is split in two:
 *  - the encoder is allowed to run ahead by `bufferSec`, so a slow stretch
 *    (subtitle burn-in, a hardware encoder hiccup) drains the buffer instead of
 *    reaching the viewer as a stall;
 *  - a seek only restarts the *encoder*. The pusher keeps reading the manifest,
 *    so the RTMP publish session stays open and the player never re-buffers.
 *
 * The splice between two encoder passes goes through the concat demuxer rather
 * than raw bytes: it works on whole files, so a pass boundary can never cut a
 * 188-byte TS packet — which is exactly what produced "Packet corrupt" when two
 * raw MPEG-TS streams were glued together.
 *
 * Because the viewer's timeline cannot move backwards, seeking backwards still
 * appends *ahead* of what has already been published, with the timeline shifted
 * forward (see {@link seek}). The viewer jumps to the requested content without
 * a gap; the requested offset only lands exactly when seeking forward.
 *
 * NOT YET USABLE — kept behind `bufferSec = 0` for a follow-up:
 * a pusher that survives an encoder restart has to wait at the end of the
 * concat manifest for the next segment. `-follow 1` was expected to do that, but
 * measured on this platform it makes the input read nothing at all (0 bytes and
 * 0 progress samples in every variant that includes it, while the identical
 * command without it publishes normally at 1x with `-re`). Until the pusher can
 * be kept alive some other way, `bufferSec` must stay 0 and the single-process
 * path in engine.ts is what runs.
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
  private readonly dir: string
  private readonly manifest: string

  private pusher: ChildProcess | null = null
  private encoder: ChildProcess | null = null
  private manifestStream: fs.WriteStream | null = null
  private seq = 0
  /** Segments written and announced, with the timeline span each one covers. */
  private readonly segments: { file: string; durationSec: number; startSec: number }[] = []
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
    this.manifest = path.join(this.dir, 'manifest.txt')
  }

  /* ------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------ */

  /** Starts the pusher and the first encoder pass. */
  start(pass: EncoderPass): void {
    if (this.pusher) return
    this.stopping = false
    this.openManifest()
    this.startPusher()
    this.startEncoder(pass)
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
    this.closeManifest()
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
   * Segments / manifest
   * ------------------------------------------------------------ */

  private openManifest(): void {
    fs.writeFileSync(this.manifest, 'ffconcat version 1.0\n')
    this.manifestStream = fs.createWriteStream(this.manifest, { flags: 'a' })
  }

  private closeManifest(): void {
    try {
      this.manifestStream?.end()
    } catch {
      /* ignore */
    }
    this.manifestStream = null
  }

  /**
   * Announces a finished segment.
   *
   * The pass is described by its own span: `duration` is what this pass added to
   * the timeline, so the reader can splice the next file exactly where this one
   * ends without a gap or an overlap.
   */
  private publishSegment(file: string, durationSec: number): void {
    const span = Math.max(0.001, durationSec)
    const entry = `file '${file}'\nduration ${span.toFixed(3)}\n`
    this.manifestStream?.write(entry)
    this.segments.push({ file, durationSec: span, startSec: this.nextOffset })
    this.nextOffset += span
  }

  /** Drops segments the pusher has already passed, keeping the buffer bounded. */
  private trimConsumed(): void {
    // Keep a small window behind the playhead: the pusher may still be reading
    // the segment it is in the middle of.
    const threshold = this.publishedSec - 3
    while (this.segments.length > 1 && this.segments[0].startSec + this.segments[0].durationSec < threshold) {
      const gone = this.segments.shift()
      if (!gone) break
      try {
        fs.rmSync(path.join(this.dir, gone.file), { force: true })
      } catch {
        /* best effort */
      }
    }
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
      '-follow',
      '1',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      this.manifest,
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
          this.trimConsumed()
        }
      } else if (key === 'progress' && value === 'end') {
        // The pusher reached the end of the manifest; with `-follow` it keeps
        // waiting for the next segment instead of exiting.
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
    const file = `seg-${this.seq}.ts`
    const full = path.join(this.dir, file)
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
      // The viewer's timeline must not step backwards when a pass is replaced,
      // so the new pass continues exactly where the published stream already is.
      ...(pass.tsOffset > 0 ? ['-output_ts_offset', String(Math.round(pass.tsOffset * 1000) / 1000)] : []),
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-progress',
      'pipe:1',
      '-nostats',
      '-f',
      'mpegts',
      '-y',
      full
    ]
    this.callbacks.log('debug', `编码进程 → ${file}: ${args.join(' ')}`)
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
      // The pass is complete (or died): measure what it produced and splice it
      // in. The pusher keeps reading either way.
      void this.finishPass(full, file, pass, code)
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

  private async finishPass(full: string, file: string, pass: EncoderPass, code: number | null): Promise<void> {
    const materialSec = this.lastPassMaterialSec > 0 ? this.lastPassMaterialSec : 0
    this.lastPassMaterialSec = 0
    if (code !== 0) {
      this.callbacks.log('warn', `编码进程以退出码 ${code ?? '未知'} 结束（文件 ${path.basename(pass.input)}）。`)
    }
    if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
      this.callbacks.log('error', '编码进程没有产出任何数据，本段已跳过。')
      this.callbacks.onEncoderExit(code, 0)
      return
    }
    // Prefer the measured span; fall back to what the pass was asked to produce.
    const span = materialSec > 0 ? materialSec : pass.expectedSec
    this.publishSegment(file, span)
    this.callbacks.log(
      'debug',
      `已拼接 ${file}（${span.toFixed(2)}s），时间线推进到 ${this.nextOffset.toFixed(2)}s`
    )
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
