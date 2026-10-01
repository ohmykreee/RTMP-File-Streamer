/**
 * Probe how ffmpeg timestamp options interact with input seeking.
 * Writes a small matrix of (args -> measured start / content duration).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clip = path.join(here, 'clip_a.mp4') // 20s, 30fps, has audio
const out = (n) => path.join(here, `ts_${n}.mp4`)

function run(bin, args) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { windowsHide: true })
    let o = ''
    let e = ''
    c.stdout.on('data', (d) => (o += d))
    c.stderr.on('data', (d) => (e += d))
    c.on('error', () => resolve({ code: -1, o, e }))
    c.on('close', (code) => resolve({ code, o, e }))
  })
}

async function measure(file) {
  const r = await run('ffprobe', [
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
  const p = JSON.parse(r.o || '{}')
  const s = p.streams?.[0] ?? {}
  const f = p.format ?? {}
  const [n, d] = String(s.avg_frame_rate ?? '0/0').split('/').map(Number)
  const fps = n && d ? n / d : 0
  const frames = Number(s.nb_read_frames ?? NaN)
  return {
    start: Number(f.start_time ?? NaN),
    dur: Number(f.duration ?? NaN),
    frames,
    content: fps && Number.isFinite(frames) ? frames / fps : NaN
  }
}

const cases = [
  { name: 'plain', args: [] },
  { name: 'seek5', args: ['-ss', '5'] },
  { name: 'copyts_seek5', args: ['-copyts', '-ss', '5', '-start_at_zero'] },
  { name: 'itsoffset_pos2', args: ['-itsoffset', '2'] },
  { name: 'itsoffset_pos2_startzero', args: ['-itsoffset', '2', '-start_at_zero'] },
  { name: 'copyts_itsoffset_pos2', args: ['-copyts', '-itsoffset', '2', '-start_at_zero'] },
  { name: 'copyts_itsoffset_neg3', args: ['-copyts', '-itsoffset', '-3', '-start_at_zero'] },
  { name: 'itsoffset_neg3', args: ['-itsoffset', '-3'] },
  { name: 'copyts_seek5_itsoffset_pos2', args: ['-copyts', '-ss', '5', '-itsoffset', '2', '-start_at_zero'] },
  { name: 'seek5_itsoffset_pos2', args: ['-ss', '5', '-itsoffset', '2'] },
  // Candidates for the shipping behaviour: no -copyts at all.
  { name: 'seek5_itsoffset_neg3', args: ['-ss', '5', '-itsoffset', '-3'] },
  { name: 'seek5_itsoffset_pos05', args: ['-ss', '5', '-itsoffset', '0.5'] },
  { name: 'itsoffset_pos05', args: ['-itsoffset', '0.5'] },
  { name: 'seek8_itsoffset_neg15', args: ['-ss', '8', '-itsoffset', '-1.5'] },
  { name: 'seek8_itsoffset_pos15', args: ['-ss', '8', '-itsoffset', '1.5'] }
]

console.log('clip: 20s @30fps → expect 600 frames\n')
console.log('%-34s %-8s %-10s %-9s %s'.replace(/%-(\d+)s/g, (m, n) => `%-${n}s`), 'case', 'start', 'formatDur', 'frames', 'content')
for (const c of cases) {
  const file = out(c.name)
  fs.rmSync(file, { force: true })
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...c.args,
    '-i',
    clip,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ]
  const r = await run('ffmpeg', args)
  if (r.code !== 0) {
    console.log(`${c.name.padEnd(34)} FAILED: ${r.e.split('\n').filter(Boolean).slice(-1)[0]}`)
    continue
  }
  const m = await measure(file)
  console.log(
    `${c.name.padEnd(34)} ${String(m.start).padEnd(8)} ${String(m.dur?.toFixed(2)).padEnd(10)} ${String(m.frames).padEnd(9)} ${m.content?.toFixed(2)}s`
  )
}
