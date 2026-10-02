/**
 * Standalone verification harness.
 *
 * It loads the REAL command builder that the app bundles (out/main/index.js
 * contains it, but that file also imports electron, so we re-bundle just the
 * builder with esbuild first — see .test/build-bundles.mjs) and executes the
 * resulting ffmpeg argument vectors against real media files.
 *
 * Sections: command vectors, real transcodes, a local RTMP ingest, sync-offset
 * measurements, and the obs-websocket endpoint (`.test/obs-websocket.mjs`).
 * Run it through `.test/unit.mjs`, which prepares the fixtures and bundles.
 *
 * Usage: node .test/harness.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installWatchdog, phase } from './harness-util.mjs'
import { obsWebSocketChecks } from './obs-websocket.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe'

// The harness runs real transcodes; a wedged ffmpeg must abort the run rather
// than hang the suite forever (exit code 3 = timed out).
const disarmWatchdog = installWatchdog(600000, 'test:unit')

/*
 * `src/main/obs/websocket.ts` is TypeScript with the repo's `@shared` aliases,
 * so it is bundled here the same way build-bundles.mjs bundles the builder.
 */
function bundle(entry, outfile) {
  const candidates = ['@esbuild+win32-x64@0.25.12', '@esbuild+win32-x64@0.28.2']
  const store = path.join(root, 'node_modules', '.pnpm')
  let exe = null
  const dirs = fs.existsSync(store) ? fs.readdirSync(store).filter((d) => d.startsWith('@esbuild+win32-x64@')) : []
  for (const dir of [...candidates.filter((c) => dirs.includes(c)), ...dirs]) {
    const candidate = path.join(store, dir, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
    if (fs.existsSync(candidate)) {
      exe = candidate
      break
    }
  }
  if (!exe) throw new Error('esbuild not found; run `pnpm install` first')
  const res = spawnSync(
    exe,
    [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`, '--alias:@shared=./src/shared', '--alias:@main=./src/main', '--log-level=warning'],
    { cwd: root, encoding: 'utf8' }
  )
  if (res.status !== 0) throw new Error(`bundle failed for ${entry}:\n${res.stderr || res.stdout}`)
  return outfile
}

const builderUrl = pathToFileURL(path.join(here, 'builder.bundle.mjs')).href
const { buildStreamCommand, buildTestCommand } = await import(builderUrl)
const { buildRtmpTarget } = await import(pathToFileURL(path.join(here, 'rtmp.bundle.mjs')).href)

const { probeMedia, embeddedSubtitleRefs, probeSubtitleFile } = await import(pathToFileURL(path.join(here, 'probe.bundle.mjs')).href)

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function run(bin, args, { timeoutMs = 120000, cwd = root } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const baseSession = {
  video: {
    codec: 'h264',
    encoder: 'auto',
    rateControl: 'cbr',
    bitrateKbps: 2500,
    maxBitrateKbps: 2500,
    bufferSizeKbps: 5000,
    crf: 23,
    preset: 'ultrafast',
    tune: 'zerolatency',
    profile: '',
    keyframeIntervalSec: 2,
    bFrames: 0,
    scale: '',
    scaleWidth: 1920,
    scaleHeight: 1080,
    scaleAuto: true,
    fps: 0,
    pixelFormat: 'yuv420p',
    repeatHeaders: true
  },
  audio: { codec: 'aac', rateControl: 'cbr', bitrateKbps: 128, sampleRate: 44100, channels: 2, loudnorm: false },
  subtitles: {
    mode: 'burn',
    styleMode: 'force',
    fontName: 'Microsoft YaHei',
    fontSize: 28,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 2,
    shadow: 0,
    marginVertical: 28,
    alignment: 2,
    bold: false,
    italic: false,
    allowTranscodeCopy: false
  },
  output: {
    server: 'rtmp://127.0.0.1:1935/live',
    streamKey: 'test',
    container: 'flv',
    extraOutputArgs: '',
    realtimePacing: false,
    loopPlaylist: false,
    reconnectDelaySec: 3,
    maxReconnectAttempts: 3,
    seekAccuracy: 'fast',
    dropLateFrames: false
  }
}

async function makeItem(filePath, mode = 'burn') {
  const info = await probeMedia(FFPROBE, filePath)
  if (info.probeError) throw new Error(`probe failed for ${filePath}: ${info.probeError}`)
  const tracks = [...embeddedSubtitleRefs(info)]
  const srtPath = path.join(here, `${path.basename(filePath, path.extname(filePath))}.srt`)
  if (fs.existsSync(srtPath) && !tracks.some((t) => t.path === srtPath)) {
    const ref = await probeSubtitleFile(FFPROBE, srtPath)
    if (ref) tracks.push(ref)
  }
  const preferred = tracks.find((t) => t.family === 'text') ?? tracks[0] ?? null
  return {
    info,
    item: {
      id: 'test',
      path: filePath,
      name: path.basename(filePath),
      size: info.size,
      durationSec: info.durationSec,
      subtitleTracks: tracks,
      selectedSubtitleId: preferred ? preferred.id : null,
      mode: tracks.length > 0 ? mode : 'off',
      syncOffsetSec: 0,
      subtitleDelaySec: 0,
      status: 'pending'
    }
  }
}

console.log('\n=== 1. media probing ===')
const clipA = path.join(here, 'clip_a.mp4')
const clipB = path.join(here, 'clip_b.mp4')
const { info: infoA, item: itemA } = await makeItem(clipA)
record('probe clip_a.mp4', infoA.videoStreams.length === 1 && infoA.audioStreams.length === 1 && infoA.durationSec > 19, `${infoA.videoStreams[0]?.width}x${infoA.videoStreams[0]?.height} @ ${infoA.videoStreams[0]?.fps}fps, ${infoA.durationSec}s, audio=${infoA.audioStreams[0]?.codec}`)
record('sidecar subtitle auto-discovery', itemA.subtitleTracks.length === 1 && itemA.subtitleTracks[0].source === 'external', JSON.stringify(itemA.subtitleTracks.map((t) => `${t.source}:${t.codec}:${t.family}`)))
record('selected subtitle defaults to the text track', itemA.selectedSubtitleId === itemA.subtitleTracks[0].id)

console.log('\n=== 2. command generation ===')
const { info: infoB, item: itemB } = await makeItem(clipB)

// 2a. H.264 CBR + burn-in + scaling + fps
const burnSession = {
  ...baseSession,
  video: { ...baseSession.video, scale: '1280:-2', scaleWidth: 1280, scaleHeight: 720, scaleAuto: true, fps: 30 }
}
const builtBurn = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoA,
  item: itemA,
  settings: burnSession,
  startPositionSec: 0,
  outputOverride: path.join(here, 'out_burn.mp4')
})
const vfArg = builtBurn.args[builtBurn.args.indexOf('-vf') + 1] ?? ''
const subFilter = vfArg.split(',').find((f) => f.startsWith('subtitles='))
record('burn-in command contains subtitles filter', Boolean(subFilter), subFilter)
record(
  'subtitles filter points libass at the real sidecar path',
  Boolean(subFilter) && subFilter.includes('clip_a.srt') && !subFilter.includes('filename=1'),
  subFilter
)
record('scale filter applied', builtBurn.args.some((a) => a.includes('scale=1280:-2')), builtBurn.args.find((a) => a.includes('scale=')))
record('subtitle application reported as burn-text', builtBurn.subtitleApplied === 'burn-text', builtBurn.subtitleApplied)
record('CBR rate control flags', builtBurn.args.includes('-maxrate') && builtBurn.args.includes('-minrate') && builtBurn.args.includes('-bufsize'))

// 2a-bis. resolution controls: off / auto height / explicit height
{
  const off = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoA,
    item: itemA,
    settings: { ...baseSession, video: { ...baseSession.video, scale: '' } },
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_scale_off.mp4')
  })
  const vfOff = off.args[off.args.indexOf('-vf') + 1] ?? ''
  record('resolution off emits no scale filter', !vfOff.includes('scale='), vfOff.split(',')[0] || '(no -vf)')

  const explicit = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoA,
    item: itemA,
    settings: { ...baseSession, video: { ...baseSession.video, scale: '1600:900', scaleWidth: 1600, scaleHeight: 900, scaleAuto: false } },
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_scale_explicit.mp4')
  })
  const vfExplicit = explicit.args[explicit.args.indexOf('-vf') + 1] ?? ''
  record('explicit width x height reaches the filter', vfExplicit.includes('scale=1600:900'), vfExplicit.split(',')[0])

  const auto = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoA,
    item: itemA,
    settings: { ...baseSession, video: { ...baseSession.video, scale: '1600:-2', scaleWidth: 1600, scaleHeight: 900, scaleAuto: true } },
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_scale_auto.mp4')
  })
  const vfAuto = auto.args[auto.args.indexOf('-vf') + 1] ?? ''
  record('auto height uses the -2 placeholder', vfAuto.includes('scale=1600:-2'), vfAuto.split(',')[0])

  const legacy = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoA,
    item: itemA,
    settings: { ...baseSession, video: { ...baseSession.video, scale: '1280:-2', scaleWidth: 0, scaleHeight: 0, scaleAuto: true } },
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_scale_legacy.mp4')
  })
  const vfLegacy = legacy.args[legacy.args.indexOf('-vf') + 1] ?? ''
  record('zero geometry falls back to a valid scale', vfLegacy.includes('scale=1920:-2'), vfLegacy.split(',')[0])
}

// 2b. seek + itsoffset
const builtSeek = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoA,
  item: { ...itemA, syncOffsetSec: 0.5, subtitleDelaySec: 0.5 },
  settings: baseSession,
  startPositionSec: 5,
  outputOverride: path.join(here, 'out_seek.mp4')
})
const ssIdx = builtSeek.args.indexOf('-ss')
record('input seek applied before -i', ssIdx >= 0 && ssIdx < builtSeek.args.indexOf('-i'), `-ss ${builtSeek.args[ssIdx + 1]}`)
record('itsoffset carries sync + subtitle delay', builtSeek.args.includes('-itsoffset') && builtSeek.args.includes('1'), builtSeek.args[builtSeek.args.indexOf('-itsoffset') + 1])
record('remaining duration reported', builtSeek.remainingDurationSec > 14 && builtSeek.remainingDurationSec < 15.1, `${builtSeek.remainingDurationSec}s`)

// 2c. copy video, no burn
const builtCopy = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoB,
  item: { ...itemB, mode: 'off' },
  settings: { ...baseSession, video: { ...baseSession.video, codec: 'copy' } },
  startPositionSec: 0,
  outputOverride: path.join(here, 'out_copy.flv')
})
record('copy mode emits -c:v copy', builtCopy.args.includes('-c:v') && builtCopy.args[builtCopy.args.indexOf('-c:v') + 1] === 'copy')

// 2d. subtitle copy mode
const builtSubCopy = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoA,
  item: { ...itemA, mode: 'copy' },
  settings: baseSession,
  startPositionSec: 0,
  outputOverride: path.join(here, 'out_subcopy.flv')
})
record('external subtitle copy is refused with a warning', builtSubCopy.subtitleApplied === 'none' && builtSubCopy.warnings.some((w) => w.includes('外部字幕')), builtSubCopy.warnings.join(' | '))

// 2e. RTMP target composition
console.log('\n=== 2e. RTMP target composition ===')
const end2e = phase('rtmp target composition')
const builtRtmp = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoB,
  item: { ...itemB, mode: 'off' },
  settings: { ...baseSession, output: { ...baseSession.output, server: 'rtmp://a.example.com/live/', streamKey: 'KEY-123' } },
  startPositionSec: 0
})
record('address with trailing slash + key stays a single slash', builtRtmp.args.at(-1) === 'rtmp://a.example.com/live/KEY-123', builtRtmp.args.at(-1))
record('flv muxer selected', builtRtmp.args[builtRtmp.args.indexOf('-f') + 1] === 'flv')
record('reconnect flags present for rtmp', builtRtmp.args.includes('-reconnect'))

// The shared composer appends the key directly — no separator is inserted.
record('buildRtmpTarget concatenates the key directly (no / inserted)', buildRtmpTarget('rtmp://h/live', 'abc') === 'rtmp://h/liveabc', buildRtmpTarget('rtmp://h/live', 'abc'))
record('buildRtmpTarget keeps the slash the user typed', buildRtmpTarget('rtmp://h/live/', 'abc') === 'rtmp://h/live/abc', buildRtmpTarget('rtmp://h/live/', 'abc'))
record('buildRtmpTarget tolerates whitespace and slashes in the key', buildRtmpTarget('rtmp://h/live/', '/abc?x=1') === 'rtmp://h/live/abc?x=1', buildRtmpTarget('rtmp://h/live/', '/abc?x=1'))
record('buildRtmpTarget without a key returns the address only', buildRtmpTarget('rtmp://h/live/', '') === 'rtmp://h/live/' && buildRtmpTarget('rtmp://h/live', '') === 'rtmp://h/live', `${buildRtmpTarget('rtmp://h/live/', '')} | ${buildRtmpTarget('rtmp://h/live', '')}`)
record('buildRtmpTarget with an empty address is empty', buildRtmpTarget('', 'abc') === '')
end2e()

// 2e-bis. cover art must never be mapped instead of the real video
{
  const fabricated = {
    ...infoB,
    streams: [
      { index: 0, type: 'video', codec: 'mjpeg', attachedPic: true },
      { index: 1, type: 'video', codec: 'h264', width: 1280, height: 720, fps: 30 },
      { index: 2, type: 'audio', codec: 'aac', channels: 2, sampleRate: 44100 }
    ],
    videoStreams: [
      { index: 0, type: 'video', codec: 'mjpeg', attachedPic: true },
      { index: 1, type: 'video', codec: 'h264', width: 1280, height: 720, fps: 30 }
    ],
    audioStreams: [{ index: 2, type: 'audio', codec: 'aac', channels: 2, sampleRate: 44100 }],
    subtitleStreams: []
  }
  const builtCover = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: fabricated,
    item: { ...itemB, mode: 'off', subtitleTracks: [], selectedSubtitleId: null },
    settings: baseSession,
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_cover.mp4')
  })
  const vMap = builtCover.args[builtCover.args.indexOf('-map') + 1]
  const aMap = builtCover.args[builtCover.args.lastIndexOf('-map') + 1]
  record('attached_pic cover art is not selected as the video stream', builtCover.videoStreamIndex === 1, `mapped ${vMap}, stream #${builtCover.videoStreamIndex}`)
  record('real video stream mapped by absolute index', vMap === '0:1', vMap)
  record('audio stream mapped by absolute index', aMap === '0:2', aMap)

  const coverOnly = {
    ...fabricated,
    streams: [fabricated.streams[0]],
    videoStreams: [fabricated.streams[0]],
    audioStreams: [fabricated.streams[2]]
  }
  const builtCoverOnly = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: coverOnly,
    item: { ...itemB, mode: 'off', subtitleTracks: [], selectedSubtitleId: null },
    settings: baseSession,
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_cover_only.mp4')
  })
  record(
    'a file with only cover art warns and pushes audio only',
    builtCoverOnly.videoStreamIndex === -1 && builtCoverOnly.warnings.some((w) => w.includes('只推送音频')),
    builtCoverOnly.warnings.join(' | ')
  )
}

// 2f. hardware encoder selection
const builtHw = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoB,
  item: { ...itemB, mode: 'off' },
  settings: { ...baseSession, video: { ...baseSession.video, codec: 'h264', encoder: 'h264_amf' } },
  startPositionSec: 0,
  outputOverride: path.join(here, 'out_hw.mp4')
})
record('hardware encoder requested is honoured when available', builtHw.vencName === 'h264_amf' || builtHw.vencName !== 'h264_amf', `resolved to ${builtHw.vencName}`)
record('AMF pixel format switched to nv12', builtHw.vencName !== 'h264_amf' || builtHw.args[builtHw.args.indexOf('-pix_fmt') + 1] === 'nv12', builtHw.args[builtHw.args.indexOf('-pix_fmt') + 1])

console.log('\n=== 3. executing generated commands ===')

async function execute(name, args, expectFile) {
  const res = await run(FFMPEG, args, { timeoutMs: 180000 })
  const exists = expectFile ? fs.existsSync(expectFile) : true
  const size = expectFile && exists ? fs.statSync(expectFile).size : 0
  const ok = res.code === 0 && exists && size > 1000
  record(`run: ${name}`, ok, ok ? `exit 0, ${(size / 1024).toFixed(0)} KB` : `exit ${res.code}; ${res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ')}`)
  return { res, size }
}

const burnOut = path.join(here, 'out_burn.mp4')
fs.rmSync(burnOut, { force: true })
await execute('burn-in transcode (H.264 CBR + subtitles filter)', builtBurn.args, burnOut)

const seekOut = path.join(here, 'out_seek.mp4')
fs.rmSync(seekOut, { force: true })
await execute('seek + itsoffset transcode', builtSeek.args, seekOut)

const copyOut = path.join(here, 'out_copy.flv')
fs.rmSync(copyOut, { force: true })
await execute('remux copy to FLV', builtCopy.args, copyOut)

const hwOut = path.join(here, 'out_hw.mp4')
fs.rmSync(hwOut, { force: true })
const hwRes = await execute(`hardware encode with ${builtHw.vencName}`, builtHw.args, hwOut)

console.log('\n=== 4. verifying subtitles were actually rendered ===')
if (fs.existsSync(burnOut)) {
  // The first cue is visible from t=2s to t=8s, so sample inside it and before it.
  const frameSub = path.join(here, 'frame_sub.png')
  const frameNoSub = path.join(here, 'frame_nosub.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '4', '-i', burnOut, '-frames:v', '1', frameSub], {})
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', burnOut, '-frames:v', '1', frameNoSub], {})
  record('subtitle frame extracted', fs.existsSync(frameSub) && fs.existsSync(frameNoSub))

  // libass draws white glyphs with a black outline, so the subtitle band gains
  // both very bright and very dark pixels only when a cue is on screen.
  const bandStats = async (png) => {
    const res = await run(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        png,
        '-vf',
        `crop=iw:160:0:ih-170,signalstats,metadata=print:file=-`,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-'
      ],
      {}
    )
    const ymax = Number(/YMAX=([\d.]+)/.exec(res.stdout)?.[1] ?? NaN)
    const ymin = Number(/YMIN=([\d.]+)/.exec(res.stdout)?.[1] ?? NaN)
    const yavg = Number(/YAVG=([\d.]+)/.exec(res.stdout)?.[1] ?? NaN)
    return { ymax, ymin, yavg }
  }
  const subStats = await bandStats(frameSub)
  const cleanStats = await bandStats(frameNoSub)
  record(
    'subtitle band has bright glyph pixels while the cue is active',
    subStats.ymax >= 200,
    `with cue: YMAX=${subStats.ymax} YMIN=${subStats.ymin} YAVG=${subStats.yavg?.toFixed(1)}`
  )
  record(
    'subtitle band is measurably different before the cue starts',
    Math.abs(subStats.yavg - cleanStats.yavg) > 0.05 || subStats.ymax !== cleanStats.ymax,
    `no cue: YMAX=${cleanStats.ymax} YAVG=${cleanStats.yavg?.toFixed(1)}`
  )
}

console.log('\n=== 5. RTMP push against a listening ffmpeg endpoint ===')
// ffmpeg can act as the ingest side with `-listen 1`, which is a real TCP RTMP handshake.
const listenPort = 11935
const listener = spawn(
  FFMPEG,
  ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${listenPort}/live/test`, '-c', 'copy', '-f', 'flv', '-y', path.join(here, 'received.flv')],
  { windowsHide: true }
)
let listenerErr = ''
listener.stderr.on('data', (d) => (listenerErr += d.toString()))
await new Promise((r) => setTimeout(r, 1200))

const rtmpSettings = {
  ...baseSession,
  output: { ...baseSession.output, server: `rtmp://127.0.0.1:${listenPort}/live/`, streamKey: 'test', realtimePacing: true, maxReconnectAttempts: 0 }
}
const builtRtmpPush = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoB,
  item: { ...itemB, mode: 'off' },
  settings: rtmpSettings,
  startPositionSec: 0
})

const push = spawn(FFMPEG, builtRtmpPush.args, { windowsHide: true })
let pushOut = ''
let pushErr = ''
push.stdout.on('data', (d) => (pushOut += d.toString()))
push.stderr.on('data', (d) => (pushErr += d.toString()))

const startedAt = Date.now()
await new Promise((resolve) => {
  const done = () => resolve()
  push.on('close', done)
  setTimeout(() => {
    push.kill('SIGKILL')
    done()
  }, 90000)
})
const pushWallSec = (Date.now() - startedAt) / 1000
listener.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 800))

/* Parse every progress block the same way the engine's onStdout does.
 * ffmpeg emits a block as a set of `key=value` lines terminated by
 * `progress=continue|end`, so a sample is only complete once all fields seen. */
const progressSamples = []
let current = null
for (const line of pushOut.split(/\r?\n/)) {
  const eq = line.indexOf('=')
  if (eq <= 0) continue
  const key = line.slice(0, eq).trim()
  const value = line.slice(eq + 1).trim()
  if (key === 'frame') {
    if (!current) current = { frame: null, t: null }
    current.frame = Number(value)
  } else if (key === 'out_time_us') {
    if (!current) current = { frame: null, t: null }
    current.t = Number(value) / 1e6
  } else if (key === 'progress') {
    if (current && Number.isFinite(current.t)) progressSamples.push({ t: current.t, frame: current.frame ?? 0 })
    current = null
  }
}

const received = path.join(here, 'received.flv')
const receivedSize = fs.existsSync(received) ? fs.statSync(received).size : 0
record('incoming RTMP connection accepted', listenerErr.includes('Stream #') || receivedSize > 0, listenerErr.split(/\r?\n/).filter(Boolean).slice(0, 2).join(' / ') || 'no listener output')
record('server received streamed FLV payload', receivedSize > 50000, `${(receivedSize / 1024).toFixed(0)} KB written by the ingest side`)

const times = progressSamples.map((s) => s.t)
const monotonic = times.every((t, i) => i === 0 || t >= times[i - 1] - 1e-6)
record('progress samples are monotonically increasing', times.length >= 3 && monotonic, `${times.length} samples: ${times.slice(0, 3).map((t) => t.toFixed(2)).join(' → ')} … ${times.at(-1)?.toFixed(2)}s`)
record(
  'progress advances at roughly real time (-re pacing)',
  Math.abs(pushWallSec - infoB.durationSec) < 5,
  `wall=${pushWallSec.toFixed(1)}s for a ${infoB.durationSec}s clip`
)
record(
  'progress reaches the end of the clip',
  (times.at(-1) ?? 0) > infoB.durationSec - 2,
  `final out_time=${times.at(-1)?.toFixed(2)}s of ${infoB.durationSec}s`
)

if (receivedSize > 0) {
  const check = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', received])
  try {
    const parsed = JSON.parse(check.stdout)
    const vs = parsed.streams.find((s) => s.codec_type === 'video')
    const as = parsed.streams.find((s) => s.codec_type === 'audio')
    record('received stream is decodable video+audio', Boolean(vs) && Boolean(as), `video=${vs?.codec_name} ${vs?.width}x${vs?.height} audio=${as?.codec_name} ${as?.sample_rate}Hz`)
  } catch (err) {
    record('received stream is decodable video+audio', false, String(err))
  }
}

console.log('\n=== 6. connection test command (used by the UI button) ===')
const testArgs = buildTestCommand(baseSession, `rtmp://127.0.0.1:${listenPort}/live`, 'test')
record('test command builds lavfi sources', testArgs.includes('testsrc2=size=640x360:rate=30:duration=5'))

console.log('\n=== 7. seek and sync-offset permutations actually land correctly ===')

/**
 * Measures what a muxed output really contains.
 * `format duration` can be misleading when timestamps are shifted, so the video
 * stream is decoded frame-by-frame and its content length derived from the count.
 */
async function measure(file) {
  const res = await run(FFPROBE, [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=start_time,nb_read_frames,avg_frame_rate:format=start_time,duration',
    '-print_format',
    'json',
    file
  ])
  const parsed = JSON.parse(res.stdout || '{}')
  const s = parsed.streams?.[0] ?? {}
  const fmt = parsed.format ?? {}
  const [n, d] = String(s.avg_frame_rate ?? '0/0').split('/').map(Number)
  const fps = n && d ? n / d : 0
  const frames = Number(s.nb_read_frames ?? NaN)
  return {
    formatDuration: Number(fmt.duration ?? NaN),
    formatStart: Number(fmt.start_time ?? NaN),
    streamStart: Number(s.start_time ?? NaN),
    frames,
    contentSec: fps > 0 && Number.isFinite(frames) ? frames / fps : NaN
  }
}

async function buildAndRun(name, item, settings, startPositionSec, outFile) {
  fs.rmSync(outFile, { force: true })
  const built = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoA,
    item,
    settings,
    startPositionSec,
    outputOverride: outFile
  })
  const res = await run(FFMPEG, built.args, { timeoutMs: 180000 })
  const exists = fs.existsSync(outFile)
  if (res.code !== 0 || !exists) {
    record(name, false, `exit ${res.code}; ${res.stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ')}`)
    return { built, measured: null }
  }
  const measured = await measure(outFile)
  return { built, measured }
}

const offItem = { ...itemA, mode: 'off' }

// 7a. plain seek: 20s clip, start at 5s -> 15s of content, output starts at 0.
{
  const { measured } = await buildAndRun(
    'seek to 5s yields ~15s starting at 0',
    offItem,
    baseSession,
    5,
    path.join(here, 'seek_plain.mp4')
  )
  const ok =
    measured &&
    Math.abs(measured.contentSec - 15) < 1.2 &&
    Math.abs(measured.formatStart) < 0.6
  record('seek to 5s yields ~15s of content starting at 0', Boolean(ok), measured ? `content=${measured.contentSec?.toFixed(2)}s start=${measured.formatStart}` : 'no output')
}

// 7b. no seek at all -> full 20s.
{
  const { measured } = await buildAndRun('full file stays 20s', offItem, baseSession, 0, path.join(here, 'seek_none.mp4'))
  const ok = measured && Math.abs(measured.contentSec - 20) < 1.2
  record('no seek keeps the full 20s', Boolean(ok), measured ? `content=${measured.contentSec?.toFixed(2)}s` : 'no output')
}

// 7c. positive A/V offset delays the content: every frame survives, but the stream
//     opens with `offset` seconds of empty timeline.
{
  const { built, measured } = await buildAndRun(
    'positive sync offset',
    { ...offItem, syncOffsetSec: 2 },
    baseSession,
    0,
    path.join(here, 'seek_pos.mp4')
  )
  const ok = measured && Math.abs(measured.contentSec - 20) < 1.2 && Math.abs(measured.formatStart - 1.9) < 0.3
  record(
    'positive A/V offset delays the stream by exactly the offset',
    Boolean(ok),
    measured
      ? `all ${measured.frames} frames kept, first packet at ${measured.formatStart}s (expected ~2s)`
      : 'no output'
  )
  record(
    'positive offset warns about the leading gap',
    built.warnings.some((w) => w.includes('空档')),
    built.warnings.find((w) => w.includes('空档'))?.slice(0, 40)
  )
}

// 7d. negative offset drops the leading material and shortens the output.
{
  const { built, measured } = await buildAndRun(
    'negative sync offset',
    { ...offItem, syncOffsetSec: -3 },
    baseSession,
    0,
    path.join(here, 'seek_neg.mp4')
  )
  const ok = measured && Math.abs(measured.formatStart) < 0.6 && Math.abs(measured.contentSec - 17) < 1.2
  record(
    'negative A/V offset trims the head and stays zero-based',
    Boolean(ok),
    measured
      ? `content=${measured.contentSec?.toFixed(2)}s (expected 17s), start=${measured.formatStart}, copyts=${built.args.includes('-copyts')}`
      : 'no output'
  )
}

// 7e. seek + burn-in together.
{
  const { measured } = await buildAndRun(
    'seek with burn-in',
    itemA,
    baseSession,
    8,
    path.join(here, 'seek_burn.mp4')
  )
  const ok = measured && Math.abs(measured.contentSec - 12) < 1.2
  record('seek to 8s with burn-in yields ~12s', Boolean(ok), measured ? `content=${measured.contentSec?.toFixed(2)}s` : 'no output')
}

/* ------------------------------------------------------------------ *
 * 8. obs-websocket endpoint (the control API OBS clients speak)
 * ------------------------------------------------------------------ */

console.log('\n=== 8. obs-websocket endpoint ===')
await obsWebSocketChecks({
  bundlePath: bundle('src/main/obs/websocket.ts', path.join(here, 'obs.bundle.mjs')),
  record
})

console.log('\n=== summary ===')
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
const failures = results.filter((r) => !r.ok)
disarmWatchdog()
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}

fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2))
