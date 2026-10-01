/**
 * Generates the fixture media the verification harnesses use:
 *   clip_a.mp4  20s 1280x720@30 with audio, plus clip_a.srt sidecar subtitles
 *   clip_b.mp4  15s  854x480@25 with audio
 *   clip_c.mp4  12s 1280x720@30 blue with audio (available for manual tests)
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

const clip = (file, { size, fps, seconds, freq, color }) => {
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
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${freq}:sample_rate=44100:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      out
    ],
    `${file} (${seconds}s ${size}@${fps})`
  )
}

console.log('generating fixtures in .test/')
clip('clip_a.mp4', { size: '1280x720', fps: 30, seconds: 20, freq: 440 })
clip('clip_b.mp4', { size: '854x480', fps: 25, seconds: 15, freq: 660 })
clip('clip_c.mp4', { size: '1280x720', fps: 30, seconds: 12, freq: 880, color: 'navy' })
console.log('fixtures ready')
