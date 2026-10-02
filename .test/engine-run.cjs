/**
 * Drives the built StreamEngine (out/main/index.js) inside a real Electron
 * process, without opening a window, so the full session lifecycle can be
 * exercised: prepare -> live -> auto-advance -> finish, with real ffmpeg
 * processes and real progress parsing.
 *
 * Run with:
 *   node_modules/electron/dist/electron.exe .test/engine-run.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const testDir = __dirname

let app
try {
  ;({ app } = require('electron'))
} catch (err) {
  console.error('This script must run under Electron:', err)
  process.exit(2)
}

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe'
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 13935)
const RECEIVED = path.join(testDir, 'session_received.flv')

const timeline = []
function note(step, detail) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${step}${detail ? ` — ${detail}` : ''}`
  timeline.push(line)
  console.log(line)
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  note('bootstrap', `electron ${process.versions.electron}, node ${process.versions.node}`)

  // The application bundle self-boots when required; make that observable so a
  // regression in that wiring cannot silently pass this test.
  const bundlePath = path.join(projectRoot, 'out', 'main', 'test-entry.cjs')
  if (!fs.existsSync(bundlePath)) {
    note('FAIL', `missing ${bundlePath} — run \`node .test/build-bundles.mjs\` first`)
    app.exit(1)
    return
  }

  const mod = require(bundlePath)
  const createStreamEngine = (...args) => new mod.StreamEngine(...args)
  const buildStreamCommand = mod.buildStreamCommand
  if (typeof createStreamEngine !== 'function' || typeof buildStreamCommand !== 'function') {
    note('FAIL', 'test-entry.cjs does not export StreamEngine / buildStreamCommand')
    app.exit(1)
    return
  }
  note('bundle loaded', `exports: ${Object.keys(mod).join(', ')}`)

  /* ---- probe the test media through the real probe path ---- */
  const probeModule = await import(
    `file://${path.join(projectRoot, '.test', 'probe.bundle.mjs').replace(/\\/g, '/')}`
  )
  const clipA = path.join(testDir, 'clip_a.mp4')
  const clipB = path.join(testDir, 'clip_b.mp4')
  const infoA = await probeModule.probeMedia(FFPROBE, clipA)
  const infoB = await probeModule.probeMedia(FFPROBE, clipB)
  const subsA = probeModule.embeddedSubtitleRefs(infoA)
  const srtRef = await probeModule.probeSubtitleFile(FFPROBE, path.join(testDir, 'clip_a.srt'))
  note('probed media', `A=${infoA.durationSec}s B=${infoB.durationSec}s, sidecar=${srtRef ? srtRef.codec : 'none'}`)

  /* ---- ffmpeg processes play the role of the RTMP ingest server ----
   * A real streaming server accepts one publish session at a time and can be
   * re-connected to, so each connection gets its own ffmpeg listener process and
   * its own output file. That mirrors how nginx-rtmp/SRS behave across the
   * per-file and per-seek republishes the engine performs. */
  const connections = []
  const receivedFiles = []
  let listener = null
  let listenerLog = ''
  let stopping = false

  const acceptConnections = () => {
    if (stopping) return
    const index = connections.length
    const file = path.join(testDir, `session_recv_${index}.flv`)
    fs.rmSync(file, { force: true })
    receivedFiles.push(file)

    const proc = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-listen',
        '1',
        '-f',
        'flv',
        '-i',
        `rtmp://127.0.0.1:${LISTEN_PORT}/live/test`,
        '-c',
        'copy',
        '-f',
        'flv',
        '-y',
        file
      ],
      { windowsHide: true }
    )
    let log = ''
    proc.stderr.on('data', (d) => {
      log += d.toString()
      listenerLog += d.toString()
    })
    proc.on('close', () => {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      log.trim() &&
        log
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .slice(0, 3)
          .forEach((l) => note(`ingest#${index}`, l.trim().slice(0, 120)))
      note(`ingest#${index} closed`, `${(size / 1024).toFixed(0)} KB`)
      if (!stopping) setTimeout(acceptConnections, 150)
    })
    proc.on('error', () => {})
    connections.push(proc)
    listener = proc
  }

  acceptConnections()
  await delay(1500)
  note('rtmp ingest listening', `rtmp://127.0.0.1:${LISTEN_PORT}/live/test`)

  /* ---- engine wiring ---- */
  let settings = {
    video: {
      codec: 'h264',
      encoder: 'auto',
      rateControl: 'cbr',
      bitrateKbps: 2000,
      maxBitrateKbps: 2000,
      bufferSizeKbps: 4000,
      crf: 23,
      preset: 'ultrafast',
      tune: 'zerolatency',
      profile: '',
      keyframeIntervalSec: 2,
      bFrames: 0,
      scale: '',
      fps: 0,
      pixelFormat: 'yuv420p',
      repeatHeaders: true
    },
    audio: { codec: 'aac', rateControl: 'cbr', bitrateKbps: 128, sampleRate: 44100, channels: 2, loudnorm: false },
    subtitles: {
      mode: 'burn',
      styleMode: 'force',
      fontName: 'Microsoft YaHei',
      fontSize: 26,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      outlineWidth: 2,
      shadow: 0,
      marginVertical: 24,
      alignment: 2,
      bold: false,
      italic: false,
      allowTranscodeCopy: false
    },
    output: {
      server: `rtmp://127.0.0.1:${LISTEN_PORT}/live/`,
      streamKey: 'test',
      container: 'flv',
      extraOutputArgs: '',
      realtimePacing: true,
      loopPlaylist: false,
      reconnectDelaySec: 2,
      maxReconnectAttempts: 2,
      seekAccuracy: 'fast',
      dropLateFrames: false
    }
  }

  const mediaCache = new Map([
    [clipA, infoA],
    [clipB, infoB]
  ])

  const statuses = []
  const logs = []
  const playlistUpdates = []

  const engine = createStreamEngine({
    getFfmpegPath: () => FFMPEG,
    getSettings: () => settings,
    getMedia: (p) => mediaCache.get(p),
    probeMedia: async (p) => (p === clipA ? infoA : infoB)
  })

  engine.setSink({
    status: (s) => statuses.push({ ...s, at: Date.now() }),
    log: (e) => logs.push(e),
    playlist: (items) => playlistUpdates.push(items.map((i) => ({ name: i.name, status: i.status })))
  })

  const mkItem = (id, file, info, subtitle, mode) => ({
    id,
    path: file,
    name: path.basename(file),
    size: info.size,
    durationSec: info.durationSec,
    subtitleTracks: subtitle ? [...subsA, subtitle] : [],
    selectedSubtitleId: subtitle ? subtitle.id : null,
    mode,
    syncOffsetSec: 0,
    subtitleDelaySec: 0,
    status: 'pending'
  })

  // Two entries: with burn-in subtitles, then without. The engine must advance on its own.
  engine.setPlaylist([
    mkItem('a', clipA, infoA, srtRef, 'burn'),
    mkItem('b', clipB, infoB, null, 'off')
  ])
  note('playlist set', 'clip_a (subtitles burned) then clip_b')

  /* ---- run the session ---- */
  const sessionStart = Date.now()
  let sawLive = false
  let sawIndex1 = false
  let lastLoggedPosition = -1

  const waitUntil = async (predicate, timeoutMs, label) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true
      await delay(150)
    }
    note('timeout', `${label} not reached within ${timeoutMs}ms`)
    return false
  }

  const tick = () => {
    const st = engine.getStatus()
    if (st.state === 'live') sawLive = true
    if (st.currentIndex === 1) sawIndex1 = true
    const pos = Math.floor(st.positionSec)
    if (pos !== lastLoggedPosition && pos > 0 && pos % 5 === 0) {
      lastLoggedPosition = pos
      note(
        `progress #${st.currentIndex + 1}`,
        `pos=${st.positionSec.toFixed(1)}s/${st.currentDurationSec.toFixed(1)}s overall=${st.completedSec.toFixed(1)}s speed=${st.speed.toFixed(2)}x fps=${st.fps.toFixed(1)} bitrate=${st.bitrateKbps.toFixed(0)}kbps`
      )
    }
  }

  await engine.start()
  note('engine.start() returned', `state=${engine.getStatus().state}`)

  while (Date.now() - sessionStart < 70000) {
    tick()
    if (!engine.isActive()) break
    await delay(250)
  }

  const finalStatus = engine.getStatus()
  note('session ended', `state=${finalStatus.state}`)

  /* ---- phase two: seek inside a file, then skip to the next entry ---- */
  note('phase 2', 'seek to 12s mid-file, then skip to the next entry')
  const seekSessionIndex = connections.length
  engine.setPlaylist([
    mkItem('a', clipA, infoA, srtRef, 'burn'),
    mkItem('b', clipB, infoB, null, 'off')
  ])
  await engine.start()
  await waitUntil(() => engine.getStatus().positionSec > 4, 20000, 'phase 2 first seconds')
  const beforeSeek = engine.getStatus()
  note('phase 2 pre-seek', `pos=${beforeSeek.positionSec.toFixed(1)}s index=${beforeSeek.currentIndex}`)

  await engine.seek(12)
  await delay(900)
  const afterSeek = engine.getStatus()
  const seekToSecond = await waitUntil(() => engine.getStatus().currentIndex === 1, 25000, 'phase 2 reaching entry 2')
  note('phase 2 post-seek', `pos=${afterSeek.positionSec.toFixed(1)}s, reached entry 2=${seekToSecond}`)

  // Let the second entry finish so the session closes cleanly.
  await waitUntil(() => !engine.isActive(), 40000, 'phase 2 completion')
  const phase2Status = engine.getStatus()
  note('phase 2 ended', `state=${phase2Status.state}`)

  /* ---- verify ---- */
  await delay(1200)
  stopping = true
  for (const c of connections) c.kill('SIGKILL')
  await delay(900)

  const sizes = receivedFiles.map((f) => (fs.existsSync(f) ? fs.statSync(f).size : 0))
  const totalReceived = sizes.reduce((a, b) => a + b, 0)
  const results = []
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail })
    note(ok ? 'PASS' : 'FAIL', `${name}${detail ? ` — ${detail}` : ''}`)
  }

  record('engine reached the live state', sawLive)
  record('engine advanced to the second playlist entry automatically', sawIndex1)
  record('engine returned to idle at the end of the playlist', finalStatus.state === 'idle', finalStatus.state)
  record(
    'both entries marked done',
    finalStatus.itemStatus.a === 'done' && finalStatus.itemStatus.b === 'done',
    JSON.stringify(finalStatus.itemStatus)
  )
  record(
    'aggregate progress covered both files',
    Math.abs(finalStatus.completedSec - (infoA.durationSec + infoB.durationSec)) < 4,
    `${finalStatus.completedSec.toFixed(1)}s of ${(infoA.durationSec + infoB.durationSec).toFixed(1)}s`
  )
  record(
    'each playlist entry opened its own publish session',
    sizes.filter((s) => s > 50000).length >= 2,
    `${sizes.filter((s) => s > 50000).length} sessions with data, sizes=${sizes.map((s) => (s / 1024).toFixed(0)).join(',')} KB`
  )
  record('ingest server received the stream', totalReceived > 200000, `${(totalReceived / 1024).toFixed(0)} KB total`)

  const errors = logs.filter((l) => l.level === 'error')
  record('no error-level log entries', errors.length === 0, errors.map((e) => e.message).join(' | ').slice(0, 200) || 'none')

  const progressSamples = statuses.filter((s) => s.positionSec > 0)
  const monotonicPerItem = (() => {
    const last = new Map()
    for (const s of statuses) {
      if (s.currentIndex < 0) continue
      const prev = last.get(s.currentIndex)
      if (prev !== undefined && s.positionSec + 0.01 < prev && s.positionSec > 1) return false
      last.set(s.currentIndex, s.positionSec)
    }
    return true
  })()
  record('status stream produced progress updates', progressSamples.length > 10, `${progressSamples.length} samples`)
  record('reported position never went backwards within a file', monotonicPerItem)

  /* ---- decode each received session ---- */
  const sessionInfo = []
  for (const [i, file] of receivedFiles.entries()) {
    if (!fs.existsSync(file) || fs.statSync(file).size < 50000) continue
    const probeOut = await new Promise((resolve) => {
      const p = spawn(
        FFPROBE,
        ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration', '-print_format', 'json', file],
        { windowsHide: true }
      )
      let o = ''
      p.stdout.on('data', (d) => (o += d.toString()))
      p.on('close', () => resolve(o))
      p.on('error', () => resolve(''))
    })
    try {
      const parsed = JSON.parse(probeOut || '{}')
      const vs = parsed.streams?.[0] ?? {}
      const [n, d] = String(vs.avg_frame_rate ?? '0/0').split('/').map(Number)
      const fps = n && d ? n / d : 0
      sessionInfo.push({
        index: i,
        file,
        codec: vs.codec_name,
        width: vs.width,
        height: vs.height,
        contentSec: fps ? Number(vs.nb_read_frames) / fps : NaN,
        size: fs.statSync(file).size
      })
    } catch {
      /* ignore undecodable session */
    }
  }

  record(
    'received sessions are decodable video',
    sessionInfo.length >= 2 && sessionInfo.every((s) => s.codec === 'h264'),
    sessionInfo.map((s) => `#${s.index}:${s.codec} ${s.width}x${s.height} ${s.contentSec.toFixed(1)}s`).join(' | ')
  )
  const first = sessionInfo.find((s) => s.index === 0)
  record(
    'first received session covers the full first file',
    Boolean(first) && Math.abs(first.contentSec - infoA.durationSec) < 2.5,
    first ? `${first.contentSec.toFixed(1)}s vs ${infoA.durationSec}s` : 'missing'
  )
  const second = sessionInfo.find((s) => s.index === 1)
  record(
    'second received session covers the full second file',
    Boolean(second) && Math.abs(second.contentSec - infoB.durationSec) < 2.5,
    second ? `${second.contentSec.toFixed(1)}s vs ${infoB.durationSec}s` : 'missing'
  )

  /* ---- phase 2 assertions: seek restarts the publisher at the new position ---- */
  record(
    'phase 2 performed an in-file seek without error',
    phase2Status.itemStatus.a === 'done' && phase2Status.itemStatus.b === 'done',
    JSON.stringify(phase2Status.itemStatus)
  )
  record('phase 2 reached the second entry after the seek', seekToSecond)

  // The seek republished the tail of clip_a, so pick the session that carries
  // clip_a's resolution but only part of its material, rather than guessing indices.
  const phaseTwoSessions = sessionInfo.filter((s) => s.index >= seekSessionIndex)
  const seekSession = phaseTwoSessions.find(
    (s) => s.width === infoA.videoStreams[0].width && s.contentSec < infoA.durationSec - 5
  )
  const fullFirstAgain = phaseTwoSessions.find(
    (s) => s.width === infoA.videoStreams[0].width && Math.abs(s.contentSec - infoA.durationSec) < 2.5
  )
  const skipSession = phaseTwoSessions.find(
    (s) => s.width === infoB.videoStreams[0].width && Math.abs(s.contentSec - infoB.durationSec) < 2.5
  )
  const phaseTwoTotal = phaseTwoSessions.reduce((sum, s) => sum + s.contentSec, 0)

  record(
    'seek republished only the remaining material',
    Boolean(seekSession) && !fullFirstAgain,
    seekSession
      ? `${seekSession.contentSec.toFixed(1)}s streamed after seeking to 12s (≈${(infoA.durationSec - 12).toFixed(0)}s expected)`
      : `sessions: ${phaseTwoSessions.map((s) => `${s.width}x${s.height}/${s.contentSec.toFixed(1)}s`).join(', ')}`
  )
  record(
    'the skip target streamed in full afterwards',
    Boolean(skipSession),
    skipSession ? `${skipSession.contentSec.toFixed(1)}s vs ${infoB.durationSec}s` : 'no matching session'
  )
  record(
    'phase 2 total streamed material matches (12s → end of A) + full B',
    Math.abs(phaseTwoTotal - ((infoA.durationSec - 12) + infoB.durationSec)) < 2.5,
    `${phaseTwoTotal.toFixed(1)}s vs ${((infoA.durationSec - 12) + infoB.durationSec).toFixed(1)}s expected`
  )
  record('phase 2 left the engine idle', phase2Status.state === 'idle', phase2Status.state)

  const passed = results.filter((r) => r.ok).length
  note('summary', `${passed}/${results.length} checks passed`)

  fs.writeFileSync(
    path.join(testDir, 'engine-run-report.json'),
    JSON.stringify({ results, logs: logs.slice(-60), timeline }, null, 2)
  )
  console.log('\n--- engine log tail ---')
  for (const l of logs.slice(-30)) console.log(`  ${l.level.padEnd(6)} ${l.message}`)

  app.exit(results.every((r) => r.ok) ? 0 : 1)
}

app.disableHardwareAcceleration()
app.whenReady().then(() =>
  main().catch((err) => {
    console.error('integration run failed:', err)
    app.exit(1)
  })
)
