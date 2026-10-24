import type { OutputSettings } from '@shared/types'
import { buildPushTarget } from '@shared/protocol'

/**
 * Removes stream credentials from anything that is shown or persisted.
 *
 * The engine, ffmpeg and the publisher all print the push target in their own
 * diagnostics, and a target carries the stream key (RTMP/RTSP), the SRT
 * passphrase, or the WHIP authorization token. Logs are persisted and the log
 * panel can be copied, so a single unredacted line would leave a working
 * credential on disk. Redaction happens at the log sink and at the IPC boundary
 * that returns test results — never in the command builders, because the command
 * that runs must keep the real target.
 */

export interface RedactionSecrets {
  /** Complete push targets (address + key/passphrase) currently configured. */
  targets: string[]
  /** The raw stream key, for diagnostics that print it without the address. */
  keys: string[]
}

/** Collects the values that must never appear in a log line or result message. */
export function collectSecrets(output: OutputSettings | undefined): RedactionSecrets {
  if (!output) return { targets: [], keys: [] }
  const key = (output.streamKey ?? '').trim()
  const target = buildPushTarget(output.server ?? '', key, output.protocol)
  return {
    targets: target ? [target] : [],
    // A very short key would match ordinary words and mangle the log; the full
    // target (which contains it) is redacted separately.
    keys: key.length >= 4 ? [key] : []
  }
}

/**
 * Query parameters that carry credentials on real ingest URLs.
 *
 * Some providers put the username/password or a signature in the URL itself
 * (`?user=…&pass=…`, `?token=…`). Masking only the path segment left exactly those
 * values visible in the connection-test result and the log.
 */
const SECRET_QUERY_RE =
  /([?&])(pass|password|pwd|passphrase|key|apikey|api_key|streamkey|stream_key|token|access_token|secret|auth|authorization|user|username|signature|sig|sign)=([^&#\s'"]*)/gi

function maskQuery(query: string): string {
  return query.replace(SECRET_QUERY_RE, (_whole, separator: string, name: string) => `${separator}${name}=***`)
}

/**
 * Keeps the server address visible while hiding the part that authorises the
 * push: the last path segment is the key for RTMP/RTSP, and credential-shaped
 * query parameters (passphrase, token, user/pass, signature) are masked too.
 */
export function maskTarget(target: string): string {
  if (!target) return target
  const queryAt = target.indexOf('?')
  const base = queryAt >= 0 ? target.slice(0, queryAt) : target
  const query = queryAt >= 0 ? target.slice(queryAt) : ''
  const schemeEnd = base.indexOf('://')
  const slash = base.lastIndexOf('/')
  // A credential in the query means the key is not appended to the authority
  // (SRT passphrase, token-style URLs); do not invent a `/***` path segment.
  const credentialInQuery = /[?&](?:pass|password|pwd|passphrase|key|apikey|api_key|streamkey|stream_key|token|access_token|secret|auth|authorization|user|username|signature|sig|sign)=/i.test(
    query
  )
  let masked = base
  if (schemeEnd >= 0 && slash > schemeEnd + 2) {
    const tail = base.slice(slash + 1)
    if (tail) masked = `${base.slice(0, slash + 1)}***`
  } else if (schemeEnd >= 0 && !credentialInQuery) {
    // No path at all: the key was appended to the authority (`rtmp://host` + key).
    masked = `${base}/***`
  }
  return `${masked}${maskQuery(query)}`
}

/** Replaces every occurrence of the configured credentials with a masked form. */
export function redactText(text: string, secrets: RedactionSecrets): string {
  if (!text) return text
  let out = text
  // Longest first: a target that contains its key must be replaced as a whole,
  // otherwise the masked target would keep the raw key inside it.
  for (const target of [...secrets.targets].sort((a, b) => b.length - a.length)) {
    if (target) out = out.split(target).join(maskTarget(target))
  }
  for (const key of [...secrets.keys].sort((a, b) => b.length - a.length)) {
    if (key) out = out.split(key).join('***')
  }
  out = out.replace(/((?:^|\s)-authorization\s+)\S+/gi, '$1***')
  out = out.replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1***')
  // A target printed component by component (or an address edited since the
  // secret set was built) still exposes credentials in its query string.
  out = out.replace(SECRET_QUERY_RE, (_whole, separator: string, name: string) => `${separator}${name}=***`)
  return out
}
