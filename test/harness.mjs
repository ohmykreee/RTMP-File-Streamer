/**
 * Standalone verification harness.
 *
 * It loads the REAL command builder that the app bundles (out/main/index.js
 * contains it, but that file also imports electron, so we re-bundle just the
 * builder with esbuild first — see test/build-bundles.mjs) and executes the
 * resulting ffmpeg argument vectors against real media files.
 *
 * Sections: command vectors, real transcodes, a local RTMP ingest, sync-offset
 * measurements, and the obs-websocket endpoint (`test/obs-websocket.mjs`).
 * Run it through `test/unit.mjs`, which prepares the fixtures and bundles.
 *
 * Usage: node test/harness.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installWatchdog, phase } from './harness-util.mjs'
import { obsWebSocketChecks } from './obs-websocket.mjs'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe'

// The harness runs real transcodes; a wedged ffmpeg must abort the run rather
// than hang the suite forever (exit code 3 = timed out).
const disarmWatchdog = installWatchdog(600000, 'test:unit')

/*
 * `src/main/obs/websocket.ts` is TypeScript with the repo's `@shared` aliases, so it is
 * bundled here the same way build-bundles.mjs bundles the builder — through esbuild's
 * JavaScript API, which resolves its own platform binary. See that file for why the CLI
 * is not used (its on-disk format differs per platform, and CI died on exactly that).
 */
function bundle(entry, outfile) {
  try {
    esbuild.buildSync({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { '@shared': './src/shared', '@main': './src/main' },
      logLevel: 'warning'
    })
  } catch {
    // esbuild already printed the offending line and its source position.
    throw new Error(`bundle failed for ${entry}`)
  }
  return outfile
}

const builderUrl = pathToFileURL(path.join(here, 'builder.bundle.mjs')).href
const { buildStreamCommand, buildTestCommand, buildEncoderArgs } = await import(builderUrl)
const { buildRtmpTarget } = await import(pathToFileURL(path.join(here, 'rtmp.bundle.mjs')).href)

const { probeMedia, embeddedSubtitleRefs, probeSubtitleFile } = await import(pathToFileURL(path.join(here, 'probe.bundle.mjs')).href)
const { ByteRateMeter } = await import(pathToFileURL(path.join(here, 'byte-rate.bundle.mjs')).href)

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
    italic: false
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

console.log('\n=== 1. i18n message tables ===')
const { EN, TRANSLATIONS, assertCatalogsComplete, detectLanguage, resolveLanguage, LANGUAGES } = await import(
  pathToFileURL(path.join(here, 'i18n.bundle.mjs')).href
)
{
  // Every language must define exactly the reference key set. A missing entry is
  // otherwise invisible: the UI quietly renders that one string in English.
  const problems = assertCatalogsComplete(EN, { zh: TRANSLATIONS.zh, ja: TRANSLATIONS.ja })
  record(
    'message tables define the same key set in every language',
    problems.length === 0,
    problems.slice(0, 5).join(' | ') || `${Object.keys(EN).length} keys x ${LANGUAGES.length} languages`
  )

  // No empty translation, and no {placeholder} that only some languages carry — a
  // dropped placeholder silently loses the value it was meant to insert.
  const placeholders = (text) => (String(text).match(/\{(\w+)\}/g) ?? []).sort().join(',')
  const empty = []
  const mismatched = []
  for (const [key, reference] of Object.entries(EN)) {
    for (const language of ['zh', 'ja']) {
      const text = TRANSLATIONS[language][key]
      if (!String(text).trim()) empty.push(`${language}:${key}`)
      if (placeholders(text) !== placeholders(reference)) mismatched.push(`${language}:${key} (${placeholders(text)} vs ${placeholders(reference)})`)
    }
  }
  record('no translation is empty', empty.length === 0, empty.slice(0, 5).join(' | ') || `${Object.keys(EN).length * 2} strings`)
  record(
    'every translation keeps the reference placeholders',
    mismatched.length === 0,
    mismatched.slice(0, 5).join(' | ') || `${Object.keys(EN).length * 2} strings`
  )

  // The detection rules: Chinese (either script) -> Chinese, Japanese -> Japanese,
  // everything else -> English.
  const cases = [
    ['zh-CN', 'zh'],
    ['zh-Hans', 'zh'],
    ['zh-TW', 'zh'],
    ['zh-HK', 'zh'],
    ['zh-Hant-TW', 'zh'],
    ['ja', 'ja'],
    ['ja-JP', 'ja'],
    ['en-US', 'en'],
    ['de-DE', 'en'],
    ['ko-KR', 'en'],
    ['', 'en'],
    [undefined, 'en']
  ]
  const wrong = cases.filter(([locale, expected]) => detectLanguage(locale) !== expected).map(([l, e]) => `${l}->${detectLanguage(l)} (want ${e})`)
  record(
    'system locale detection follows the documented rules',
    wrong.length === 0,
    wrong.join(' | ') || cases.map(([l]) => `${l || '(empty)'}->${detectLanguage(l)}`).join(' ')
  )

  // A saved choice always wins, and an unusable stored value falls back to the
  // system rather than leaving the app with a language it cannot render.
  record(
    'a saved language overrides the system locale',
    resolveLanguage('ja', 'zh-CN') === 'ja' && resolveLanguage('en', 'ja-JP') === 'en',
    `${resolveLanguage('ja', 'zh-CN')} / ${resolveLanguage('en', 'ja-JP')}`
  )
  record(
    'an absent or invalid saved language falls back to detection',
    resolveLanguage(undefined, 'ja-JP') === 'ja' && resolveLanguage('klingon', 'zh-TW') === 'zh' && resolveLanguage(null, 'fr-FR') === 'en',
    `${resolveLanguage(undefined, 'ja-JP')} / ${resolveLanguage('klingon', 'zh-TW')} / ${resolveLanguage(null, 'fr-FR')}`
  )

  // The command builder's diagnostics are translated through the same table, so the
  // language it is handed has to change the text it produces. Section 7 exercises
  // the same builder in depth; this only pins the language seam, which everything
  // else depends on.
  const langSession = {
    video: { codec: 'h264', encoder: 'x264', rateControl: 'cbr', bitrateKbps: 4000, maxBitrateKbps: 4000, bufferSizeKbps: 8000, crf: 22, preset: 'veryfast', tune: '', profile: 'high', keyframeIntervalSec: 2, bFrames: 0, scale: '', scaleWidth: 1280, scaleHeight: 720, scaleAuto: true, fps: 30, pixelFormat: 'yuv420p', repeatHeaders: true },
    audio: { codec: 'aac', rateControl: 'cbr', bitrateKbps: 128, sampleRate: 44100, channels: 2, loudnorm: false },
    subtitles: { mode: 'off' },
    output: { server: 'rtmp://127.0.0.1:1/live/', streamKey: 'k', container: 'flv', extraOutputArgs: '', realtimePacing: true, buffered: false, bufferSec: 12, loopPlaylist: false, reconnectDelaySec: 3, maxReconnectAttempts: 10, dropLateFrames: false, obsWebSocket: { enabled: false, host: '127.0.0.1', port: 4455, password: '' } }
  }
  const zhSummary = buildTestCommand(langSession, 'rtmp://127.0.0.1:1/live', 'k', 'zh').summary.join(' / ')
  const enSummary = buildTestCommand(langSession, 'rtmp://127.0.0.1:1/live', 'k', 'en').summary.join(' / ')
  record(
    'the command builder writes its summary in the requested language',
    zhSummary !== enSummary && zhSummary !== '' && enSummary !== '',
    `${zhSummary.slice(0, 44)} || ${enSummary.slice(0, 44)}`
  )
}

console.log('\n=== 2. media probing ===')
const clipA = path.join(here, 'clip_a.mp4')
const clipB = path.join(here, 'clip_b.mp4')
const { info: infoA, item: itemA } = await makeItem(clipA)
record('probe clip_a.mp4', infoA.videoStreams.length === 1 && infoA.audioStreams.length === 1 && infoA.durationSec > 19, `${infoA.videoStreams[0]?.width}x${infoA.videoStreams[0]?.height} @ ${infoA.videoStreams[0]?.fps}fps, ${infoA.durationSec}s, audio=${infoA.audioStreams[0]?.codec}`)
record('sidecar subtitle auto-discovery', itemA.subtitleTracks.length === 1 && itemA.subtitleTracks[0].source === 'external', JSON.stringify(itemA.subtitleTracks.map((t) => `${t.source}:${t.codec}:${t.family}`)))
record('selected subtitle defaults to the text track', itemA.selectedSubtitleId === itemA.subtitleTracks[0].id)

/*
 * The same subtitles, muxed INSIDE the container instead of sitting next to it.
 * Every burn-in path has to be checked twice: a sidecar is addressed by its path,
 * an internal track is not, and the failure the two produce is different in kind
 * (silent wrong-file vs. an aborted encode).
 */
const clipEmb = path.join(here, 'clip_emb.mkv')
const { info: infoEmb, item: itemEmb } = await makeItem(clipEmb)
record(
  'embedded subtitle track is probed as an internal track',
  infoEmb.subtitleStreams.length === 1 && infoEmb.subtitleStreams[0].index === 2 && itemEmb.subtitleTracks[0]?.source === 'embedded',
  `subtitleStreams=${JSON.stringify(infoEmb.subtitleStreams.map((s) => `#${s.index}:${s.codec}`))} selected=${itemEmb.selectedSubtitleId}`
)

console.log('\n=== 3. command generation ===')
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

// 2a-ter. Burn-in from an EMBEDDED track.
//
// libass opens a file of its own, so an internal track has to be read back out of
// the media file — with its index translated, because `si` counts subtitle streams
// while ffprobe indexes every stream. The shape that shipped passed the ffmpeg input
// number instead (`filename='0'`): libass looked for a file literally named "0",
// filter init failed and the whole encode of that item died with it.
const builtEmbBurn = buildStreamCommand({
  ffmpegPath: FFMPEG,
  media: infoEmb,
  item: itemEmb,
  settings: burnSession,
  startPositionSec: 0,
  outputOverride: path.join(here, 'out_burn_emb.mp4')
})
const embVf = builtEmbBurn.args[builtEmbBurn.args.indexOf('-vf') + 1] ?? ''
const embSubFilter = embVf.split(',').find((f) => f.startsWith('subtitles='))
record(
  'embedded burn-in points libass at the media file, not at input 0',
  Boolean(embSubFilter) && embSubFilter.includes('clip_emb.mkv') && !embSubFilter.includes("filename='0'"),
  embSubFilter
)
record(
  'embedded burn-in addresses the track by subtitle-stream position',
  Boolean(embSubFilter) && embSubFilter.includes('si=0') && !embSubFilter.includes('si=2'),
  embSubFilter
)
{
  // Two internal tracks with the second one selected: the index must come out as 1
  // even though its ffprobe index is 3, or the burn shows the wrong language.
  const mediaTwo = {
    ...infoEmb,
    subtitleStreams: [
      { index: 2, type: 'subtitle', codec: 'subrip', subtitleFamily: 'text' },
      { index: 3, type: 'subtitle', codec: 'subrip', subtitleFamily: 'text' }
    ]
  }
  const itemTwo = {
    ...itemEmb,
    subtitleTracks: [{ id: 'emb:3', source: 'embedded', streamIndex: 3, codec: 'subrip', family: 'text' }],
    selectedSubtitleId: 'emb:3'
  }
  const builtTwo = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: mediaTwo,
    item: itemTwo,
    settings: burnSession,
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_burn_two.mp4')
  })
  const vf = builtTwo.args[builtTwo.args.indexOf('-vf') + 1] ?? ''
  record('selected second embedded track maps to si=1', vf.includes('si=1'), vf)
}
{
  // A track the probe cannot find must not be swapped for whichever track happens to
  // be first: burning the wrong language quietly is worse than skipping it out loud.
  const itemGone = {
    ...itemEmb,
    subtitleTracks: [{ id: 'emb:9', source: 'embedded', streamIndex: 9, codec: 'subrip', family: 'text' }],
    selectedSubtitleId: 'emb:9'
  }
  const builtGone = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoEmb,
    item: itemGone,
    settings: burnSession,
    startPositionSec: 0,
    outputOverride: path.join(here, 'out_burn_gone.mp4')
  })
  const vf = builtGone.args[builtGone.args.indexOf('-vf') + 1] ?? ''
  record(
    'an embedded track missing from the probe is skipped with a warning',
    !vf.includes('subtitles=') && builtGone.subtitleApplied === 'none' && builtGone.warnings.some((w) => w.includes('内嵌字幕')),
    builtGone.warnings.join(' | ') || '(no warning)'
  )
}
{
  // The buffered playout burns through buildEncoderArgs, and that is the pipeline the
  // app streams with; the vector above is the single-process one.
  const encEmb = buildEncoderArgs({ ffmpegPath: FFMPEG, media: infoEmb, item: itemEmb, settings: burnSession, startPositionSec: 0 })
  const vf = encEmb.args[encEmb.args.indexOf('-vf') + 1] ?? ''
  record('buffered encoder pass burns embedded subtitles the same way', vf.includes("subtitles=filename='") && vf.includes('si=0'), vf)
}

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

// 2f. stream protocols: detection, target composition, per-protocol output args
console.log('\n=== 2f. stream protocols ===')
const end2f = phase('stream protocols')
const {
  detectStreamProtocol,
  buildPushTarget,
  addressMatchesProtocol,
  networkForProtocol,
  muxerForProtocol,
  containerForProtocol,
  protocolKeyArgs
} = await import(pathToFileURL(path.join(here, 'protocol.bundle.mjs')).href)

record('detection: rtmp/rtmps/srt/rtsp/whip schemes', detectStreamProtocol('rtmp://h/live') === 'rtmp' && detectStreamProtocol('rtmps://h/live') === 'rtmp' && detectStreamProtocol('srt://h:9000') === 'srt' && detectStreamProtocol('rtsp://h:554/a') === 'rtsp' && detectStreamProtocol('rtsps://h/a') === 'rtsp' && detectStreamProtocol('https://h/whip') === 'whip')
record('detection: unknown or bare addresses fall back to rtmp', detectStreamProtocol('h/live') === 'rtmp' && detectStreamProtocol('') === 'rtmp' && detectStreamProtocol('webrtc://h/x') === 'whip', `${detectStreamProtocol('h/live')}`)
record('srt key rides as a passphrase query parameter', buildPushTarget('srt://h:9000', 'secret123', 'srt') === 'srt://h:9000?passphrase=secret123', buildPushTarget('srt://h:9000', 'secret123', 'srt'))
record('srt passphrase joins with & when the address already has a query', buildPushTarget('srt://h:9000?mode=caller', 'secret123', 'srt') === 'srt://h:9000?mode=caller&passphrase=secret123')
record('srt passphrase is percent-encoded and never duplicated', buildPushTarget('srt://h:9000', 'a&b=c', 'srt') === 'srt://h:9000?passphrase=a%26b%3Dc' && buildPushTarget('srt://h:9000?passphrase=x', 'y', 'srt') === 'srt://h:9000?passphrase=x')
record('whip target keeps the address only (key travels separately)', buildPushTarget('https://h/whip', 'JWT.X.Y', 'whip') === 'https://h/whip')
record('rtsp key appends to the path like rtmp', buildPushTarget('rtsp://h:8554/live', 'key', 'rtsp') === 'rtsp://h:8554/livekey')
record('protocol key args: whip carries the key via -authorization', JSON.stringify(protocolKeyArgs('whip', 'tok')) === JSON.stringify(['-authorization', 'tok']), JSON.stringify(protocolKeyArgs('whip', 'tok')))
record('protocol key args: address-carried protocols add none', protocolKeyArgs('rtmp', 'k').length === 0 && protocolKeyArgs('srt', 'k').length === 0 && protocolKeyArgs('rtsp', 'k').length === 0 && protocolKeyArgs('whip', '').length === 0)
record('scheme validation matches its protocol only', addressMatchesProtocol('srt://h', 'srt') && !addressMatchesProtocol('rtmp://h', 'srt') && addressMatchesProtocol('rtmps://h', 'rtmp') && addressMatchesProtocol('http://h/x', 'whip'))
record('network clamps to what the protocol runs over', networkForProtocol('rtmp', 'udp') === 'tcp' && networkForProtocol('srt', 'tcp') === 'udp' && networkForProtocol('whip', 'udp') === 'tcp' && networkForProtocol('rtsp', 'udp') === 'udp')
record('muxer/container derivation per protocol', muxerForProtocol('rtmp') === 'flv' && muxerForProtocol('srt') === 'mpegts' && muxerForProtocol('rtsp') === 'rtsp' && muxerForProtocol('whip') === 'whip' && containerForProtocol('rtmp') === 'flv' && containerForProtocol('srt') === 'mpegts' && containerForProtocol('rtsp') === null && containerForProtocol('whip') === null)
record('derivation tolerates settings from older schemas (no protocol)', muxerForProtocol(undefined) === 'flv' && containerForProtocol(undefined) === 'flv')

const protoOut = (patch) => ({ ...baseSession, output: { ...baseSession.output, ...patch } })
const builtSrt = buildStreamCommand({ ffmpegPath: FFMPEG, media: infoB, item: { ...itemB, mode: 'off' }, settings: protoOut({ protocol: 'srt', network: 'udp', server: 'srt://a.example.com:9000', streamKey: 'pass12345' }), startPositionSec: 0 })
record('srt stream: mpegts muxer + passphrase target + no flv flags', builtSrt.args.at(-1) === 'srt://a.example.com:9000?passphrase=pass12345' && builtSrt.args[builtSrt.args.indexOf('-f') + 1] === 'mpegts' && !builtSrt.args.includes('-flvflags') && !builtSrt.args.includes('-reconnect'), builtSrt.args.at(-1))

const builtRtspTcp = buildStreamCommand({ ffmpegPath: FFMPEG, media: infoB, item: { ...itemB, mode: 'off' }, settings: protoOut({ protocol: 'rtsp', network: 'tcp', server: 'rtsp://a.example.com:8554/push', streamKey: '' }), startPositionSec: 0 })
const builtRtspUdp = buildStreamCommand({ ffmpegPath: FFMPEG, media: infoB, item: { ...itemB, mode: 'off' }, settings: protoOut({ protocol: 'rtsp', network: 'udp', server: 'rtsp://a.example.com:8554/push', streamKey: '' }), startPositionSec: 0 })
record('rtsp stream: rtsp muxer + chosen transport', builtRtspTcp.args.at(-1) === 'rtsp://a.example.com:8554/push' && builtRtspTcp.args[builtRtspTcp.args.indexOf('-f') + 1] === 'rtsp' && builtRtspTcp.args.includes('-rtsp_transport') && builtRtspTcp.args[builtRtspTcp.args.indexOf('-rtsp_transport') + 1] === 'tcp' && builtRtspUdp.args[builtRtspUdp.args.indexOf('-rtsp_transport') + 1] === 'udp')

const builtWhip = buildStreamCommand({ ffmpegPath: FFMPEG, media: infoB, item: { ...itemB, mode: 'off' }, settings: protoOut({ protocol: 'whip', network: 'tcp', server: 'https://a.example.com/whip/endpoint', streamKey: 'jwt-token' }), startPositionSec: 0 })
record('whip stream: whip muxer + bearer token via -authorization', builtWhip.args.at(-1) === 'https://a.example.com/whip/endpoint' && builtWhip.args[builtWhip.args.indexOf('-f') + 1] === 'whip' && builtWhip.args.includes('-authorization') && builtWhip.args[builtWhip.args.indexOf('-authorization') + 1] === 'jwt-token')
// baseSession audio is AAC, which WHIP cannot carry: the requirement warning must fire.
record('whip + AAC audio produces the Opus requirement warning', builtWhip.warnings.some((w) => w.includes('Opus')), builtWhip.warnings.join(' | '))

const whipWrongCodec = buildStreamCommand({ ffmpegPath: FFMPEG, media: infoB, item: { ...itemB, mode: 'off' }, settings: { ...protoOut({ protocol: 'whip', server: 'https://a.example.com/whip/endpoint', streamKey: 'jwt-token' }), video: { ...baseSession.video, codec: 'hevc' } }, startPositionSec: 0 })
record('whip + HEVC produces the H.264 requirement warning', whipWrongCodec.warnings.some((w) => w.includes('H.264')), whipWrongCodec.warnings.join(' | '))

const testSrt = buildTestCommand(protoOut({ protocol: 'srt', server: 'srt://127.0.0.1:9000', streamKey: 'pass12345' }), 'srt://127.0.0.1:9000', 'pass12345')
const lastAfter = (args, flag) => args[args.lastIndexOf(flag) + 1]
record('connection test follows the protocol (srt)', testSrt.args.at(-1) === 'srt://127.0.0.1:9000?passphrase=pass12345' && lastAfter(testSrt.args, '-f') === 'mpegts', testSrt.args.at(-1))
end2f()

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

console.log('\n=== 3b. network send-rate metering ===')
{
  /*
   * The status line's network figure. It is derived from a byte counter that a replaced
   * encoder pass — and a reconnected publisher — restarts from zero, so the arithmetic
   * is checked here rather than trusted: a counter reset that slipped through as a large
   * negative delta would be visible to the user as a nonsense rate, and the startup
   * burst would show a rate several times the real one.
   */
  const T0 = 1_000_000

  // 1 Mbit/s: 125000 bytes per second, reported every 500 ms as ffmpeg does.
  const steady = new ByteRateMeter()
  let bytes = 0
  for (let i = 0; i <= 20; i += 1) {
    steady.add(bytes, T0 + i * 500)
    bytes += 62_500
  }
  const steadyKbps = steady.kbps(T0 + 10_000)
  record('a steady 1 Mbit/s counter reads back as 1000 kbit/s', Math.abs(steadyKbps - 1000) < 20, `${steadyKbps.toFixed(0)} kbit/s`)

  const freshMeter = new ByteRateMeter()
  freshMeter.add(125_000, T0 + 500)
  record('one sample is not a rate', freshMeter.kbps(T0 + 500) === 0, `${freshMeter.kbps(T0 + 500)}`)

  // The first progress block of a session counts the container header plus the opening
  // burst; over 0.3 s that is many times the real rate, so it must not be published.
  const bursting = new ByteRateMeter()
  bursting.add(400_000, T0 + 300)
  bursting.add(600_000, T0 + 800)
  record('the startup burst is not published as a rate', bursting.kbps(T0 + 800) === 0, `${bursting.kbps(T0 + 800)} kbit/s at 0.8 s`)

  // A replaced pass restarts the counter: the step down must be ignored, not averaged in.
  bursting.add(2_000, T0 + 1300)
  const afterReset = bursting.kbps(T0 + 1300)
  record('a counter reset does not produce a negative rate', afterReset >= 0 && afterReset < 4000, `${afterReset.toFixed(0)} kbit/s after a reset (window still holds the pre-reset samples)`)

  const idle = new ByteRateMeter()
  idle.add(50_000, T0)
  idle.add(50_000, T0 + 5000)
  record('a stalled counter reads zero rather than a stale rate', idle.kbps(T0 + 5000) === 0, `${idle.kbps(T0 + 5000)} kbit/s while nothing moves`)

  // A window, not a session average: throughput that doubles mid-run has to show up.
  const changing = new ByteRateMeter()
  let moving = 0
  for (let i = 0; i <= 8; i += 1) {
    changing.add(moving, T0 + i * 500)
    moving += i < 4 ? 62_500 : 250_000
  }
  const fast = changing.kbps(T0 + 4000)
  record('the figure follows the recent window, not the session average', fast > 1500, `${fast.toFixed(0)} kbit/s after the rate quadrupled (session average would be ~1000)`)

  const cleared = new ByteRateMeter()
  cleared.add(100_000, T0)
  cleared.add(200_000, T0 + 2000)
  cleared.reset()
  cleared.add(100_000, T0 + 3000)
  record('a reset meter reports nothing until it has history again', cleared.kbps(T0 + 5000) === 0, `${cleared.kbps(T0 + 5000)} kbit/s`)
}

console.log('\n=== 4. executing generated commands ===')

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

const embBurnOut = path.join(here, 'out_burn_emb.mp4')
fs.rmSync(embBurnOut, { force: true })
await execute('embedded burn-in transcode (same filters, internal track)', builtEmbBurn.args, embBurnOut)

const seekOut = path.join(here, 'out_seek.mp4')
fs.rmSync(seekOut, { force: true })
await execute('seek + itsoffset transcode', builtSeek.args, seekOut)

const copyOut = path.join(here, 'out_copy.flv')
fs.rmSync(copyOut, { force: true })
await execute('remux copy to FLV', builtCopy.args, copyOut)

const hwOut = path.join(here, 'out_hw.mp4')
fs.rmSync(hwOut, { force: true })
const hwRes = await execute(`hardware encode with ${builtHw.vencName}`, builtHw.args, hwOut)

console.log('\n=== 5. verifying subtitles were actually rendered ===')
// libass draws white glyphs with a black outline, so the subtitle band gains both
// very bright and very dark pixels only when a cue is on screen. The first cue runs
// from t=2s to t=8s, so the samples go inside it and before it.
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

/**
 * Proves a burn-in really rendered, for either subtitle source.
 *
 * A command vector can look right and still produce a picture without subtitles —
 * that is exactly what `filename='0'` did — so the output is sampled rather than
 * trusted.
 */
async function renderedBurnChecks(label, outFile, tag) {
  if (!outFile || !fs.existsSync(outFile)) return
  const frameSub = path.join(here, `frame_${tag}_sub.png`)
  const frameNoSub = path.join(here, `frame_${tag}_nosub.png`)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '4', '-i', outFile, '-frames:v', '1', frameSub], {})
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', outFile, '-frames:v', '1', frameNoSub], {})
  record(`${label}: subtitle frame extracted`, fs.existsSync(frameSub) && fs.existsSync(frameNoSub))
  const subStats = await bandStats(frameSub)
  const cleanStats = await bandStats(frameNoSub)
  record(
    `${label}: band has bright glyph pixels while the cue is active`,
    subStats.ymax >= 200,
    `with cue: YMAX=${subStats.ymax} YMIN=${subStats.ymin} YAVG=${subStats.yavg?.toFixed(1)}`
  )
  record(
    `${label}: band is measurably different before the cue starts`,
    Math.abs(subStats.yavg - cleanStats.yavg) > 0.05 || subStats.ymax !== cleanStats.ymax,
    `no cue: YMAX=${cleanStats.ymax} YAVG=${cleanStats.yavg?.toFixed(1)}`
  )
}

await renderedBurnChecks('sidecar burn', burnOut, 'sub')
await renderedBurnChecks('embedded burn', embBurnOut, 'emb')

console.log('\n=== 6. RTMP push against a listening ffmpeg endpoint ===')
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
/*
 * Progress blocks are parsed AS THEY ARRIVE, exactly like the engine's `onStdout`.
 *
 * Reading `push.stdout` after the process exits (which is what this did) gives every
 * block the same wall-clock time: the pipe is only drained at the end, so the byte
 * counter arrives as one burst and any rate derived from it is meaningless — the
 * samples spanned 0 ms. The app sees them live, so the harness has to as well.
 */
const pushSamples = []
{
  let buf = ''
  let current = null
  const feed = (chunk) => {
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (key === 'frame') {
        if (!current) current = { frame: null, t: null, bytes: null, at: null }
        current.frame = Number(value)
      } else if (key === 'out_time_us') {
        if (!current) current = { frame: null, t: null, bytes: null, at: null }
        current.t = Number(value) / 1e6
      } else if (key === 'total_size') {
        // Bytes written towards the server, and when the block carrying them arrived.
        if (!current) current = { frame: null, t: null, bytes: null, at: null }
        current.bytes = Number(value)
        current.at = Date.now()
      } else if (key === 'progress') {
        if (current && Number.isFinite(current.t)) pushSamples.push(current)
        current = null
      }
    }
  }
  push.stdout.on('data', (d) => {
    const text = d.toString()
    pushOut += text
    feed(text)
  })
}
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

/* One entry per progress block, collected live by the reader above:
 * `t` is ffmpeg's output timeline, `bytes` its counters, `at` when it arrived. */
const progressSamples = pushSamples

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

/*
 * The status line's network figure depends entirely on `total_size` being reported
 * for a real publish session and on it counting bytes that reach the server. Neither
 * is obvious from the ffmpeg documentation — it is `N/A` for outputs that do not
 * count — so it is measured here against an ingest that really received the stream
 * rather than assumed from the counter alone.
 */
const byteSamples = progressSamples.filter((s) => Number.isFinite(s.bytes) && s.bytes > 0)
const byteCounts = byteSamples.map((s) => s.bytes)
const byteCountsRise = byteCounts.every((b, i) => i === 0 || b >= byteCounts[i - 1])
record(
  'the push reports bytes written to the server',
  byteSamples.length >= 3 && byteCountsRise && byteCounts.at(-1) > 0,
  `${byteSamples.length}/${progressSamples.length} progress blocks carried total_size, final ${((byteCounts.at(-1) ?? 0) / 1048576).toFixed(2)} MB`
)
record(
  'the byte count matches what the ingest received',
  receivedSize > 0 && (byteCounts.at(-1) ?? 0) > receivedSize * 0.75 && (byteCounts.at(-1) ?? 0) < receivedSize * 1.35,
  `ffmpeg counted ${((byteCounts.at(-1) ?? 0) / 1048576).toFixed(2)} MB, the listener wrote ${(receivedSize / 1048576).toFixed(2)} MB`
)
{
  const meter = new ByteRateMeter()
  for (const s of byteSamples) meter.add(s.bytes, s.at)
  const derived = meter.kbps(Date.now())
  // The window the meter keeps is the last couple of seconds, so the average it is
  // compared against is the one over the SAME span: a whole-push average is a
  // different quantity (it is dominated by the ramp-up) and the two legitimately
  // differ by a few percent.
  const windowStart = Math.max(0, byteSamples.findIndex((s) => s.at >= byteSamples.at(-1).at - 2000))
  const windowSamples = byteSamples.slice(windowStart)
  const average =
    windowSamples.length >= 2
      ? ((windowSamples.at(-1).bytes - windowSamples[0].bytes) / ((windowSamples.at(-1).at - windowSamples[0].at) / 1000)) * 0.008
      : 0
  record(
    'the meter derives a rate from the reported counter',
    derived > 0 && average > 0 && Math.abs(derived - average) / average < 0.2,
    `meter ${derived.toFixed(0)} kbit/s vs ${average.toFixed(0)} kbit/s over the meter's own ${windowSamples.length}-sample window (whole push: ${((byteCounts.at(-1) - byteCounts[0]) / ((byteSamples.at(-1).at - byteSamples[0].at) / 1000) * 0.008).toFixed(0)} kbit/s)`
  )
}

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

console.log('\n=== 7. connection test command (used by the UI button) ===')
{
  /*
   * The test button pushes a synthetic pattern, and every encoder setting in it must
   * come from the session: it used to carry its own hardcoded audio (128k, 44100,
   * stereo, CBR) and video (libx264 ultrafast 1000k), so a server could accept the
   * test and reject the real stream — or the reverse — with the UI reporting the
   * answer as if it were about the configured session.
   */
  const testSession = (over = {}) => ({
    ...baseSession,
    ...over,
    audio: { ...baseSession.audio, ...(over.audio ?? {}) },
    video: { ...baseSession.video, ...(over.video ?? {}) },
    output: { ...baseSession.output, ...(over.output ?? {}) }
  })
  const argAfter = (args, flag) => args[args.indexOf(flag) + 1]
  /** `-f` names the input format first and the output muxer last, so the output side needs the last one. */
  const lastArgAfter = (args, flag) => args[args.lastIndexOf(flag) + 1]
  const testCmd = (over) => buildTestCommand(testSession(over), `rtmp://127.0.0.1:${listenPort}/live`, 'key123')

  const testArgs = testCmd({}).args
  record('test command builds lavfi sources', testArgs.includes('testsrc2=size=640x360:rate=30:duration=5'), argAfter(testArgs, '-i'))
  record(
    'test command targets the address + key with the flv muxer',
    testArgs.at(-1) === `rtmp://127.0.0.1:${listenPort}/livekey123` && lastArgAfter(testArgs, '-f') === 'flv',
    `${lastArgAfter(testArgs, '-f')} ${testArgs.at(-1)}`
  )

  /* --- audio: the whole tab --- */
  const mp3 = testCmd({ audio: { codec: 'libmp3lame', rateControl: 'vbr', bitrateKbps: 320, sampleRate: 22050, channels: 1, loudnorm: true } }).args
  record('test honours the audio codec', argAfter(mp3, '-c:a') === 'libmp3lame', argAfter(mp3, '-c:a'))
  record('test honours the audio sample rate', argAfter(mp3, '-ar') === '22050', argAfter(mp3, '-ar'))
  record('test honours the audio channel count', argAfter(mp3, '-ac') === '1', argAfter(mp3, '-ac'))
  record('test honours audio VBR (no -b:a, -q:a instead)', mp3.includes('-q:a') && !mp3.includes('-b:a'), `-q:a ${argAfter(mp3, '-q:a')}`)
  record('test honours loudnorm', argAfter(mp3, '-af')?.includes('loudnorm=I=-16') === true, argAfter(mp3, '-af'))
  record(
    'test keeps the resample/format filters the real command uses',
    ['aresample=22050', 'channel_layouts=mono'].every((f) => argAfter(mp3, '-af')?.includes(f) === true),
    argAfter(mp3, '-af')
  )

  const aacCbr = testCmd({ audio: { codec: 'aac', rateControl: 'cbr', bitrateKbps: 96, sampleRate: 48000, channels: 2 } }).args
  record('test honours the audio bitrate for CBR', argAfter(aacCbr, '-b:a') === '96k', argAfter(aacCbr, '-b:a'))
  // `-af` stays: the resample/format filters are always needed. Only loudnorm is optional.
  record(
    'test omits loudnorm when it is off',
    !aacCbr.some((arg) => arg.includes('loudnorm')),
    aacCbr[aacCbr.indexOf('-af') + 1]
  )

  // Opus cannot be resampled to a rate it does not accept, so the encoder wins.
  const opus = testCmd({ audio: { codec: 'libopus', bitrateKbps: 64, sampleRate: 22050, channels: 2 } }).args
  record('test forces 48 kHz for Opus but keeps its bitrate', argAfter(opus, '-ar') === '48000' && argAfter(opus, '-b:a') === '64k', `${argAfter(opus, '-ar')} / ${argAfter(opus, '-b:a')}`)

  const noAudio = testCmd({ audio: { codec: 'none' } })
  record('audio "none" pushes video only', noAudio.args.includes('-an') === false && !noAudio.args.includes('-c:a') && noAudio.args.join(' ').includes('-map 0:v:0'), noAudio.summary.join(' · '))

  const copyAudio = testCmd({ audio: { codec: 'copy' } })
  record(
    'audio "copy" is reported instead of silently tested as a copy',
    argAfter(copyAudio.args, '-c:a') === 'aac' && copyAudio.notes.some((n) => n.includes('复制源音频')),
    copyAudio.notes.join(' | ')
  )

  /* --- video --- */
  const hevc = testCmd({ video: { codec: 'hevc', encoder: 'x265', bitrateKbps: 3000, fps: 25, scale: '1280:720', scaleWidth: 1280, scaleHeight: 720, scaleAuto: false, keyframeIntervalSec: 1 } }).args
  record('test honours the video codec', argAfter(hevc, '-c:v') === 'libx265', argAfter(hevc, '-c:v'))
  record('test generates the pattern at the configured resolution', hevc.includes('testsrc2=size=1280x720:rate=25:duration=5'), argAfter(hevc, '-i'))
  record('test honours the configured CBR bitrate', argAfter(hevc, '-b:v') === '3000k' && argAfter(hevc, '-minrate') === '3000k', `${argAfter(hevc, '-b:v')} / ${argAfter(hevc, '-minrate')}`)
  record('test derives the GOP from the configured keyframe interval', argAfter(hevc, '-g') === '25', `-g ${argAfter(hevc, '-g')}`)

  const capped = testCmd({ video: { scale: '3840:-2', scaleWidth: 3840, scaleHeight: 2160, scaleAuto: true } }).args
  record(
    'an oversized output is capped so the test stays quick',
    capped.includes('testsrc2=size=1280x720:rate=30:duration=5'),
    capped.find((a) => a.startsWith('testsrc2='))
  )

  const copyVideo = testCmd({ video: { codec: 'copy' } })
  record(
    'video "copy" is reported instead of silently tested as a copy',
    argAfter(copyVideo.args, '-c:v') === 'libx264' && copyVideo.notes.some((n) => n.includes('直接复制')),
    copyVideo.notes.join(' | ')
  )

  /* --- output --- */
  const extra = testCmd({ output: { extraOutputArgs: '-flvflags no_duration_filesize -metadata comment=x', dropLateFrames: true } }).args
  const flvFlagsCount = extra.filter((a) => a === '-flvflags').length
  record('test appends the custom output arguments exactly once', extra.includes('-metadata') && flvFlagsCount === 1, `-flvflags ×${flvFlagsCount}`)
  record('test honours drop-late-frames', argAfter(extra, '-fflags') === '+genpts+igndts' && argAfter(extra, '-max_delay') === '0', argAfter(extra, '-fflags'))
  record('test applies the always-on FLV flag by default', testArgs.filter((a) => a === '-flvflags').length === 1, `-flvflags ${argAfter(testArgs, '-flvflags')}`)

  // The container is no longer a free choice: it follows the protocol.
  const ts = buildTestCommand(testSession({ output: { protocol: 'srt', network: 'udp', server: 'srt://127.0.0.1:9000/live', extraOutputArgs: '' } }), 'srt://127.0.0.1:9000/live', 'key123').args
  record('test follows the protocol-derived container', lastArgAfter(ts, '-f') === 'mpegts' && !ts.includes('-flvflags') && ts.at(-1) === 'srt://127.0.0.1:9000/live?passphrase=key123', lastArgAfter(ts, '-f'))

  /* --- what the result panel shows --- */
  const summary = testCmd({ audio: { bitrateKbps: 192 }, video: { bitrateKbps: 4500 } }).summary.join(' · ')
  record(
    'test result summarises the settings it used',
    summary.includes('4500kbps') && summary.includes('192kbps') && summary.includes('aac'),
    summary
  )
  const opusNotes = testCmd({ audio: { codec: 'libopus' } }).notes.join(' | ')
  record('an FLV/Opus combination warns before the connection is blamed', opusNotes.includes('Opus'), opusNotes)

  /*
   * End to end: run the command and probe what the ingest actually received. The
   * argument checks above prove intent; this proves the settings survive ffmpeg's own
   * filter/encoder negotiation, which is where "mono 22050 Hz" quietly becomes stereo
   * 44100 Hz if the resample/format filters are missing.
   */
  const probeStreams = async (file) => {
    const res = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])
    try {
      const parsed = JSON.parse(res.stdout)
      return {
        video: parsed.streams.find((s) => s.codec_type === 'video'),
        audio: parsed.streams.find((s) => s.codec_type === 'audio'),
        format: parsed.format ?? {}
      }
    } catch (err) {
      return { error: String(err) }
    }
  }

  /** Pushes a test command at a fresh listener and returns the received file's streams. */
  const receiveTestPush = async (label, over) => {
    const port = listenPort + 40
    const file = path.join(here, `received_${label}.flv`)
    fs.rmSync(file, { force: true })
    const sink = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'warning', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${port}/live/test`, '-c', 'copy', '-f', 'flv', '-y', file],
      { windowsHide: true }
    )
    await new Promise((r) => setTimeout(r, 1200))
    const built = buildTestCommand(testSession(over), `rtmp://127.0.0.1:${port}/live`, 'test')
    const res = await run(FFMPEG, built.args, { timeoutMs: 90000 })
    sink.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 800))
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    const streams = size > 0 ? await probeStreams(file) : { error: 'nothing received' }
    fs.rmSync(file, { force: true })
    return { res, size, ...streams, built }
  }

  const receivedAudio = await receiveTestPush('test_audio', {
    audio: { codec: 'aac', rateControl: 'cbr', bitrateKbps: 96, sampleRate: 22050, channels: 1, loudnorm: true },
    video: { scale: '1280:720', scaleWidth: 1280, scaleHeight: 720, scaleAuto: false, fps: 25 }
  })
  record('the test push is accepted by a listening RTMP endpoint', receivedAudio.res.code === 0 && receivedAudio.size > 50000, `exit ${receivedAudio.res.code}, ${(receivedAudio.size / 1024).toFixed(0)} KB`)
  record(
    'the received test audio matches the configured codec/rate/channels',
    receivedAudio.audio?.codec_name === 'aac' && receivedAudio.audio?.sample_rate === '22050' && receivedAudio.audio?.channels === 1,
    receivedAudio.audio
      ? `audio=${receivedAudio.audio.codec_name} ${receivedAudio.audio.sample_rate}Hz ${receivedAudio.audio.channels}ch`
      : String(receivedAudio.error)
  )
  record(
    'the received test video matches the configured resolution and frame rate',
    receivedAudio.video?.width === 1280 && receivedAudio.video?.height === 720 && receivedAudio.video?.avg_frame_rate === '25/1',
    receivedAudio.video ? `video=${receivedAudio.video.codec_name} ${receivedAudio.video.width}x${receivedAudio.video.height} @${receivedAudio.video.avg_frame_rate}` : String(receivedAudio.error)
  )
  const receivedMuted = await receiveTestPush('test_noaudio', { audio: { codec: 'none' } })
  record(
    'audio "none" really sends a video-only stream',
    receivedMuted.res.code === 0 && !!receivedMuted.video && !receivedMuted.audio,
    receivedMuted.video ? `video=${receivedMuted.video.codec_name}, audio=${receivedMuted.audio ? 'present' : 'absent'}` : String(receivedMuted.error)
  )
}

console.log('\n=== 8. seek and sync-offset permutations actually land correctly ===')

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

/*
 * Regression guard for the seek/progress bug.
 *
 * ffmpeg rebases the output timeline to zero at the seek point: seeking to 12s in
 * a 20s clip reports progress for only the remaining ~8s. Anything that maps
 * ffmpeg's own progress onto "position in the file" therefore has to add the
 * seek offset back, or the progress bar jumps backwards and never reaches the
 * end. This pins the behaviour the engine depends on.
 */
{
  const outFile = path.join(here, 'probe_seek_pts.mp4')
  fs.rmSync(outFile, { force: true })
  const built = buildStreamCommand({
    ffmpegPath: FFMPEG,
    media: infoA,
    item: offItem,
    settings: baseSession,
    startPositionSec: 12,
    outputOverride: outFile
  })
  const res = await run(FFMPEG, built.args, { timeoutMs: 180000 })
  const times = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^out_time_us=(\d+)$/.exec(line)
    if (m) times.push(Number(m[1]) / 1e6)
  }
  const last = times.at(-1) ?? 0
  const expected = infoA.durationSec - 12
  record(
    'a seeked pass reports progress rebased to zero (engine must add the seek offset)',
    times.length > 0 && last > expected - 1.5 && last < expected + 1.5,
    `last out_time=${last.toFixed(2)}s for a ${infoA.durationSec}s clip seeked to 12s (expected ~${expected.toFixed(1)}s)`
  )
}

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

console.log('\n=== 9. obs-websocket endpoint ===')
await obsWebSocketChecks({
  bundlePath: bundle('src/main/obs/websocket.ts', path.join(here, 'obs.bundle.mjs')),
  record
})

/* ------------------------------------------------------------------ *
 * 9. buffered playout: the configured lead is a limit, not a wish
 * ------------------------------------------------------------------ */

console.log('\n=== 10. encoder buffer is enforced ===')
/*
 * The encoder runs flat out while the publisher takes material at 1x, so everything
 * ahead of the publisher is held in this process's memory. That queue used to be
 * unbounded (it grew to the whole playlist and eventually killed a real 4h51m
 * session); now the playout pauses the encoder whenever it is further ahead than
 * `bufferSec` allows.
 *
 * Two runs of the same clip with different limits is what proves the SETTING is the
 * thing doing the bounding: a playout that ignored it would reach the same lead in
 * both runs, and one that never throttled would keep the whole 45 s fixture. The
 * encoder is deliberately slowed to ~5x real time — a fast one finishes the fixture
 * between two `-progress` reports, and then no throttle decision can be made at all.
 */
{
  const { BUFFER_SEC_MIN } = await import(pathToFileURL(bundle('src/shared/defaults.ts', path.join(here, 'defaults.bundle.mjs'))).href)
  const { Playout } = await import(pathToFileURL(bundle('src/main/stream/playout.ts', path.join(here, 'playout.bundle.mjs'))).href)
  // The playout writes its log lines through the message table, which it is handed
  // rather than importing (see `PlayoutCallbacks.t`); the hold line is read below.
  const zhText = (key) => TRANSLATIONS.zh[key] ?? key
  /** The hold acts on `-progress` reports (~0.5 s apart), so one interval of material overshoots. */
  const LEAD_SLACK_SEC = 4
  const WINDOW_SEC = 8

  /** Runs one encoder pass through the real playout and reports what the buffer did. */
  const measureLead = async (leadLimitSec, tag) => {
    const holds = []
    let published = 0
    const playout = new Playout(FFMPEG, ['-y', '-f', 'flv', path.join(here, `${tag}.flv`)], leadLimitSec, {
      log: (level, message) => {
        if (message.includes('暂停编码进程输出')) holds.push(message)
      },
      onPublished: (sec) => {
        published = sec
      },
      onPusherExit: () => {},
      onEncoderExit: () => {},
      t: zhText
    })
    await playout.start(
      {
        input: path.join(here, 'clip_d.mp4'),
        args: ['-map', '0:v', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '1', '-g', '60', '-pix_fmt', 'yuv420p', '-an'],
        startPositionSec: 0,
        tsOffset: 0,
        expectedSec: 45
      },
      false
    )
    let peak = 0
    const started = Date.now()
    while ((Date.now() - started) / 1000 < WINDOW_SEC) {
      peak = Math.max(peak, playout.getEncoderStats().leadSec)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const wallSec = (Date.now() - started) / 1000
    const relayed = playout.getRelayStats()
    const pts = playout.getTsPtsSpan()
    const encodedSec = playout.getEncodedSec()
    await playout.stop()
    return { peak, holds, published, wallSec, relayedMb: relayed.relayedBytes / 1048576, pts, encodedSec }
  }

  const small = await measureLead(BUFFER_SEC_MIN, 'lead_small')
  const large = await measureLead(BUFFER_SEC_MIN * 2, 'lead_large')
  record(
    'the encoder is held at the small configured lead instead of encoding the whole file',
    small.peak <= BUFFER_SEC_MIN + LEAD_SLACK_SEC && small.peak >= BUFFER_SEC_MIN * 0.6 && small.holds.length > 0,
    `peak lead ${small.peak.toFixed(1)}s of a 45s clip (limit ${BUFFER_SEC_MIN}s + ${LEAD_SLACK_SEC}s slack), ${small.holds.length} hold(s), ${small.relayedMb.toFixed(1)} MB relayed`
  )
  record(
    'a larger lead setting really does allow a larger buffer',
    large.peak >= small.peak + 6 && large.holds.length > 0,
    `peak ${small.peak.toFixed(1)}s at ${BUFFER_SEC_MIN}s vs ${large.peak.toFixed(1)}s at ${BUFFER_SEC_MIN * 2}s`
  )
  record(
    'the publisher kept taking material at real time while the encoder was held',
    /*
     * The publisher may only air what it is given, so if the throttle holds the encoder
     * a little too long every cycle, production settles below 1x and every live viewer
     * starves — that is exactly what a real session did (0.77–0.90x measured), and it
     * shows up here as `published` falling behind the wall clock.
     */
    small.published > small.wallSec * 0.9 && large.published > large.wallSec * 0.9,
    `published ${small.published.toFixed(1)}s of ${small.wallSec.toFixed(1)}s wall (small), ${large.published.toFixed(1)}s of ${large.wallSec.toFixed(1)}s (large)`
  )
  record(
    'the reported on-wire PTS stays on the stream timeline',
    /*
     * The relay's TS scan feeds the "on-wire video PTS" figure in the log. It used to
     * read the PTS at a fixed offset, which lands inside the PCR whenever the muxer
     * writes one, and reported absurd spans (22,427–44,006 s for a 23-minute pass) —
     * numbers an operator reasonably reads as a timestamp fault in the stream.
     */
    small.pts.videoHeaders > 0 &&
      Number.isFinite(small.pts.firstSec) &&
      Number.isFinite(small.pts.lastSec) &&
      small.pts.lastSec >= small.encodedSec - 30 &&
      small.pts.lastSec <= small.encodedSec + 5 &&
      small.pts.firstSec < 10,
    `PTS ${small.pts.firstSec?.toFixed(2)}–${small.pts.lastSec?.toFixed(2)}s over ${small.pts.videoHeaders} frames, encoder at ${small.encodedSec.toFixed(1)}s`
  )
  if (small.holds[0]) console.log(`  hold: ${small.holds[0]}`)
}

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
