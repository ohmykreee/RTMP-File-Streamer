/**
 * Bytes per second off a cumulative counter, over a short trailing window.
 *
 * The counter is what ffmpeg's `-progress` reports as `total_size`: the bytes it has
 * written to the output, which for a publish session is what has left the socket
 * towards the server. That is the only figure that answers "how much of the link am
 * I using", and it is deliberately not the same thing as the encoder's own `bitrate`:
 * the encoder's number carries no container or protocol overhead and says nothing
 * about a link that cannot take the rate being produced.
 *
 * A window rather than a session average: a link that degrades halfway through a
 * three-hour run has to show up in the readout, not be averaged away by the hours
 * that were fine.
 *
 * No `Date.now()` inside — samples carry their own time, which is what lets the
 * harness drive the arithmetic without waiting in real time.
 */

/** Samples older than this are dropped from the window. */
const WINDOW_MS = 2000

/**
 * Shortest window a figure may be derived from.
 *
 * Two adjacent samples span one progress report (~0.5 s), and a rate measured over
 * half a second of a bursty encoder swings by tens of percent — a readout nobody can
 * act on. Below this the meter reports nothing rather than a number that will be
 * contradicted half a second later.
 */
const MIN_SPAN_MS = 1000

/**
 * Shortest life a meter may have before it reports anything.
 *
 * The *first* sample of a session cannot be trusted even though later ones can: a
 * process that has only just started has written an initial burst (container header,
 * the first keyframe), and dividing that by the fraction of a second since startup
 * reported several times the real rate. Every later window covers a steady state.
 */
const MIN_ELAPSED_MS = 1200

export class ByteRateMeter {
  private bytes: number[] = []
  private stamps: number[] = []
  private last = -1
  private startedAt = 0

  /**
   * Records the counter's current value.
   *
   * A value at or below the previous one is ignored rather than treated as a negative
   * rate: each ffmpeg process counts from zero, so a replaced encoder pass — and a
   * reconnected publisher — restarts the counter, and that step would otherwise show
   * up as a large negative spike in the readout.
   */
  add(totalBytes: number, nowMs: number): void {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return
    if (this.last < 0) this.startedAt = nowMs
    else if (totalBytes <= this.last) return
    this.last = totalBytes
    this.bytes.push(totalBytes)
    this.stamps.push(nowMs)
    // Two samples are the minimum a rate can be computed from, so trimming keeps them
    // whatever the window says.
    while (this.stamps.length > 2 && nowMs - this.stamps[0] > WINDOW_MS) {
      this.stamps.shift()
      this.bytes.shift()
    }
  }

  /**
   * Current throughput in kbit/s, or 0 while there is not enough history to state one.
   *
   * 0 is the "no figure yet" value the status line renders as a dash; it is never a
   * real reading, because a session with samples to compare has moved bytes.
   */
  kbps(nowMs: number): number {
    if (this.stamps.length < 2) return 0
    if (nowMs - this.startedAt < MIN_ELAPSED_MS) return 0
    const oldest = this.stamps[0]
    const newest = this.stamps[this.stamps.length - 1]
    const spanMs = newest - oldest
    if (spanMs < MIN_SPAN_MS) return 0
    const bytes = this.bytes[this.bytes.length - 1] - this.bytes[0]
    if (bytes <= 0) return 0
    // bytes/second -> kbit/s is ×8/1000.
    return (bytes / (spanMs / 1000)) * 0.008
  }

  /** Forgets everything. Used when a new session opens (see `resetSessionStats`). */
  reset(): void {
    this.bytes = []
    this.stamps = []
    this.last = -1
    this.startedAt = 0
  }
}
