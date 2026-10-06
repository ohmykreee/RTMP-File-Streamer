/**
 * Drives the built StreamEngine (out/main/index.js) inside a real Electron
 * process, without opening a window, so the full session lifecycle can be
 * exercised: prepare -> live -> auto-advance -> finish, with real ffmpeg
 * processes and real progress parsing.
 *
 * Run with:
 *   node_modules/electron/dist/electron.exe test/engine-run.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')

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
    note('FAIL', `missing ${bundlePath} — run \`node test/build-bundles.mjs\` first`)
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
    `file://${path.join(projectRoot, 'test', 'probe.bundle.mjs').replace(/\\/g, '/')}`
  )
  const clipA = path.join(testDir, 'clip_a.mp4')
  const clipB = path.join(testDir, 'clip_b.mp4')
  const clipC = path.join(testDir, 'clip_c.mp4')
  const clipD = path.join(testDir, 'clip_d.mp4')
  const infoA = await probeModule.probeMedia(FFPROBE, clipA)
  const infoB = await probeModule.probeMedia(FFPROBE, clipB)
  const infoC = await probeModule.probeMedia(FFPROBE, clipC)
  const infoD = await probeModule.probeMedia(FFPROBE, clipD)
  const subsA = probeModule.embeddedSubtitleRefs(infoA)
  const srtRef = await probeModule.probeSubtitleFile(FFPROBE, path.join(testDir, 'clip_a.srt'))
  note(
    'probed media',
    `A=${infoA.durationSec}s B=${infoB.durationSec}s C=${infoC.durationSec}s D=${infoD.durationSec}s, sidecar=${srtRef ? srtRef.codec : 'none'}`
  )

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

  /**
   * Starts one ingest listener and resolves once it is bound.
   *
   * A real streaming server is listening whenever a publisher arrives. Here the
   * listener is a process too, so a session that begins while it is still coming up
   * would simply fail to connect — which is what made the second session look like
   * a stalled publisher. Waiting for "Waiting for incoming connection" is not an
   * option (the probe would eat the listener's single accept), so the wait is for
   * the process to still be alive after a moment.
   */
  const startListener = async () => {
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
    await delay(600)
    if (proc.exitCode !== null) note(`ingest#${index}`, `listener exited early with code ${proc.exitCode}`)
  }

  const acceptConnections = () => {
    if (stopping) return
    void startListener()
  }

  await startListener()
  note('rtmp ingest listening', `rtmp://127.0.0.1:${LISTEN_PORT}/live/test`)

  /**
   * Waits until an ingest listener is up again, so a session that follows a closed
   * one does not race the listener and report a connection failure as its own.
   */
  const waitForListener = async () => {
    const start = Date.now()
    while (Date.now() - start < 20000) {
      const current = connections.at(-1)
      if (current && current.exitCode === null) return true
      await delay(200)
    }
    note('timeout', 'no ingest listener became ready')
    return false
  }

  const bufferedRequested = process.env.BUFFER_SEC !== undefined && Number(process.env.BUFFER_SEC) > 0

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
      italic: false
    },
    output: {
      server: `rtmp://127.0.0.1:${LISTEN_PORT}/live/`,
      streamKey: 'test',
      container: 'flv',
      extraOutputArgs: '',
      realtimePacing: true,
      /*
       * Which playout to run.
       *
       * `BUFFER_SEC` set  -> the buffered two-process playout (encoder flat out ahead
       *                      of a 1x pusher), with that delay;
       * `BUFFER_SEC` unset -> the single-process pipeline the `buffered` switch
       *                      turns off, which is the other half of what needs to keep
       *                      working.
       *
       * Both the switch AND the delay have to be right: the engine requires
       * `buffered === true` and a non-zero delay, so setting only one of them would
       * silently run the pipeline this run is not asserting about.
       */
      buffered: bufferedRequested,
      bufferSec: bufferedRequested ? Number(process.env.BUFFER_SEC) : 2,
      obsWebSocket: { enabled: false, host: '127.0.0.1', port: 4455, password: '' },
      loopPlaylist: false,
      reconnectDelaySec: 2,
      maxReconnectAttempts: 2,
      dropLateFrames: false
    }
  }

  /**
   * Which playout the engine is running. It changes the contract, not just the
   * numbers: the single-process pipeline republishes to RTMP once per file, while
   * the buffered one keeps ONE publish session alive across every encoder restart.
   */
  const buffered = bufferedRequested
  note(
    'playout mode',
    buffered
      ? `buffered two-process (BUFFER_SEC=${settings.output.bufferSec})`
      : 'single-process (buffered switch off)'
  )

  const mediaCache = new Map([
    [clipA, infoA],
    [clipB, infoB],
    [clipC, infoC],
    [clipD, infoD]
  ])

  const statuses = []
  const logs = []
  const playlistUpdates = []

  /*
   * Snapshots of one session's status stream, for the viewer-facing timeline checks.
   *
   * The engine emits on encoder progress as well as publisher progress, so the two
   * have to be told apart from the outside: a report that moves the viewer must be
   * consistent with what has been published, and an encoder starting the next file
   * must NOT move it.
   */
  let captureSession = null

  const engine = createStreamEngine({
    getFfmpegPath: () => FFMPEG,
    getSettings: () => settings,
    getMedia: (p) => mediaCache.get(p),
    probeMedia: async (p) => (p === clipA ? infoA : infoB),
    // The engine writes its log lines through the message table; the driver runs
    // without the settings store, so it names the language explicitly.
    getLanguage: () => 'zh'
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
    if (captureSession) {
      captureSession.samples.push({
        at: Date.now(),
        state: st.state,
        currentIndex: st.currentIndex,
        completedSec: st.completedSec,
        positionSec: st.positionSec,
        encodedSec: st.encodedSec ?? null,
        itemStatus: { ...st.itemStatus }
      })
    }
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
  captureSession = { label: 'phase 1', samples: [] }

  /*
   * Each phase gets its own airtime budget, because in buffered mode a phase lasts
   * as long as the material it airs (the pusher is paced at 1x) plus however far
   * the encoder ran ahead. A single shared cap let phase 2 start with the clock
   * already spent, which looked like a stalled publisher.
   */
  const PHASE_BUDGET_MS = Number(process.env.PHASE_BUDGET_MS ?? 120000)
  let phaseDeadline = Date.now() + PHASE_BUDGET_MS

  while (Date.now() < phaseDeadline) {
    tick()
    if (!engine.isActive()) break
    await delay(250)
  }

  const finalStatus = engine.getStatus()
  note('session ended', `state=${finalStatus.state}`)

  /* ---- phase two: skip to the next entry while live ---- *
   * In-file seeking was removed from the product (an RTMP push cannot be
   * scrubbed), so the phase exercises the operations that remain: skip, and the
   * position/progress reporting that goes with it.
   *
   * The middle entries are clip_c (12s) and clip_d (120s), neither of which is
   * clip_a. That matters because the encoder runs several times faster than the
   * viewer: a skip to the very next item is often a skip to a file the buffer
   * already holds, and clip_d is long enough that the encoder cannot possibly
   * finish it before the skip arrives. So "the target was reached and aired" is a
   * real observation here rather than a coincidence. */
  note('phase 2', 'skip while live, over two entries, to a file not yet encoded')
  const phaseOneSamples = captureSession ? captureSession.samples : []
  // Phase 1 is the run with no user intervention: whatever the viewer's timeline does
  // there came from the engine, not from a skip or a jump, so it must be continuous.
  captureSession = null
  const phaseTwoLogStart = logs.length
  const pushersBeforePhase2 = logs.filter((l) => l.message.includes('推流进程已启动')).length
  /**
   * How many RTMP sessions phase 1 should have used.
   *
   * The buffered playout keeps ONE publish session alive across every encoder
   * restart, which is the whole point of the design; the single-process pipeline
   * republishes per file. `receivedFiles` also has an entry per listener that never
   * got a connection, so only the ones with data are counted.
   */
  const sessionsInPhase1 = buffered ? 1 : 2
  // The previous session's ingest listener accepts exactly one connection and has
  // just closed; the replacement has to be up before this session publishes.
  await waitForListener()
  // Read AFTER the listener is up: `connections` grows when a listener starts, and
  // this index is what splits phase 1 from phase 2 in the recordings.
  const seekSessionIndex = connections.length - 1
  engine.setPlaylist([
    mkItem('a', clipA, infoA, srtRef, 'burn'),
    mkItem('c', clipC, infoC, null, 'off'),
    mkItem('d', clipD, infoD, null, 'off'),
    mkItem('b', clipB, infoB, null, 'off')
  ])
  await engine.start()
  await waitUntil(() => engine.getStatus().positionSec > 4, 20000, 'phase 2 first seconds')
  const beforeSkip = engine.getStatus()
  note('phase 2 pre-skip', `pos=${beforeSkip.positionSec.toFixed(1)}s index=${beforeSkip.currentIndex}`)

  // One jump, as the UI's "play this entry now" produces it. It abandons clip_c and
  // clip_d, so the run continues into clip_b.
  const posBefore = beforeSkip.positionSec
  const posKeepsProgress = beforeSkip.completedSec >= posBefore - 0.01 && posBefore > 0
  await engine.jumpToItem('b')
  await delay(900)
  const afterSkip = engine.getStatus()
  const skipToSecond = await waitUntil(() => engine.getStatus().currentIndex === 3, 25000, 'phase 2 reaching the last entry')
  note('phase 2 post-skip', `pos=${afterSkip.positionSec.toFixed(1)}s, completed=${afterSkip.completedSec.toFixed(1)}s, reached last entry=${skipToSecond}`)

  // Let the remaining entries finish so the session closes cleanly. Its own budget,
  // for the same reason as phase 1: this session airs the rest of the playlist.
  phaseDeadline = Date.now() + PHASE_BUDGET_MS
  while (Date.now() < phaseDeadline) {
    tick()
    if (!engine.isActive()) break
    await delay(250)
  }
  const phase2Status = engine.getStatus()
  note('phase 2 ended', `state=${phase2Status.state} after ${((Date.now() - sessionStart) / 1000).toFixed(1)}s total`)

  // Logs emitted before phase 2 belong to phase 1: attributing them here would make
  // one session's failure look like both sessions' failure.
  const phase2Start = phaseTwoLogStart
  const errorsPhase1 = logs.slice(0, phase2Start).filter((l) => l.level === 'error')
  const errorsPhase2 = logs.slice(phase2Start).filter((l) => l.level === 'error')

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
    buffered
      ? 'the buffered playout published the playlist over a single RTMP session'
      : 'each playlist entry opened its own publish session',
    buffered ? sizes.filter((s) => s > 50000).length >= 1 : sizes.filter((s) => s > 50000).length >= 2,
    `${sizes.filter((s) => s > 50000).length} sessions with data, sizes=${sizes.map((s) => (s / 1024).toFixed(0)).join(',')} KB`
  )
  record('ingest server received the stream', totalReceived > 200000, `${(totalReceived / 1024).toFixed(0)} KB total`)

  const errors = logs.filter((l) => l.level === 'error')
  record(
    'no error-level log entries',
    errors.length === 0,
    `${errorsPhase1.length} in session 1, ${errorsPhase2.length} in session 2` +
      (errors.length ? `: ${errors.map((e) => e.message).join(' | ').slice(0, 200)}` : '')
  )

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

  /*
   * The progress bar must report the PUBLISHER's position only.
   *
   * The engine also emits on encoder progress, and in buffered mode the encoder starts
   * the next file long before the pusher finishes the current one. Letting that move
   * the viewer's entry made the bar jump to the next file and snap back moments later
   * (measured: it read 20.0s of a 35s playlist for 327ms in the middle of file A).
   * Two properties rule that out, and both hold only for a run the user never
   * interrupted — phase 1.
   */
  const phase1 = phaseOneSamples.filter((s) => s.state === 'live' || s.state === 'draining')
  const viewerBackwards = []
  for (let i = 1; i < phase1.length; i += 1) {
    if (phase1[i].completedSec < phase1[i - 1].completedSec - 0.05) {
      viewerBackwards.push(`${phase1[i - 1].completedSec.toFixed(2)}→${phase1[i].completedSec.toFixed(2)}`)
    }
  }
  record(
    'the viewer timeline never moves backwards during a buffered file change',
    viewerBackwards.length === 0,
    viewerBackwards.length ? `backward at ${viewerBackwards.slice(0, 3).join(', ')}` : `checked ${phase1.length} live samples`
  )

  /*
   * A change of `currentIndex` may only follow a published position that actually
   * finished the entries before it. Checking the sample AFTER the change is not enough:
   * the bug set `currentIndex` and `completedSec` together (to the next entry's start),
   * so the new sample looked self-consistent. What gives it away is the sample BEFORE
   * it — the viewer was still mid-file there, and an entry cannot be current until its
   * predecessor has aired. Measured on the bug: `currentIndex` became 1 while the last
   * published total was 10.79s of the 20s clip_a, so the "next entry" was shown 9.2s
   * before it was earned. Phase 1 is the two-entry playlist [clip_a (20s), clip_b (15s)].
   */
  const phase1Durations = [infoA.durationSec, infoB.durationSec]
  const entryStartSec = phase1Durations.map((_, i) => phase1Durations.slice(0, i).reduce((a, b) => a + b, 0))
  const INDEX_TOLERANCE_SEC = 1.5
  const unearnedIndexMoves = []
  for (let i = 1; i < phase1.length; i += 1) {
    const prev = phase1[i - 1]
    const cur = phase1[i]
    if (cur.currentIndex <= prev.currentIndex || cur.currentIndex <= 0) continue
    const boundary = entryStartSec[cur.currentIndex] ?? 0
    // The viewer must have reached the end of everything before this entry.
    if (prev.completedSec < boundary - INDEX_TOLERANCE_SEC) {
      unearnedIndexMoves.push(
        `entry ${cur.currentIndex} shown while the published total was only ${prev.completedSec.toFixed(2)}s of ${boundary.toFixed(2)}s`
      )
    }
  }
  record(
    'the entry shown is only advanced by the published position',
    unearnedIndexMoves.length === 0 && sawIndex1,
    unearnedIndexMoves.length
      ? unearnedIndexMoves.join(', ')
      : `every entry change waited for the published total (checked ${phase1.length} samples)`
  )
  // And the same data proves the encoder really did run ahead in buffered mode, so the
  // checks above are about a gap that exists rather than an absent one.
  const maxLead = phase1.reduce((max, s) => Math.max(max, (s.encodedSec ?? s.completedSec) - s.completedSec), 0)
  record(
    buffered ? 'the encoder really did lead the publisher (so the checks above had a gap to catch)' : 'single-process pipeline reports no buffer lead',
    buffered ? maxLead > 2 : maxLead < 0.5,
    `max lead ${maxLead.toFixed(1)}s`
  )

  /* ---- decode each received session ---- */
  /**
   * The ingest writes FLV through a pipe, so it cannot seek back to fill in the
   * header: filesize and the `duration` in the onMetaData tag stay at whatever the
   * muxer guessed at the start (`-flvflags no_duration_filesize` leaves them at
   * zero). Probing the file as-is then reports a wrong duration and hides how much
   * really aired, so the header is patched in place first — the same repair any FLV
   * post-processor performs. Throws nothing: a file that cannot be parsed is left
   * exactly as it was, and the probe below will report it as undecodable.
   */
  /**
   * Last video timestamp in an FLV file, read from the tag list itself.
   *
   * Deliberately not delegated to ffprobe: this runs while the header is being
   * repaired, and it is the value the header needs.
   */
  const lastFlvVideoTimestampSec = (file) => {
    try {
      const size = fs.statSync(file).size
      const fd = fs.openSync(file, 'r')
      try {
        const head = Buffer.alloc(9)
        fs.readSync(fd, head, 0, 9, 0)
        if (head.toString('latin1', 0, 3) !== 'FLV') return null
        let offset = 9 + head.readUInt32BE(5)
        const tagHeader = Buffer.alloc(11)
        let last = null
        while (offset + 15 <= size) {
          if (fs.readSync(fd, tagHeader, 0, 11, offset) < 11) break
          const tagType = tagHeader[0]
          // FLV timestamps are 24-bit milliseconds plus an 8-bit extension.
          const timestamp = (tagHeader.readUIntBE(4, 3) | (tagHeader[7] << 24)) >>> 0
          const dataSize = tagHeader.readUIntBE(1, 3)
          if (tagType === 9) last = timestamp
          offset += 11 + dataSize + 4
        }
        return last === null ? null : last / 1000
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return null
    }
  }

  const patchFlvHeader = (file) => {
    let fd = null
    try {
      const size = fs.statSync(file).size
      if (size < 13) return
      fd = fs.openSync(file, 'r+')
      const head = Buffer.alloc(13)
      fs.readSync(fd, head, 0, 13, 0)
      if (head.toString('latin1', 0, 3) !== 'FLV') return
      // Bytes 5..8 are the DataOffset (where the first tag begins) and must not be
      // touched; the declared FILE size is the 4 bytes that follow, which are the
      // first tag's PreviousTagSize field.
      const fileSizeOffset = 9

      // Layout: 9-byte file header, then the first tag at 13 (its 4-byte
      // PreviousTagSize field sits at 9), then 11-byte tag header, then the body.
      const tagHeader = Buffer.alloc(11)
      fs.readSync(fd, tagHeader, 0, 11, 13)
      const dataSize = tagHeader.readUIntBE(1, 3)
      const dataStart = 13 + 11
      const data = Buffer.alloc(dataSize)
      fs.readSync(fd, data, 0, dataSize, dataStart)

      // AMF0: [0x02 len hi len lo 'onMetaData'][0x08 count hi count lo][key][0x00][double BE]
      if (data[0] !== 0x02) return
      const nameLen = data.readUInt16BE(1)
      if (data.toString('latin1', 3, 3 + nameLen) !== 'onMetaData') return
      let p = 3 + nameLen
      if (data[p] !== 0x08) return
      const count = data.readUInt32BE(p + 1)
      p += 5
      let durationOffset = -1
      for (let i = 0; i < count; i += 1) {
        const keyLen = data.readUInt16BE(p)
        const key = data.toString('latin1', p + 2, p + 2 + keyLen)
        p += 2 + keyLen
        const type = data[p]
        p += 1
        if (type === 0x00) {
          if (key === 'duration') durationOffset = p
          p += 8
        } else if (type === 0x02) {
          p += 2 + data.readUInt16BE(p)
        } else if (type === 0x01) {
          p += 2
        } else if (type === 0x0a) {
          p += 4
        } else if (type === 0x03) {
          p += 9
        } else if (type === 0x08 && data[p] !== undefined) {
          const n = data.readUInt32BE(p)
          p += 4 + n * 9
        } else {
          break
        }
      }

      let changed = false
      if (head.readUInt32BE(fileSizeOffset) !== size) {
        head.writeUInt32BE(size, fileSizeOffset)
        fs.writeSync(fd, head, 0, 13, 0)
        changed = true
      }
      // The muxer wrote the *starting* guess (0 with `no_duration_filesize`); the
      // real length is the last timestamp, and `-count_frames` would otherwise be
      // the only way to get at it. The offset is bounds-checked because writing a
      // double into the wrong byte would corrupt the file this probe then reads.
      if (durationOffset >= 0 && durationOffset + 8 <= dataSize) {
        const measured = lastFlvVideoTimestampSec(file)
        if (measured !== null && measured > 0) {
          data.writeDoubleBE(measured, durationOffset)
          changed = true
        }
      }
      if (changed) fs.writeSync(fd, data, 0, dataSize, dataStart)
    } catch {
      /* leave the file untouched */
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Resolution runs inside one received session, measured frame by frame.
   *
   * A single publish session can carry several playlist entries — that is the whole
   * point of the buffered playout — and the fixtures differ in resolution, which is
   * how the entries are told apart. It has to be decoded frames: FLV declares one
   * video stream and cannot describe a mid-stream format change, so a stream-level
   * probe reports the FIRST file's size for the entire session and hides the switch
   * completely (measured: a session holding 20s of 1280x720 then 15s of 854x480 was
   * reported as "1280x720" throughout).
   */
  const videoRuns = (file) => {
    const out = spawnSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=width,height,pts_time', '-of', 'json', file],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
    )
    let frames = []
    try {
      frames = JSON.parse(out.stdout || '{}').frames ?? []
    } catch {
      return []
    }
    const runs = []
    for (const f of frames) {
      const t = Number(f.pts_time)
      if (!Number.isFinite(t) || !f.width) continue
      const label = `${f.width}x${f.height}`
      const last = runs.at(-1)
      if (last && last.label === label) {
        last.end = t
        last.frames += 1
      } else {
        runs.push({ label, start: t, end: t, frames: 1 })
      }
    }
    return runs.map((r) => ({ ...r, spanSec: r.end - r.start }))
  }

  /**
   * What each second of a session actually shows: resolution and brightness.
   *
   * Resolution alone cannot identify the fixtures — clip_a and clip_c are both
   * 1280x720 — and a skip check needs to know which FILE is on screen. Every second
   * is decoded once, and the two together are decisive: clip_c is a blank dark clip
   * (mean ≈ 20) while clip_a and clip_b are bright colour bars (mean ≈ 130).
   *
   * One pass of ffprobe gives the per-frame resolution, one pass of ffmpeg gives the
   * per-second brightness, and frames are bucketed into seconds so the two align.
   */
  const contentTimeline = (file) => {
    const probed = spawnSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=width,height,pts_time', '-of', 'json', file],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
    )
    let frames = []
    try {
      frames = JSON.parse(probed.stdout || '{}').frames ?? []
    } catch {
      return []
    }
    const gray = spawnSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'fps=1,scale=16:9,format=gray', '-f', 'rawvideo', '-'],
      { maxBuffer: 256 * 1024 * 1024 }
    )
    const per = 16 * 9
    const grayBuf = gray.status === 0 && gray.stdout ? gray.stdout : Buffer.alloc(0)

    // Resolution per whole second, taken from the frames that fall inside it, plus
    // the true first/last timestamp of each second. The bucket says WHICH clip a
    // second belongs to; the timestamps say how long it really ran, which the
    // one-second bucket width cannot express on its own.
    const bySecond = new Map()
    for (const f of frames) {
      const t = Number(f.pts_time)
      if (!Number.isFinite(t) || !f.width) continue
      const sec = Math.floor(t)
      const entry = bySecond.get(sec)
      if (!entry) bySecond.set(sec, { label: `${f.width}x${f.height}`, first: t, last: t })
      else {
        entry.last = Math.max(entry.last, t)
        entry.first = Math.min(entry.first, t)
      }
    }

    const seconds = Math.max(bySecond.size, Math.floor(grayBuf.length / per))
    const samples = []
    for (let i = 0; i < seconds; i += 1) {
      const entry = bySecond.get(i)
      if (!entry) continue
      let mean = null
      if ((i + 1) * per <= grayBuf.length) {
        let sum = 0
        for (let k = 0; k < per; k += 1) sum += grayBuf[i * per + k]
        mean = sum / per
      }
      samples.push({
        t: i,
        label: entry.label,
        first: entry.first,
        last: entry.last,
        bright: mean === null ? null : mean >= 60,
        mean: mean === null ? null : Math.round(mean)
      })
    }

    const runs = []
    for (const s of samples) {
      const last = runs.at(-1)
      const key = `${s.label}|${s.bright}`
      if (last && last.key === key) {
        last.end = s.t
        last.last = Math.max(last.last, s.last)
        last.seconds += 1
      } else {
        runs.push({ key, label: s.label, bright: s.bright, start: s.t, end: s.t, first: s.first, last: s.last, seconds: 1 })
      }
    }
    // `spanSec` uses frame timestamps, so it is the real airtime of the run rather
    // than a count of buckets.
    return runs.map((r) => ({ ...r, spanSec: r.last - r.first }))
  }

  const sessionInfo = []
  const skippedSessions = []
  for (const [i, file] of receivedFiles.entries()) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (size < 50000) {
      skippedSessions.push(`#${i} ${(size / 1024).toFixed(0)}KB`)
      continue
    }
    patchFlvHeader(file)
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
      const contentSec = fps ? Number(vs.nb_read_frames) / fps : NaN
      const durationSec = Number(parsed.format?.duration)
      sessionInfo.push({
        index: i,
        file,
        codec: vs.codec_name,
        width: vs.width,
        height: vs.height,
        // The container duration is the authority on airtime (it comes from the
        // patched header); the frame count is only a fallback.
        contentSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : contentSec,
        measuredByFramesSec: contentSec,
        runs: videoRuns(file),
        content: contentTimeline(file),
        size: fs.statSync(file).size
      })
    } catch (err) {
      // Never silence this: a session that cannot be probed is the difference
      // between "the stream was wrong" and "the check was wrong", and those need
      // to be told apart from the log alone.
      note(`ingest#${i}`, `probe failed: ${String(err).slice(0, 160)}`)
    }
  }
  if (skippedSessions.length > 0) note('ingest', `sessions below the size floor, not probed: ${skippedSessions.join(', ')}`)

  /** "WxH" of each fixture, so what arrived can be matched to what was queued. */
  const labelA = `${infoA.videoStreams[0].width}x${infoA.videoStreams[0].height}`
  const labelB = `${infoB.videoStreams[0].width}x${infoB.videoStreams[0].height}`
  const labelC = `${infoC.videoStreams[0].width}x${infoC.videoStreams[0].height}`
  const labelD = `${infoD.videoStreams[0].width}x${infoD.videoStreams[0].height}`

  record(
    'received sessions are decodable video',
    sessionInfo.length >= 1 && sessionInfo.every((s) => s.codec === 'h264'),
    sessionInfo
      .map((s) => `#${s.index}:${s.codec} ${s.contentSec.toFixed(1)}s [${s.runs.map((r) => r.label).join(',')}]`)
      .join(' | ') || 'nothing decodable'
  )
  const first = sessionInfo.find((s) => s.index === 0)
  const second = sessionInfo.find((s) => s.index === 1)
  /**
   * Phase 1's recordings end where phase 2's listener starts. `seekSessionIndex` is
   * the index of the listener opened for phase 2, so everything before it belongs to
   * the first session.
   */
  const phaseOneSessions = sessionInfo.filter((s) => s.index < seekSessionIndex)

  if (!buffered) {
    record(
      'first received session covers the full first file',
      Boolean(first) && Math.abs(first.contentSec - infoA.durationSec) < 2.5,
      first ? `${first.contentSec.toFixed(1)}s vs ${infoA.durationSec}s` : 'missing'
    )
    record(
      'second received session covers the full second file',
      Boolean(second) && Math.abs(second.contentSec - infoB.durationSec) < 2.5,
      second ? `${second.contentSec.toFixed(1)}s vs ${infoB.durationSec}s` : 'missing'
    )
  } else {
    /*
     * Buffered mode inverts the session model, so the checks have to be inverted
     * with it: ONE publish session is supposed to carry the WHOLE playlist while
     * the encoder restarts behind it. That is the property the two-process design
     * exists for — a new publish for the second file would restart the RTMP
     * timeline and make every viewer re-buffer.
     */
    const sessionA = first
    const runsA = sessionA?.runs ?? []
    const runA = runsA.find((r) => r.label === labelA)
    const runB = runsA.find((r) => r.label === labelB)
    record(
      'one publish session carried the whole playlist',
      phaseOneSessions.length === sessionsInPhase1,
      `${phaseOneSessions.length} session(s) with data in phase 1 (expected ${sessionsInPhase1}): ${phaseOneSessions.map((s) => `#${s.index} ${(s.size / 1024).toFixed(0)}KB`).join(', ')}`
    )
    record(
      'the single session contains both files, in order',
      Boolean(runA) && Boolean(runB) && runB.start > runA.start,
      runsA.map((s) => `${s.label} ${s.spanSec.toFixed(1)}s @${s.start.toFixed(1)}`).join(' → ') || 'no resolution runs found'
    )
    record(
      'the first file aired in full inside that session',
      Boolean(runA) && Math.abs(runA.spanSec - infoA.durationSec) < 2.5,
      runA ? `${runA.spanSec.toFixed(1)}s vs ${infoA.durationSec}s` : 'missing'
    )
    record(
      'the second file aired in full inside that session',
      Boolean(runB) && Math.abs(runB.spanSec - infoB.durationSec) < 2.5,
      runB ? `${runB.spanSec.toFixed(1)}s vs ${infoB.durationSec}s` : 'missing'
    )
    record(
      'the session aired the whole playlist, not just the first file',
      Boolean(sessionA) && sessionA.contentSec >= infoA.durationSec + infoB.durationSec - 3,
      sessionA ? `${sessionA.contentSec.toFixed(1)}s vs ${(infoA.durationSec + infoB.durationSec).toFixed(1)}s` : 'missing'
    )
  }

  /* ---- phase 2 assertions: skip while live, position stays consistent ---- */
  record(
    'phase 2 left the skipped entries behind and finished the target',
    /*
     * The abandoned entries must not be `live`/`pending` — that would mean the queue
     * stopped tracking them. `skipped` is the normal outcome; `done` is also correct
     * when the encoder had already finished an entry before the jump arrived, and in
     * buffered mode the whole of clip_a can be encoded before the viewer is 5s in.
     */
    ['skipped', 'done'].includes(phase2Status.itemStatus.a) &&
      ['skipped', 'done'].includes(phase2Status.itemStatus.c) &&
      ['skipped', 'done'].includes(phase2Status.itemStatus.d) &&
      phase2Status.itemStatus.b === 'done',
    JSON.stringify(phase2Status.itemStatus)
  )
  record('phase 2 reached the last entry after the skips', skipToSecond)
  record(
    'position and session total stay consistent while live',
    posKeepsProgress,
    `pos=${beforeSkip.positionSec.toFixed(2)}s completed=${beforeSkip.completedSec.toFixed(2)}s`
  )

  const phaseTwoSessions = sessionInfo.filter((s) => s.index >= seekSessionIndex)
  /*
   * A jump discards the buffer and reopens the RTMP session at the requested file
   * (see `Playout.restartSession`), so the file the viewer asked for is expected to
   * be the FIRST thing in the new session — not buried behind buffered content.
   * Entries are identified by what the picture is: clip_a and clip_c share a
   * resolution, so brightness tells them apart (clip_c is blank, clip_a is bars).
   */
  const phaseTwoContent = phaseTwoSessions.flatMap((s) => s.content)
  const phaseTwoTotal = phaseTwoSessions.reduce((sum, s) => sum + s.contentSec, 0)
  const describe = (runs) =>
    runs.map((r) => `${r.label}${r.bright === false ? '(blank)' : ''} ${r.spanSec.toFixed(1)}s @${r.start}`).join(' → ')
  const isB = (r) => r.label === labelB
  const isABars = (r) => r.label === labelA && r.bright !== false
  const isCBlank = (r) => r.label === labelA && r.bright === false
  const isD = (r) => r.label === labelD
  const sumOf = (pred) => phaseTwoContent.filter(pred).reduce((sum, r) => sum + r.spanSec, 0)
  /**
   * How much of an abandoned file is allowed to survive a jump.
   *
   * Only what was already in the OS pipe when the encoder was killed — a few frames.
   * It cannot be zero, and it must not be seconds: the whole point of restarting the
   * session is that the buffered backlog is dropped, and that backlog is what used to
   * make a skip a no-op.
   */
  const PIPE_RESIDUE_SEC = 0.5
  const bSpanTotal = sumOf(isB)
  const aBarsTotal = sumOf(isABars)
  const cBlankTotal = sumOf(isCBlank)
  const dTotal = sumOf(isD)
  const bRuns = phaseTwoContent.filter(isB)
  const firstBRun = bRuns[0]
  const lastBRun = bRuns.at(-1)
  /** True when the LAST content run of the session is material from the target. */
  const lastRunIsB = phaseTwoContent.length > 0 && isB(phaseTwoContent.at(-1))

  record(
    'the target streamed in full, and alone, in the new session',
    /*
     * The skipped-over fixtures must be GONE — the buffer was discarded — and the
     * target must arrive whole.
     *
     * "Gone" is a fraction of a second rather than exactly zero, and deliberately so:
     * the bytes already inside the OS pipe when the jump lands cannot be pulled back,
     * so a few frames of the abandoned file are expected. What must not survive is the
     * buffered backlog — seconds or minutes of it — which is what the old behaviour
     * produced and what makes a skip meaningless.
     */
    dTotal <= PIPE_RESIDUE_SEC &&
      cBlankTotal <= PIPE_RESIDUE_SEC &&
      Boolean(firstBRun) &&
      firstBRun.start <= 3 &&
      bSpanTotal >= infoB.durationSec - 2.5,
    `${labelD} ${dTotal.toFixed(2)}s, ${labelA}(blank) ${cBlankTotal.toFixed(2)}s, first ${labelB} run at ${firstBRun?.start ?? '-'}s, ${labelB} total ${bSpanTotal.toFixed(1)}s of ${infoB.durationSec}s; runs: ${describe(phaseTwoContent) || 'none'}`
  )
  note(
    'phase 2 measurement',
    `dTotal=${dTotal} cBlankTotal=${cBlankTotal} bSpanTotal=${bSpanTotal} firstBRun=${JSON.stringify(firstBRun)} limit=${PIPE_RESIDUE_SEC}`
  )
  record(
    'phase 2 never aired more of a fixture than the fixture holds',
    aBarsTotal <= infoA.durationSec + 2.5 && cBlankTotal <= infoC.durationSec + 2.5,
    `A(bars) ${aBarsTotal.toFixed(1)}s of ${infoA.durationSec}s, C(blank) ${cBlankTotal.toFixed(1)}s of ${infoC.durationSec}s`
  )
  record(
    'the session ended on the target, not on the skipped-over fixtures',
    lastRunIsB,
    `runs end with ${phaseTwoContent.at(-1)?.label ?? 'nothing'}${phaseTwoContent.at(-1)?.bright === false ? '(blank)' : ''} (lastRunIsB=${lastRunIsB}); ${describe(phaseTwoContent)}`
  )
  record(
    'phase 2 total streamed material stays within the queue it was given',
    phaseTwoTotal >= infoB.durationSec - 2.5 &&
      phaseTwoTotal <= infoA.durationSec + infoC.durationSec + infoD.durationSec + infoB.durationSec + 2.5,
    `${phaseTwoTotal.toFixed(1)}s (at most A ${infoA.durationSec}s + C ${infoC.durationSec}s + D ${infoD.durationSec}s + B ${infoB.durationSec}s)`
  )
  record('phase 2 left the engine idle', phase2Status.state === 'idle', phase2Status.state)

  /*
   * The UI keys log rows by `entry.id`. Engine entries carry their own counter
   * while the main process uses another one for app messages, so the two streams
   * must not be handed to React as-is: colliding keys make rows disappear and
   * make level filtering look like it only covers part of the log. The renderer
   * re-keys every entry, and this check proves the source really does collide
   * (so the re-keying stays justified rather than accidental).
   */
  const ids = logs.map((l) => l.id)
  const duplicates = ids.length - new Set(ids).size
  note('engine log ids', `${ids.length} entries, id range ${Math.min(...ids)}..${Math.max(...ids)}, duplicates=${duplicates}`)
  record('this engine run emitted unique log ids', duplicates === 0, `${ids.length} entries, ${duplicates} duplicate id(s)`)

  /*
   * The buffered playout runs two processes on purpose: the pusher owns the RTMP
   * session and must OUTLIVE every encoder restart (one per file, per seek, per
   * skip). This reports the actual counts so that claim is observable instead of
   * assumed: many encoder starts against a single pusher start.
   */
  const pusherStarts = logs.filter((l) => l.message.includes('推流进程已启动')).length
  const encoderStarts = logs.filter((l) => l.message.includes('编码进程已启动')).length
  note('playout processes', `pusher starts=${pusherStarts}, encoder starts=${encoderStarts}`)

  /*
   * "One publisher, many encoders" is the shape the two-process design exists for,
   * so it is asserted rather than only reported. Both phases are counted, and each
   * phase may start at most one pusher: a second start inside a single phase is a
   * republish, which resets the RTMP timeline and re-buffers every viewer.
   */
  record(
    buffered ? 'the playout restarted its publisher exactly when the queue was jumped' : 'the playout reported its processes',
    buffered
      ? // Session 1: one publisher for the whole playlist (the encoder restarts
        // behind it). Session 2: the jump discards the buffer, so it opens the
        // session, then opens a SECOND one at the jumped-to file. Anything else
        // means either a republish that was not asked for, or a jump that did not
        // actually restart (which would make the jump a no-op).
        pushersBeforePhase2 === 1 && pusherStarts - pushersBeforePhase2 === 2 && encoderStarts >= 4
      : pusherStarts === 0 && encoderStarts === 0,
    buffered
      ? `session 1: ${pushersBeforePhase2} publisher start; session 2: ${pusherStarts - pushersBeforePhase2} (1 to open + 1 for the jump); ${encoderStarts} encoder start(s) total`
      : `single-process pipeline: no playout processes, as expected`
  )

  const passed = results.filter((r) => r.ok).length
  note('summary', `${passed}/${results.length} checks passed`)

  fs.writeFileSync(
    path.join(testDir, 'engine-run-report.json'),
    JSON.stringify({ results, playout: { pusherStarts, encoderStarts }, logs: logs.slice(-60), timeline }, null, 2)
  )
  // The whole engine log, so a failing run can be diagnosed without re-running it.
  // The report above keeps only the tail to stay readable.
  fs.writeFileSync(
    path.join(testDir, 'engine-run-log.txt'),
    logs.map((l) => `${String(l.id).padStart(5)} ${l.level.padEnd(6)} ${l.message}`).join('\n')
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
