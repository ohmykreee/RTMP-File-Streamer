/**
 * obs-websocket compatibility checks, run inside the plain-node harness.
 *
 * The app ships a hand-written obs-websocket v5 endpoint (`src/main/obs/
 * websocket.ts`) so OBS remote-control clients can drive the stream. These
 * checks talk to the REAL server class over a REAL socket with a minimal
 * WebSocket client written here (masked frames out, unmasked frames in), which
 * is what a client like Streamer.bot does:
 *
 *   Hello (no/with auth) -> Identify -> Identified -> requests -> responses
 *
 * `unit.mjs` bundles the server module before the harness runs; this file is
 * imported by `test/harness.mjs`.
 */
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ *
 * Minimal WebSocket client
 * ------------------------------------------------------------------ */

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload)
  const mask = crypto.randomBytes(4)
  let header
  if (data.length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = 0x80 | data.length
  } else if (data.length < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

function decodeFrames(buf) {
  const out = []
  for (;;) {
    if (buf.length < 2) return { frames: out, rest: buf }
    const opcode = buf[0] & 0x0f
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < 4) return { frames: out, rest: buf }
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) return { frames: out, rest: buf }
      len = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    if (buf.length < offset + len) return { frames: out, rest: buf }
    out.push({ opcode, payload: buf.subarray(offset, offset + len) })
    buf = buf.subarray(offset + len)
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Connects, upgrades, answers the Hello, and exposes `request()`.
 * `password` is used to compute the Identify auth string when challenged;
 * `authString` is the hash function under test (passed in by the caller).
 */
async function openClient(port, { password = '', authString } = {}) {
  const socket = net.connect({ host: '127.0.0.1', port })
  const client = {
    socket,
    buffer: Buffer.alloc(0),
    messages: [],
    upgraded: false,
    handshake: '',
    closed: false,
    closeCode: null,
    expectedAccept: ''
  }

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk])
    if (!client.upgraded) {
      // The HTTP response and the first frame can arrive in one chunk.
      const end = client.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      client.handshake = client.buffer.subarray(0, end).toString('latin1')
      client.buffer = client.buffer.subarray(end + 4)
      client.upgraded = true
    }
    const { frames, rest } = decodeFrames(client.buffer)
    client.buffer = rest
    for (const f of frames) {
      if (f.opcode === 0x8) {
        client.closed = true
        client.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 0
      } else if (f.opcode === 0x1) {
        try {
          client.messages.push(JSON.parse(f.payload.toString('utf8')))
        } catch {
          client.messages.push({ raw: f.payload.toString('utf8') })
        }
      }
    }
  })
  socket.on('close', () => {
    client.closed = true
  })
  socket.on('error', () => {
    client.closed = true
  })

  const key = crypto.randomBytes(16).toString('base64')
  client.expectedAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    [
      'GET / HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: obswebsocket.json',
      '\r\n'
    ].join('\r\n')
  )

  const waitFor = async (predicate, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = client.messages.find(predicate)
      if (found || client.closed) return found ?? null
      await delay(20)
    }
    return null
  }

  const hello = await waitFor((m) => m.op === 0)
  if (hello) {
    const challenge = hello.d.authentication
    const authentication = challenge && authString ? authString(password, challenge.salt, challenge.challenge) : ''
    socket.write(encodeFrame(JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(authentication ? { authentication } : {}), eventSubscriptions: 0 } })))
  }

  let seq = 0
  const request = async (requestType, requestData = {}, timeoutMs = 4000) => {
    const requestId = `t${++seq}`
    socket.write(encodeFrame(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })))
    return waitFor((m) => m.op === 7 && m.d?.requestId === requestId, timeoutMs)
  }

  return { client, hello, waitFor, request }
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.bundlePath  path of the bundled `src/main/obs/websocket.ts`
 * @param {(name: string, ok: boolean, detail?: string) => void} opts.record
 * @param {(key: string, params?: Record<string, unknown>) => string} [opts.t]
 *   Message lookup handed to the server. Defaults to the reference (English) table
 *   loaded from the i18n bundle next to the obs one, so the server still logs text.
 */
export async function obsWebSocketChecks({ bundlePath, record, t }) {
  const { ObsWebSocketServer, obsAuthString } = await import(pathToFileURL(bundlePath).href)
  if (!t) {
    const i18nPath = path.join(path.dirname(bundlePath), 'i18n.bundle.mjs')
    const { TRANSLATIONS } = await import(pathToFileURL(i18nPath).href)
    t = (key, params = {}) =>
      String(TRANSLATIONS.zh[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
  }

  /** A server wired to recording stubs, so request effects are observable. */
  function makeServer({ password = '' } = {}) {
    const state = { applied: [], started: 0, stopped: 0, logs: [], target: { server: 'rtmp://old/live/', streamKey: 'OLDKEY' } }
    const server = new ObsWebSocketServer({
      settings: () => ({ enabled: true, host: '127.0.0.1', port: 0, password }),
      streamTarget: () => state.target,
      applyStreamTarget: (patch) => {
        state.applied.push(patch)
        state.target = { ...state.target, ...patch }
      },
      engineState: () => (state.started > state.stopped ? 'live' : 'idle'),
      startStream: async () => {
        state.started += 1
      },
      stopStream: async () => {
        state.stopped += 1
      },
      log: (level, message) => state.logs.push(`${level}:${message}`),
      // The server writes its log lines through the message table it is handed; the
      // checks below read the Chinese wording this test has always asserted on.
      t
    })
    // Port 0 = let the OS pick, so the suite never fights the app for 4455.
    server.start('127.0.0.1', 0)
    return { server, state }
  }

  /** Waits for `listen()` to report its port. */
  async function boundPort(server) {
    for (let i = 0; i < 50; i += 1) {
      const address = server.server?.address?.()
      if (address && typeof address === 'object' && address.port) return address.port
      await delay(20)
    }
    return 0
  }

  /* ---------------- open endpoint ---------------- */
  {
    const { server, state } = makeServer()
    const port = await boundPort(server)
    record('obs-websocket server binds a port', port > 0, `port ${port}`)
    if (port === 0) return

    const { client, hello, waitFor, request } = await openClient(port)
    record(
      'Hello advertises obs-websocket 5.x and rpc v1',
      hello?.d?.obsWebSocketVersion?.startsWith('5.') === true && hello?.d?.rpcVersion === 1,
      JSON.stringify(hello?.d)
    )
    record('Hello omits the auth challenge when no password is set', !hello?.d?.authentication)
    record(
      'HTTP upgrade computes the RFC 6455 accept key',
      client.handshake.includes(`Sec-WebSocket-Accept: ${client.expectedAccept}`),
      client.handshake.split('\r\n').find((l) => l.startsWith('Sec-WebSocket-Accept'))
    )
    record('HTTP upgrade negotiates the obswebsocket.json subprotocol', client.handshake.includes('Sec-WebSocket-Protocol: obswebsocket.json'))

    const identified = await waitFor((m) => m.op === 2)
    record('Identify is answered with Identified', Boolean(identified), `negotiatedRpcVersion=${identified?.d?.negotiatedRpcVersion}`)

    const version = await request('GetVersion')
    record(
      'GetVersion reports the protocol versions',
      version?.d?.responseData?.obsWebSocketVersion === '5.5.2' && version?.d?.responseData?.rpcVersion === 1,
      JSON.stringify(version?.d?.responseData)
    )

    const set = await request('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: 'rtmp://new.example/live/', streamKey: 'NEWKEY' }
    })
    record('SetStreamServiceSettings succeeds with code 100', set?.d?.requestStatus?.result === true && set?.d?.requestStatus?.code === 100, JSON.stringify(set?.d?.requestStatus))
    record(
      'SetStreamServiceSettings writes address + key',
      state.applied.at(-1)?.server === 'rtmp://new.example/live/' && state.applied.at(-1)?.streamKey === 'NEWKEY',
      JSON.stringify(state.applied.at(-1))
    )

    const start = await request('StartStream')
    record('StartStream starts the engine', start?.d?.requestStatus?.result === true && state.started === 1, `started=${state.started}`)
    const live = await request('GetStreamStatus')
    record('GetStreamStatus reports the live output', live?.d?.responseData?.outputActive === true, JSON.stringify(live?.d?.responseData))
    const stop = await request('StopStream')
    record('StopStream stops the engine', stop?.d?.requestStatus?.result === true && state.stopped === 1, `stopped=${state.stopped}`)
    const idle = await request('GetStreamStatus')
    record('GetStreamStatus reports the idle output', idle?.d?.responseData?.outputActive === false)

    const scenes = await request('GetSceneList')
    record('GetSceneList answers with an empty scene list', Array.isArray(scenes?.d?.responseData?.scenes), JSON.stringify(scenes?.d?.responseData))
    const service = await request('GetStreamServiceSettings')
    record(
      'GetStreamServiceSettings returns the configured target',
      service?.d?.responseData?.streamServiceSettings?.server === 'rtmp://new.example/live/',
      JSON.stringify(service?.d?.responseData?.streamServiceSettings)
    )
    // Anything the app does not implement must still answer success: a client
    // that probes for a feature must not be told the endpoint is broken.
    const unimplemented = await request('TriggerHotkeyByName', { hotkeyName: 'OBSBasic.StartStreaming' })
    record(
      'unimplemented requests answer with a generic success',
      unimplemented?.d?.requestStatus?.result === true && unimplemented?.d?.requestStatus?.code === 100,
      JSON.stringify(unimplemented?.d?.requestStatus)
    )
    record('client connect is logged', state.logs.some((l) => l.includes('客户端已连接')), state.logs.find((l) => l.includes('客户端已连接')))
    record('setting the target is logged', state.logs.some((l) => l.includes('已更新推流地址')))

    /* A client frame must be masked; an unmasked one is a protocol error. */
    const raw = net.connect({ host: '127.0.0.1', port })
    let rawClosed = false
    let rawCloseCode = 0
    let rawBuffer = Buffer.alloc(0)
    let rawUpgraded = false
    raw.on('data', (chunk) => {
      rawBuffer = Buffer.concat([rawBuffer, chunk])
      if (!rawUpgraded) {
        const end = rawBuffer.indexOf('\r\n\r\n')
        if (end < 0) return
        rawBuffer = rawBuffer.subarray(end + 4)
        rawUpgraded = true
      }
      const { frames, rest } = decodeFrames(rawBuffer)
      rawBuffer = rest
      for (const f of frames) if (f.opcode === 0x8 && f.payload.length >= 2) rawCloseCode = f.payload.readUInt16BE(0)
    })
    raw.on('close', () => {
      rawClosed = true
    })
    raw.on('error', () => {})
    raw.write(['GET / HTTP/1.1', 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '\r\n'].join('\r\n'))
    await delay(250)
    raw.write(Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('hi')]))
    await delay(1400)
    record('an unmasked client frame is closed with code 1002', rawClosed && rawCloseCode === 1002, `closed=${rawClosed} code=${rawCloseCode}`)
    raw.destroy()

    client.socket.destroy()
    server.stop()
    record('stop() releases the port', server.status().running === false)
  }

  /* ---------------- password challenge ---------------- */
  {
    const { server } = makeServer({ password: 'hunter2' })
    const port = await boundPort(server)

    const good = await openClient(port, { password: 'hunter2', authString: obsAuthString })
    record(
      'Hello includes the auth challenge when a password is set',
      Boolean(good.hello?.d?.authentication?.salt && good.hello?.d?.authentication?.challenge),
      good.hello?.d?.authentication ? 'salt + challenge present' : 'no challenge'
    )
    await delay(200)
    record('correct password completes the handshake', good.client.messages.some((m) => m.op === 2))
    good.client.socket.destroy()

    const bad = await openClient(port, { password: 'wrong-password', authString: obsAuthString })
    await delay(500)
    record(
      'wrong password is rejected with close code 4009',
      !bad.client.messages.some((m) => m.op === 2) && bad.client.closed && bad.client.closeCode === 4009,
      `closed=${bad.client.closed} code=${bad.client.closeCode}`
    )
    bad.client.socket.destroy()
    server.stop()
  }
}
