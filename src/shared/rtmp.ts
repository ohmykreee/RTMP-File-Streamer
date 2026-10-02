/**
 * RTMP target composition, used by the main process (ffmpeg target), the
 * connection test and the engine log.
 *
 * Rule: the stream key is appended **directly** to the address — the app never
 * inserts a separator between them (`.../live` + `abc` → `.../liveabc`). The
 * address the user typed is expected to already carry its full path, including
 * a trailing `/` when the platform's key must sit behind one. The key is
 * optional: without it the address itself is the push target.
 *
 * The only normalisation is whitespace trimming and collapsing a doubled
 * separator when the user typed BOTH a trailing `/` on the address and a
 * leading `/` on the key — the app itself never adds one.
 */
export function buildRtmpTarget(address: string, streamKey: string): string {
  const base = (address ?? '').trim()
  const key = (streamKey ?? '').trim()
  if (!base) return ''
  if (!key) return base
  if (base.endsWith('/') && key.startsWith('/')) return base + key.slice(1)
  return base + key
}
