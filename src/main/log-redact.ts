import type { OutputSettings, StreamProtocol } from '@shared/types'
import { buildPushTarget } from '@shared/protocol'

/**
 * The stream key never reaches the screen or the log.
 *
 * Every display form is built from the parts, never parsed out of the composed
 * string: the masked target is simply the real target rebuilt with `*****` in
 * the key's place, and `redactText` is plain literal replacement of the known
 * secret values. Nothing pattern-matches the text — a regex heuristic can only
 * ever half-know where a credential sits (path segment, query parameter, Bearer
 * header), and each guess it misses is a working credential on disk.
 *
 * The credential boundary is the stream-key field, whose meaning follows the
 * protocol (RTMP/RTSP append it to the address, SRT makes it the `passphrase`
 * query parameter, WHIP sends it as `-authorization`). The address field is
 * deliberately NOT part of that boundary: the settings panel shows it in
 * plaintext at all times, so anything typed into it is already on screen by
 * design — credentials belong in the key field.
 *
 * Redaction happens at the log sink and at the IPC boundary that returns test
 * results — never in the command builders, because the command that runs must
 * keep the real target.
 */

const MASK = '*****'

export interface RedactionSecrets {
  /** The composed push target (address + key) and its display form. */
  targets: Array<{ raw: string; masked: string }>
  /** The raw key, for diagnostics that print it outside the target (WHIP's `-authorization`, ffmpeg echoes). */
  keys: string[]
}

/**
 * The display form of a push target: the address with the key replaced whole by
 * `*****`. `buildPushTarget` already knows where each protocol puts the key, so
 * rebuilding with `*****` needs no parsing of the composed string.
 */
export function maskTarget(address: string, streamKey: string, protocol: StreamProtocol | undefined): string {
  return buildPushTarget(address, (streamKey ?? '').trim() ? MASK : '', protocol)
}

/** Collects the values that must never appear in a log line or result message. */
export function collectSecrets(output: OutputSettings | undefined): RedactionSecrets {
  if (!output) return { targets: [], keys: [] }
  const server = output.server ?? ''
  const key = (output.streamKey ?? '').trim()
  const target = buildPushTarget(server, key, output.protocol)
  return {
    targets: target && key ? [{ raw: target, masked: maskTarget(server, key, output.protocol) }] : [],
    // A very short key would match ordinary words and mangle the log; inside the
    // target it is still hidden, because the whole target is replaced at once.
    keys: key.length >= 4 ? [key] : []
  }
}

/** Replaces every occurrence of the configured credentials with `*****`. */
export function redactText(text: string, secrets: RedactionSecrets): string {
  if (!text) return text
  let out = text
  for (const { raw, masked } of secrets.targets) {
    if (raw) out = out.split(raw).join(masked)
  }
  for (const key of secrets.keys) {
    if (key) out = out.split(key).join(MASK)
  }
  return out
}
