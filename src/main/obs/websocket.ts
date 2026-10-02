import crypto from 'node:crypto'
import net, { type Server, type Socket } from 'node:net'
import type { EngineState, ObsWebSocketSettings, ObsWebSocketStatus } from '@shared/types'

/**
 * A minimal obs-websocket v5 compatible control endpoint.
 *
 * Scope: remote-control clients (Streamer.bot, Touch Portal, Deckboard, custom
 * scripts) should be able to point at this app instead of OBS and drive the
 * stream. Only the stream control requests do real work —
 *
 *   SetStreamServiceSettings, StartStream, StopStream
 *
 * — plus the handful of read requests a client asks during connect
 * (GetVersion / GetStreamStatus / GetSceneList / …). Every other request is
 * answered with a generic success, which is what the task asks for: a client
 * that wants to know "is the output running" must not be told the feature is
 * missing.
 *
 * Implemented on `node:net` + `node:crypto` on purpose: the server has to live
 * in the electron-vite main bundle, so pulling in `ws` would mean touching the
 * build config for one feature. The wire protocol needed here (RFC 6455 text
 * frames, no extensions, no fragmentation of outgoing messages) is small.
 */

/* ------------------------------------------------------------------ *
 * Protocol constants
 * ------------------------------------------------------------------ */

/** obs-websocket 5.x reports its own version in the version object. */
export const OBS_WS_VERSION = '5.5.2'
export const OBS_WS_RPC_VERSION = 1
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const SUBPROTOCOL = 'obswebsocket.json'
/** Requests larger than this are refused outright (protects against garbage). */
const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** How long a socket may sit in the HTTP upgrade phase before it is dropped. */
const HANDSHAKE_TIMEOUT_MS = 5000

/** obs-websocket opcodes. */
const OP_HELLO = 0
const OP_IDENTIFY = 1
const OP_IDENTIFIED = 2
const OP_REIDENTIFY = 3
const OP_REQUEST = 6
const OP_REQUEST_RESPONSE = 7

/** obs-websocket `RequestStatus` codes. */
const REQUEST_STATUS = { success: 100, notSupported: 204, invalidData: 400, notIdentified: 403 } as const

const AVATAR = ((): string => {
  const a = ['🟢', '⚪', '🔵', '🟣']
  return a[Math.floor(Math.random() * a.length)]
})()

export interface ObsWebSocketDeps {
  settings: () => ObsWebSocketSettings
  /** RTMP destination currently configured (address + stream key). */
  streamTarget: () => { server: string; streamKey: string }
  /** Writes address/key back into the session settings. */
  applyStreamTarget: (patch: { server?: string; streamKey?: string }) => void
  engineState: () => EngineState
  startStream: () => Promise<unknown>
  stopStream: () => Promise<unknown>
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

/* ------------------------------------------------------------------ *
 * Wire helpers
 * ------------------------------------------------------------------ */

/** Encodes one unmasked server -> client frame (text unless `opcode` says otherwise). */
function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

interface DecodedFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

interface DecodeResult {
  frame: DecodedFrame | null
  rest: Buffer
}

/**
 * Decodes the next complete frame.
 *
 * Client frames are always masked; an unmasked one is a protocol error, so the
 * connection is torn down instead of guessing. Fragmented frames are handled by
 * the caller (opcode 0 continuations simply append to its buffer).
 */
function decodeFrame(buf: Buffer): DecodeResult | null {
  if (buf.length < 2) return { frame: null, rest: buf }
  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < offset + 2) return { frame: null, rest: buf }
    len = buf.readUInt16BE(offset)
    offset += 2
  } else if (len === 127) {
    if (buf.length < offset + 8) return { frame: null, rest: buf }
    const big = buf.readBigUInt64BE(offset)
    if (big > BigInt(MAX_FRAME_BYTES)) return null
    len = Number(big)
    offset += 8
  }
  if (len > MAX_FRAME_BYTES) return null
  if (!masked) return null
  if (buf.length < offset + 4 + len) return { frame: null, rest: buf }
  const mask = buf.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) payload[i] = buf[offset + i] ^ mask[i & 3]
  return { frame: { fin, opcode, payload }, rest: buf.subarray(offset + len) }
}

export function obsAuthString(password: string, salt: string, challenge: string): string {
  const secret = crypto.createHash('sha256').update(`${password}${salt}`, 'utf8').digest('base64')
  return crypto.createHash('sha256').update(`${secret}${challenge}`, 'utf8').digest('base64')
}

/* ------------------------------------------------------------------ *
 * Connected client
 * ------------------------------------------------------------------ */

interface Client {
  id: number
  socket: Socket
  buffer: Buffer
  /** Accumulates a fragmented message until its final frame arrives. */
  fragment: Buffer | null
  fragmentOpcode: number
  upgraded: boolean
  identified: boolean
  /** Assigned by Identify; only echoed in event payloads. */
  sessionId: string
  remote: string
  handshakeTimer: NodeJS.Timeout | null
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

export class ObsWebSocketServer {
  private readonly deps: ObsWebSocketDeps
  private server: Server | null = null
  private clients = new Set<Client>()
  private nextId = 1
  private lastError = ''
  private boundHost = ''
  private boundPort = 0

  constructor(deps: ObsWebSocketDeps) {
    this.deps = deps
  }

  /* ---------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------- */

  status(): ObsWebSocketStatus {
    const configured = this.deps.settings()
    const host = this.server ? this.boundHost : configured.host || '127.0.0.1'
    const port = this.server ? this.boundPort : Number(configured.port) || 0
    return {
      running: this.server !== null,
      host,
      port,
      url: `ws://${host.includes(':') ? `[${host}]` : host}:${port}`,
      clients: this.identifiedCount(),
      error: this.lastError
    }
  }

  /** Applies the current settings; safe to call on every settings change. */
  apply(): ObsWebSocketStatus {
    const cfg = this.deps.settings()
    if (!cfg.enabled) {
      const wasRunning = this.server !== null
      this.stop()
      this.lastError = ''
      if (wasRunning) this.deps.log('info', 'obs-websocket 控制服务已关闭。')
      return this.status()
    }

    const host = (cfg.host || '127.0.0.1').trim()
    const port = normalizePort(cfg.port)
    if (this.server && this.boundHost === host && this.boundPort === port) return this.status()

    this.stop()
    this.start(host, port)
    return this.status()
  }

  private start(host: string, port: number): void {
    this.lastError = ''
    const server = net.createServer((socket) => this.onConnection(socket))
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError = err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : err.message
      this.deps.log('error', `obs-websocket 服务启动失败（${host}:${port}）：${this.lastError}`)
      this.server = null
      try {
        server.close()
      } catch {
        /* already dead */
      }
    })
    server.listen({ host, port, exclusive: true }, () => {
      this.server = server
      this.boundHost = host
      this.boundPort = port
      this.lastError = ''
      this.deps.log('info', `obs-websocket 控制服务已启动：ws://${host}:${port}（${this.deps.settings().password ? '需要密码' : '无需密码'}）`)
    })
    // The listener address is only known after the async listen callback; keep
    // the requested values so `status()` is correct even before it fires.
    this.boundHost = host
    this.boundPort = port
  }

  stop(): void {
    const server = this.server
    this.server = null
    for (const c of [...this.clients]) this.dropClient(c)
    if (server) {
      try {
        server.close()
      } catch {
        /* ignore */
      }
    }
  }

  private identifiedCount(): number {
    let n = 0
    for (const c of this.clients) if (c.identified) n += 1
    return n
  }

  /* ---------------------------------------------------------- *
   * Connection / HTTP upgrade
   * ---------------------------------------------------------- */

  private onConnection(socket: Socket): void {
    const client: Client = {
      id: this.nextId++,
      socket,
      buffer: Buffer.alloc(0),
      fragment: null,
      fragmentOpcode: 0,
      upgraded: false,
      identified: false,
      sessionId: '',
      remote: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`,
      handshakeTimer: null
    }
    this.clients.add(client)
    socket.setNoDelay(true)
    client.handshakeTimer = setTimeout(() => {
      if (!client.upgraded) this.dropClient(client)
    }, HANDSHAKE_TIMEOUT_MS)

    socket.on('data', (chunk) => this.onData(client, chunk))
    socket.on('error', () => this.dropClient(client))
    socket.on('close', () => this.dropClient(client, true))
  }

  private dropClient(client: Client, silent = false, graceMs = 0): void {
    if (client.handshakeTimer) {
      clearTimeout(client.handshakeTimer)
      client.handshakeTimer = null
    }
    const known = this.clients.delete(client)
    if (known && client.identified && !silent) {
      this.deps.log('info', `obs-websocket 客户端已断开：${client.remote}`)
    }
    if (graceMs > 0) {
      // Give the close frame a moment to reach the client before the socket is
      // torn down for good.
      setTimeout(() => {
        try {
          client.socket.destroy()
        } catch {
          /* ignore */
        }
      }, graceMs).unref?.()
      return
    }
    try {
      client.socket.destroy()
    } catch {
      /* ignore */
    }
  }

  private onData(client: Client, chunk: Buffer): void {
    client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk])
    if (!client.upgraded) {
      const end = client.buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (client.buffer.length > 16 * 1024) this.dropClient(client)
        return
      }
      const head = client.buffer.subarray(0, end).toString('latin1')
      client.buffer = client.buffer.subarray(end + 4)
      if (!this.upgrade(client, head)) return
      if (client.buffer.length > 0) {
        const rest = client.buffer
        client.buffer = Buffer.alloc(0)
        this.onData(client, rest)
      }
      return
    }
    this.drainFrames(client)
  }

  /** Answers the HTTP upgrade. Returns false when the request was rejected. */
  private upgrade(client: Client, head: string): boolean {
    const lines = head.split('\r\n')
    const requestLine = lines[0] ?? ''
    const headers = new Map<string, string>()
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
    }
    const key = headers.get('sec-websocket-key')
    const upgrade = (headers.get('upgrade') ?? '').toLowerCase()
    if (!/^GET\s/i.test(requestLine) || upgrade !== 'websocket' || !key) {
      client.socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      this.dropClient(client, true)
      return false
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    const response = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      `Sec-WebSocket-Protocol: ${SUBPROTOCOL}`,
      '\r\n'
    ].join('\r\n')
    client.socket.write(response)
    client.upgraded = true
    if (client.handshakeTimer) {
      clearTimeout(client.handshakeTimer)
      client.handshakeTimer = null
    }
    this.send(client, this.hello(client))
    return true
  }

  /* ---------------------------------------------------------- *
   * Framing
   * ---------------------------------------------------------- */

  private drainFrames(client: Client): void {
    for (;;) {
      const decoded = decodeFrame(client.buffer)
      if (decoded === null) {
        // Protocol violation (unmasked or oversized frame).
        this.closeWith(client, 1002, 'protocol error')
        return
      }
      if (!decoded.frame) {
        client.buffer = decoded.rest
        return
      }
      client.buffer = decoded.rest
      const { opcode, fin, payload } = decoded.frame

      if (opcode === 0x8) {
        this.closeWith(client, 1000, '')
        return
      }
      if (opcode === 0x9) {
        this.sendFrame(client, payload, 0xa)
        continue
      }
      if (opcode === 0xa) continue

      if (opcode === 0x1 || opcode === 0x2) {
        client.fragmentOpcode = opcode
        client.fragment = payload
      } else if (opcode === 0x0 && client.fragment) {
        client.fragment = Buffer.concat([client.fragment, payload])
      } else {
        this.closeWith(client, 1002, 'unexpected opcode')
        return
      }
      if (!fin) continue

      const message = client.fragment
      const messageOpcode = client.fragmentOpcode
      client.fragment = null
      if (message && messageOpcode === 0x1) this.onMessage(client, message.toString('utf8'))
    }
  }

  private send(connection: Client, payload: unknown): void {
    this.sendFrame(connection, Buffer.from(JSON.stringify(payload), 'utf8'), 0x1)
  }

  private sendFrame(connection: Client, payload: Buffer, opcode: number): void {
    if (!connection.upgraded || connection.socket.destroyed) return
    try {
      connection.socket.write(encodeFrame(payload, opcode))
    } catch {
      this.dropClient(connection, true)
    }
  }

  /**
   * Sends a close frame and then ends the socket.
   *
   * `end()` rather than `destroy()`: the close frame is the only way a client
   * learns *why* it was disconnected (bad auth, protocol error), and an abrupt
   * destroy can discard it before the kernel flushes.
   */
  private closeWith(client: Client, code: number, reason: string): void {
    if (client.upgraded && !client.socket.destroyed) {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2, 'utf8')
      try {
        client.socket.write(encodeFrame(payload, 0x8), () => client.socket.end())
      } catch {
        /* fall through to the destroy below */
      }
    }
    this.dropClient(client, true, 900)
  }

  /* ---------------------------------------------------------- *
   * obs-websocket protocol
   * ---------------------------------------------------------- */

  private hello(client: Client): unknown {
    const cfg = this.deps.settings()
    let authentication: { salt: string; challenge: string } | undefined
    if (cfg.password) {
      // The challenge is minted per connection and remembered until Identify,
      // because the client's answer can only be verified against this exact pair.
      authentication = {
        salt: crypto.randomBytes(16).toString('base64'),
        challenge: crypto.randomBytes(16).toString('base64')
      }
      this.pendingAuth.set(client, authentication)
    }
    return {
      op: OP_HELLO,
      d: {
        obsWebSocketVersion: OBS_WS_VERSION,
        rpcVersion: OBS_WS_RPC_VERSION,
        ...(authentication ? { authentication } : {}),
        // Lets a client tell this app apart from OBS in its UI.
        publisher: 'RTMP File Streamer'
      }
    }
  }

  private onMessage(client: Client, text: string): void {
    let msg: { op?: number; d?: Record<string, unknown> }
    try {
      msg = JSON.parse(text) as { op?: number; d?: Record<string, unknown> }
    } catch {
      this.closeWith(client, 1007, 'invalid payload')
      return
    }
    const data = msg.d ?? {}
    switch (msg.op) {
      case OP_IDENTIFY:
        this.onIdentify(client, data)
        return
      case OP_REIDENTIFY:
        if (client.identified) {
          client.sessionId = `rtmp-file-streamer-${client.id}`
          this.send(client, { op: OP_IDENTIFIED, d: { negotiatedRpcVersion: OBS_WS_RPC_VERSION } })
        } else {
          this.closeWith(client, 1008, 'not identified')
        }
        return
      case OP_REQUEST:
        void this.onRequest(client, data)
        return
      default:
        this.closeWith(client, 1002, `unexpected op ${msg.op ?? '?'}`)
    }
  }

  private onIdentify(client: Client, data: Record<string, unknown>): void {
    const cfg = this.deps.settings()
    const rpcVersion = Number(data.rpcVersion)
    if (Number.isFinite(rpcVersion) && rpcVersion > OBS_WS_RPC_VERSION) {
      this.closeWith(client, 4009, 'unsupported rpc version')
      return
    }
    if (cfg.password) {
      const authentication = String(data.authentication ?? '')
      const challenge = this.pendingAuth.get(client)
      // Without the challenge pair that was sent in the Hello there is nothing
      // to verify against, so the connection is refused rather than trusted.
      const expected = challenge ? obsAuthString(cfg.password, challenge.salt, challenge.challenge) : ''
      if (!authentication || !expected || authentication !== expected) {
        this.deps.log('warn', `obs-websocket 认证失败：${client.remote}`)
        this.closeWith(client, 4009, 'authentication failed')
        return
      }
    }
    this.pendingAuth.delete(client)
    client.identified = true
    client.sessionId = `rtmp-file-streamer-${client.id}`
    this.send(client, { op: OP_IDENTIFIED, d: { negotiatedRpcVersion: OBS_WS_RPC_VERSION } })
    this.deps.log('info', `obs-websocket 客户端已连接：${client.remote}`)
  }

  private readonly pendingAuth = new WeakMap<Client, { salt: string; challenge: string }>()

  private async onRequest(client: Client, data: Record<string, unknown>): Promise<void> {
    const requestType = String(data.requestType ?? '')
    const requestId = String(data.requestId ?? '')
    const requestData = (data.requestData ?? {}) as Record<string, unknown>

    if (!client.identified) {
      this.respond(client, requestId, REQUEST_STATUS.notIdentified, 'Not identified', {})
      return
    }
    try {
      const { status, comment, response } = await this.dispatch(requestType, requestData)
      this.respond(client, requestId, status, comment, response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log('warn', `obs-websocket 请求 ${requestType} 失败：${message}`)
      this.respond(client, requestId, REQUEST_STATUS.invalidData, message, {})
    }
  }

  private respond(client: Client, requestId: string, code: number, comment: string, response: unknown): void {
    this.send(client, {
      op: OP_REQUEST_RESPONSE,
      d: {
        requestId,
        requestStatus: { result: code === REQUEST_STATUS.success, code, comment: comment || undefined },
        responseData: response ?? {}
      }
    })
  }

  /** Maps one request to the OBS response shape. */
  private async dispatch(
    requestType: string,
    requestData: Record<string, unknown>
  ): Promise<{ status: number; comment: string; response: unknown }> {
    switch (requestType) {
      /* ---------------- read: handshake-time questions ---------------- */

      case 'GetVersion':
        return {
          status: REQUEST_STATUS.success,
          comment: '',
          response: {
            obsVersion: this.obsVersion(),
            obsWebSocketVersion: OBS_WS_VERSION,
            rpcVersion: OBS_WS_RPC_VERSION,
            // A recognisable platform name keeps clients from rejecting a
            // "non-OBS" endpoint during their handshake.
            platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
            platformDescription: `RTMP File Streamer (${AVATAR})`
          }
        }

      case 'GetStreamStatus':
        return { status: REQUEST_STATUS.success, comment: '', response: this.streamStatus() }

      case 'GetStreamServiceSettings':
        return {
          status: REQUEST_STATUS.success,
          comment: '',
          response: { streamServiceType: 'rtmp_custom', streamServiceSettings: this.streamServiceSettings() }
        }

      case 'GetSceneList':
        return {
          status: REQUEST_STATUS.success,
          comment: '',
          response: { currentProgramSceneName: null, currentPreviewSceneName: null, scenes: [] }
        }

      case 'GetCurrentProgramScene':
        return { status: REQUEST_STATUS.success, comment: '', response: { currentProgramSceneName: null, sceneName: null } }

      case 'GetSceneCollectionList':
        return {
          status: REQUEST_STATUS.success,
          comment: '',
          response: { currentSceneCollectionName: 'rtmp-file-streamer', sceneCollections: ['rtmp-file-streamer'] }
        }

      case 'GetProfileList':
        return { status: REQUEST_STATUS.success, comment: '', response: { currentProfileName: 'default', profiles: ['default'] } }

      case 'GetVideoSettings':
        return {
          status: REQUEST_STATUS.success,
          comment: '',
          response: { fpsNumerator: 30, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 }
        }

      case 'GetRecordStatus':
        return {
          status: REQUEST_STATUS.success,
          comment: '',
          response: { outputActive: false, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 }
        }

      case 'GetReplayBufferStatus':
        return { status: REQUEST_STATUS.success, comment: '', response: { outputActive: false } }

      case 'GetVirtualCamStatus':
        return { status: REQUEST_STATUS.success, comment: '', response: { outputActive: false } }

      case 'GetStudioModeEnabled':
        return { status: REQUEST_STATUS.success, comment: '', response: { studioModeEnabled: false } }

      /* ---------------- write: the real feature ---------------- */

      case 'SetStreamServiceSettings': {
        const settings = (requestData.streamServiceSettings ?? {}) as Record<string, unknown>
        const server = typeof settings.server === 'string' ? settings.server.trim() : undefined
        const key = typeof settings.streamKey === 'string' ? settings.streamKey : undefined
        if (server === undefined && key === undefined) {
          return { status: REQUEST_STATUS.invalidData, comment: 'streamServiceSettings 缺少 server / streamKey', response: {} }
        }
        this.deps.applyStreamTarget({ ...(server !== undefined ? { server } : {}), ...(key !== undefined ? { streamKey: key } : {}) })
        this.deps.log('info', `obs-websocket：已更新推流地址${server !== undefined ? ` server=${server}` : ''}${key !== undefined ? ' 与串流密钥' : ''}`)
        return { status: REQUEST_STATUS.success, comment: '', response: {} }
      }

      case 'StartStream': {
        if (this.engineBusy()) {
          return { status: REQUEST_STATUS.success, comment: '串流已在进行中', response: {} }
        }
        await this.deps.startStream()
        this.deps.log('info', 'obs-websocket：已请求开始串流。')
        return { status: REQUEST_STATUS.success, comment: '', response: {} }
      }

      case 'StopStream': {
        await this.deps.stopStream()
        this.deps.log('info', 'obs-websocket：已请求停止串流。')
        return { status: REQUEST_STATUS.success, comment: '', response: {} }
      }

      /* ---------------- everything else: generic success ---------------- */

      default:
        return { status: REQUEST_STATUS.success, comment: `request ${requestType} is not implemented; reported as success`, response: {} }
    }
  }

  /* ---------------------------------------------------------- *
   * Engine / settings adapters
   * ---------------------------------------------------------- */

  private obsVersion(): string {
    try {
      const v = process.versions.electron ?? '0.0.0'
      return `${v.split('.')[0]}.0.0`
    } catch {
      return '30.0.0'
    }
  }

  private engineBusy(): boolean {
    const state = this.deps.engineState()
    return state !== 'idle' && state !== 'error'
  }

  private streamStatus(): Record<string, unknown> {
    const active = this.deps.engineState() === 'live'
    return {
      outputActive: active,
      outputReconnecting: this.deps.engineState() === 'reconnecting',
      outputTimecode: '00:00:00.000',
      outputDuration: 0,
      outputCongestion: 0,
      outputBytes: 0,
      outputSkippedFrames: 0,
      outputTotalFrames: 0
    }
  }

  private streamServiceSettings(): Record<string, unknown> {
    const { server, streamKey } = this.deps.streamTarget()
    return { server, streamKey, service: 'rtmp_custom', useAuth: false, username: '', password: '' }
  }
}

function normalizePort(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 1) return 4455
  return Math.min(65535, n)
}
