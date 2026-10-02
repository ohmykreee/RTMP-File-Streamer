/**
 * Generates the fixture media the verification harnesses use:
 *   clip_a.mp4  20s 1280x720@30 with audio, plus clip_a.srt sidecar subtitles
 *   clip_b.mp4  15s  854x480@25 with audio
 *   clip_c.mp4  12s 1280x720@30 blue with audio (available for manual tests)
 *   clip_d.mp4  45s  640x360@60 — long enough that the buffered playout cannot
 *              finish it before a UI jump arrives (see engine-run.cjs)
 *
 * Usage: node .test/make-fixtures.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg'

function run(args, label) {
  const res = spawnSync(FFMPEG, args, { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(`ffmpeg failed for ${label}:\n${res.stderr?.split('\n').slice(-6).join('\n')}`)
    process.exit(1)
  }
  console.log(`  ${label}`)
}

const clip = (file, { size, fps, seconds, freq, color, videoOnly }) => {
  const out = path.join(here, file)
  if (fs.existsSync(out)) {
    console.log(`  ${file} (exists)`)
    return
  }
  const video = color ? `color=c=${color}:size=${size}:rate=${fps}:duration=${seconds}` : `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`
  run(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      video,
      ...(videoOnly ? [] : ['-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=${seconds}`]),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      ...(videoOnly ? [] : ['-c:a', 'aac', '-b:a', '128k', '-shortest']),
      out
    ],
    `${file} (${seconds}s ${size}@${fps}${videoOnly ? ', video only' : ''})`
  )
}

console.log('generating fixtures in .test/')
clip('clip_a.mp4', { size: '1280x720', fps: 30, seconds: 20, freq: 440 })
clip('clip_b.mp4', { size: '854x480', fps: 25, seconds: 15, freq: 660 })
clip('clip_c.mp4', { size: '1280x720', fps: 30, seconds: 12, freq: 880, color: 'navy' })
/*
 * clip_d deliberately uses a size no other fixture has (640x360). The harness tells
 * the files apart by the picture, and a shared resolution makes "which file is on
 * screen" unanswerable — measured: with clip_d at 1280x720, its frames were counted
 * as clip_a's, which made a correct skip look like a failure.
 */
clip('clip_d.mp4', { size: '640x360', fps: 60, seconds: 45, freq: 550, videoOnly: true })
console.log('fixtures ready')
