/**
 * Stream protocol support: detection from the address, the ffmpeg muxer each
 * protocol needs, and how the stream key is carried per protocol.
 *
 * One address field, one key field — no extra UI per protocol. The key field's
 * MEANING follows the protocol:
 *  - RTMP/RTMPS: appended directly to the address (see `rtmp.ts`)
 *  - SRT: appended as the `passphrase` query parameter (SRT's shared secret)
 *  - RTSP: appended directly to the address path; full user:pass authentication
 *    can be written into the address itself
 *  - WHIP: sent as the muxer's Bearer token (`-authorization`, a JWT)
 */
import type { ContainerName, StreamNetwork, StreamProtocol } from './types'
import { buildRtmpTarget } from './rtmp'

/** Protocols in dropdown order; `rtmp` is the default. */
export const STREAM_PROTOCOLS: StreamProtocol[] = ['rtmp', 'srt', 'rtsp', 'whip']

/** The ffmpeg output muxer each protocol pushes with. */
export const PROTOCOL_MUXER: Record<StreamProtocol, string> = {
  rtmp: 'flv',
  srt: 'mpegts',
  rtsp: 'rtsp',
  whip: 'whip'
}

/**
 * The container each protocol effectively carries — the subset of container-specific
 * behaviour (FLV flags, Enhanced-RTMP warnings, AAC bitstream filters) that applies
 * to it. RTSP and WHIP are their own wire formats and map to no container at all.
 */
export const PROTOCOL_CONTAINER: Record<StreamProtocol, ContainerName | null> = {
  rtmp: 'flv',
  srt: 'mpegts',
  rtsp: null,
  whip: null
}

/**
 * Network transports each protocol can use. SRT is UDP-only, WHIP rides HTTP(S)
 * over TCP, and RTMP is TCP-only; RTSP is the one protocol with a real choice.
 */
export const PROTOCOL_NETWORKS: Record<StreamProtocol, StreamNetwork[]> = {
  rtmp: ['tcp'],
  srt: ['udp'],
  rtsp: ['tcp', 'udp'],
  whip: ['tcp']
}

export const DEFAULT_STREAM_PROTOCOL: StreamProtocol = 'rtmp'

/** Clamps a network choice to what the protocol allows. */
export function networkForProtocol(protocol: StreamProtocol | undefined, network: StreamNetwork | undefined): StreamNetwork {
  const allowed = PROTOCOL_NETWORKS[protocol ?? DEFAULT_STREAM_PROTOCOL] ?? PROTOCOL_NETWORKS[DEFAULT_STREAM_PROTOCOL]
  return allowed.includes(network as StreamNetwork) ? (network as StreamNetwork) : allowed[0]
}

/**
 * Detects the protocol from the address scheme.
 *
 * Unknown or missing schemes fall back to RTMP — the app's default — rather than
 * guessing from the host or port.
 */
export function detectStreamProtocol(address: string): StreamProtocol {
  const url = (address ?? '').trim().toLowerCase()
  if (/^rtmps?:\/\//.test(url)) return 'rtmp'
  if (/^srt:\/\//.test(url)) return 'srt'
  if (/^rtsps?:\/\//.test(url)) return 'rtsp'
  if (/^(https?|webrtc):\/\//.test(url)) return 'whip'
  return DEFAULT_STREAM_PROTOCOL
}

/** The address schemes each protocol accepts, for validation messages. */
export const PROTOCOL_SCHEMES: Record<StreamProtocol, string> = {
  rtmp: 'rtmp:// · rtmps://',
  srt: 'srt://',
  rtsp: 'rtsp:// · rtsps://',
  whip: 'http:// · https://'
}

/** True when the address scheme matches the protocol. */
export function addressMatchesProtocol(address: string, protocol: StreamProtocol | undefined): boolean {
  const url = (address ?? '').trim().toLowerCase()
  const p = protocol ?? DEFAULT_STREAM_PROTOCOL
  if (p === 'rtmp') return /^rtmps?:\/\//.test(url)
  if (p === 'srt') return /^srt:\/\//.test(url)
  if (p === 'rtsp') return /^rtsps?:\/\//.test(url)
  return /^https?:\/\//.test(url)
}

/** The ffmpeg muxer for a protocol, tolerating settings objects from older schemas. */
export function muxerForProtocol(protocol: StreamProtocol | undefined): string {
  const p = protocol ?? DEFAULT_STREAM_PROTOCOL
  return p in PROTOCOL_MUXER ? PROTOCOL_MUXER[p] : PROTOCOL_MUXER[DEFAULT_STREAM_PROTOCOL]
}

/**
 * The effective container for a protocol, tolerating settings from older schemas.
 *
 * `??` cannot be used here: RTSP and WHIP legitimately map to `null` (no
 * container at all), and the nullish coalesce would turn that into the fallback.
 */
export function containerForProtocol(protocol: StreamProtocol | undefined): ContainerName | null {
  const p = protocol ?? DEFAULT_STREAM_PROTOCOL
  return p in PROTOCOL_CONTAINER ? PROTOCOL_CONTAINER[p] : PROTOCOL_CONTAINER[DEFAULT_STREAM_PROTOCOL]
}

/**
 * Builds the ffmpeg push target for a protocol.
 *
 * RTMP/RTMPS and RTSP carry the key IN the address (appended directly, the rule
 * `buildRtmpTarget` implements); SRT takes it as a `passphrase` query parameter
 * (percent-encoded, and skipped when the address already carries one); WHIP does
 * not carry it in the address at all — the key rides in the muxer's own
 * `-authorization` option (see `whipAuthArgs`).
 */
export function buildPushTarget(address: string, streamKey: string, protocol: StreamProtocol | undefined): string {
  const base = (address ?? '').trim()
  const key = (streamKey ?? '').trim()
  if (!base) return ''
  const p = protocol ?? DEFAULT_STREAM_PROTOCOL
  if (p === 'whip') return base
  if (p === 'srt') {
    if (!key || /[?&]passphrase=/.test(base)) return base
    return `${base}${base.includes('?') ? '&' : '?'}passphrase=${encodeURIComponent(key)}`
  }
  return buildRtmpTarget(base, key)
}

/**
 * Output arguments carrying the stream key for protocols whose key does NOT ride
 * in the address. WHIP's muxer takes the Bearer token through its own
 * `-authorization` option (it then sends `Authorization: Bearer <token>` on the
 * HTTP handshake itself).
 */
export function protocolKeyArgs(protocol: StreamProtocol | undefined, streamKey: string): string[] {
  const key = (streamKey ?? '').trim()
  if (!key) return []
  if ((protocol ?? DEFAULT_STREAM_PROTOCOL) === 'whip') return ['-authorization', key]
  return []
}
