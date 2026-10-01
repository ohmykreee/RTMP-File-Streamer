import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AudioCodecName, ContainerName, EncoderOption, FfmpegCapabilities, VideoCodecName } from '@shared/types'
import { CONTAINER_MUXER } from '@shared/defaults'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export function runProcess(bin: string, args: string[], timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) })
      return
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ code: -2, stdout, stderr: stderr + '\n[timeout]' })
      }
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + '\n' + String(err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const WIN_EXTS = ['.exe', '.cmd', '.bat', '']

function isExecutable(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Search every directory on PATH for `name`. */
function searchPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of WIN_EXTS) {
      const candidate = path.join(dir, name + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function commonLocations(name: string): string[] {
  const home = os.homedir()
  const out: string[] = []
  const roots = [
    'C:\\ExecuteBin',
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    'C:\\Program Files (x86)\\ffmpeg\\bin',
    path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
    path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin'),
    path.join(home, 'scoop', 'shims'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin'
  ]
  for (const root of roots) {
    for (const ext of WIN_EXTS) out.push(path.join(root, name + ext))
  }
  return out
}

export interface BinaryResolution {
  ffmpeg: string
  ffprobe: string
  source: FfmpegCapabilities['source']
}

/**
 * Resolve the ffmpeg/ffprobe pair. Priority:
 *   1. explicit path saved in settings
 *   2. binaries shipped next to the app (`resources/bin` or `bin` in dev)
 *   3. first hit on PATH
 *   4. well-known install locations
 */
export function resolveBinaries(configuredFfmpeg: string, configuredFfprobe: string): BinaryResolution {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const bundledRoots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : '',
    path.join(process.cwd(), 'bin')
  ].filter(Boolean)

  if (configuredFfmpeg && isExecutable(configuredFfmpeg)) {
    const probeGuess = configuredFfprobe && isExecutable(configuredFfprobe)
      ? configuredFfprobe
      : path.join(path.dirname(configuredFfmpeg), 'ffprobe' + exe)
    return {
      ffmpeg: configuredFfmpeg,
      ffprobe: isExecutable(probeGuess) ? probeGuess : '',
      source: 'settings'
    }
  }

  for (const root of bundledRoots) {
    const ff = path.join(root, 'ffmpeg' + exe)
    if (isExecutable(ff)) {
      let fp = path.join(root, 'ffprobe' + exe)
      if (!isExecutable(fp)) fp = searchPath('ffprobe') ?? ''
      return { ffmpeg: ff, ffprobe: fp, source: 'bundled' }
    }
  }

  const onPath = searchPath('ffmpeg')
  if (onPath) {
    const probe = configuredFfprobe && isExecutable(configuredFfprobe) ? configuredFfprobe : searchPath('ffprobe') ?? ''
    return { ffmpeg: onPath, ffprobe: probe, source: 'path' }
  }

  for (const candidate of commonLocations('ffmpeg')) {
    if (isExecutable(candidate)) {
      const probe = commonLocations('ffprobe').find(isExecutable) ?? ''
      return { ffmpeg: candidate, ffprobe: probe, source: 'common-location' }
    }
  }

  return { ffmpeg: '', ffprobe: '', source: 'missing' }
}

/* ------------------------------------------------------------------ *
 * Encoder catalogue
 * ------------------------------------------------------------------ */

interface EncoderDef {
  value: Exclude<EncoderOption['value'], 'auto'>
  label: string
  codec: VideoCodecName
  kind: EncoderOption['kind']
  ffmpegName: string
  /** Preferred presets, fastest first. */
  presets: string[]
  note?: string
}

export const ENCODER_CATALOGUE: EncoderDef[] = [
  // --- AMD AMF (this machine's GPU family) ---
  { value: 'h264_amf', label: 'H.264 · AMD AMF (硬件)', codec: 'h264', kind: 'amf', ffmpegName: 'h264_amf', presets: ['speed', 'balanced', 'quality'] },
  { value: 'hevc_amf', label: 'HEVC · AMD AMF (硬件)', codec: 'hevc', kind: 'amf', ffmpegName: 'hevc_amf', presets: ['speed', 'balanced', 'quality'] },
  { value: 'av1_amf', label: 'AV1 · AMD AMF (硬件)', codec: 'av1', kind: 'amf', ffmpegName: 'av1_amf', presets: ['speed', 'balanced', 'quality'] },
  // --- NVIDIA NVENC ---
  { value: 'h264_nvenc', label: 'H.264 · NVIDIA NVENC (硬件)', codec: 'h264', kind: 'nvenc', ffmpegName: 'h264_nvenc', presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  { value: 'hevc_nvenc', label: 'HEVC · NVIDIA NVENC (硬件)', codec: 'hevc', kind: 'nvenc', ffmpegName: 'hevc_nvenc', presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  { value: 'av1_nvenc', label: 'AV1 · NVIDIA NVENC (硬件)', codec: 'av1', kind: 'nvenc', ffmpegName: 'av1_nvenc', presets: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] },
  // --- Intel QSV ---
  { value: 'h264_qsv', label: 'H.264 · Intel QSV (硬件)', codec: 'h264', kind: 'qsv', ffmpegName: 'h264_qsv', presets: ['veryfast', 'faster', 'fast', 'medium', 'slow'] },
  { value: 'hevc_qsv', label: 'HEVC · Intel QSV (硬件)', codec: 'hevc', kind: 'qsv', ffmpegName: 'hevc_qsv', presets: ['veryfast', 'faster', 'fast', 'medium', 'slow'] },
  { value: 'av1_qsv', label: 'AV1 · Intel QSV (硬件)', codec: 'av1', kind: 'qsv', ffmpegName: 'av1_qsv', presets: ['veryfast', 'faster', 'fast', 'medium', 'slow'] },
  // --- Software ---
  { value: 'x264', label: 'H.264 · libx264 (软件/兼容性最好)', codec: 'h264', kind: 'software', ffmpegName: 'libx264', presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower'] },
  { value: 'x265', label: 'HEVC · libx265 (软件)', codec: 'hevc', kind: 'software', ffmpegName: 'libx265', presets: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'] },
  { value: 'svt-av1', label: 'AV1 · SVT-AV1 (软件)', codec: 'av1', kind: 'software', ffmpegName: 'libsvtav1', presets: ['4', '6', '8', '10', '12'] },
  { value: 'aom-av1', label: 'AV1 · libaom (软件/慢)', codec: 'av1', kind: 'software', ffmpegName: 'libaom-av1', presets: ['8', '10', '12'], note: '编码速度很慢，实时串流不建议使用' }
]

const AUDIO_CATALOGUE: { value: AudioCodecName; label: string; ffmpegName: string }[] = [
  { value: 'aac', label: 'AAC (原生 ffmpeg 编码器 · 推荐)', ffmpegName: 'aac' },
  { value: 'libmp3lame', label: 'MP3 · libmp3lame', ffmpegName: 'libmp3lame' },
  { value: 'libopus', label: 'Opus · libopus (FLV 兼容性差)', ffmpegName: 'libopus' },
  { value: 'copy', label: '直接复制音轨 (不重编码)', ffmpegName: '' },
  { value: 'none', label: '丢弃音频', ffmpegName: '' }
]

/** Codec preference order for `auto`: hardware first, best supported codec first. */
const AUTO_PREFERENCE: Exclude<EncoderOption['value'], 'auto'>[] = [
  'h264_nvenc',
  'h264_amf',
  'h264_qsv',
  'x264',
  'hevc_nvenc',
  'hevc_amf',
  'hevc_qsv',
  'x265',
  'av1_nvenc',
  'av1_amf',
  'av1_qsv',
  'svt-av1',
  'aom-av1'
]

export function encoderArgFor(choice: EncoderOption['value'], codec: VideoCodecName, available: Set<string>): { name: string; kind: string } {
  if (codec === 'copy') return { name: 'copy', kind: 'copy' }
  if (choice !== 'auto') {
    const def = ENCODER_CATALOGUE.find((e) => e.value === choice)
    if (def && available.has(def.ffmpegName)) return { name: def.ffmpegName, kind: def.kind }
    // Requested encoder missing: fall through to auto selection.
  }
  for (const candidate of AUTO_PREFERENCE) {
    const def = ENCODER_CATALOGUE.find((e) => e.value === candidate)!
    if (def.codec !== codec) continue
    if (available.has(def.ffmpegName)) return { name: def.ffmpegName, kind: def.kind }
  }
  // Last resort: software encoder for the requested codec even if unlisted.
  const fallback = ENCODER_CATALOGUE.find((e) => e.codec === codec && e.kind === 'software')
  return fallback ? { name: fallback.ffmpegName, kind: fallback.kind } : { name: 'libx264', kind: 'software' }
}

/* ------------------------------------------------------------------ *
 * Capability probing
 * ------------------------------------------------------------------ */

const HW_TEST_ARGS = (encoder: string): string[] => [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=320x240:r=30:d=0.1',
  '-frames:v',
  '3',
  '-c:v',
  encoder,
  '-f',
  'null',
  '-'
]

/** Actually exercises a hardware encoder: presence in `-encoders` does not guarantee a working driver. */
async function verifyHardwareEncoder(ffmpeg: string, encoder: string): Promise<boolean> {
  const res = await runProcess(ffmpeg, HW_TEST_ARGS(encoder), 25000)
  return res.code === 0
}

let capabilityCache: { key: string; value: FfmpegCapabilities } | null = null

export async function getCapabilities(
  ffmpegPath: string,
  ffprobePath: string,
  source: FfmpegCapabilities['source'],
  force = false
): Promise<FfmpegCapabilities> {
  const key = `${ffmpegPath}|${ffprobePath}`
  if (!force && capabilityCache && capabilityCache.key === key) return capabilityCache.value

  const warnings: string[] = []
  if (!ffmpegPath) {
    const empty: FfmpegCapabilities = {
      ffmpegPath: '',
      ffprobePath: '',
      ffmpegVersion: '',
      buildConfiguration: '',
      source: 'missing',
      encoders: ENCODER_CATALOGUE.map((e) => ({ value: e.value, label: e.label, codec: e.codec, kind: e.kind, available: false, presets: e.presets })),
      audioEncoders: AUDIO_CATALOGUE.map((a) => ({ value: a.value, label: a.label, available: false })),
      containerFormats: (Object.keys(CONTAINER_MUXER) as ContainerName[]).map((c) => ({ value: c, label: c.toUpperCase(), muxer: CONTAINER_MUXER[c], available: false })),
      hasSubtitleFilter: false,
      hasOverlayFilter: false,
      warnings: ['未找到 ffmpeg，请安装 ffmpeg 或在设置中手动指定路径。']
    }
    return empty
  }

  const [versionRes, encRes, filterRes, muxerRes] = await Promise.all([
    runProcess(ffmpegPath, ['-hide_banner', '-version'], 15000),
    runProcess(ffmpegPath, ['-hide_banner', '-encoders'], 20000),
    runProcess(ffmpegPath, ['-hide_banner', '-filters'], 20000),
    runProcess(ffmpegPath, ['-hide_banner', '-muxers'], 20000)
  ])

  const versionText = versionRes.stdout + versionRes.stderr
  const ffmpegVersion = versionText.split(/\r?\n/)[0]?.trim() ?? ''
  const buildConfiguration = versionText.split(/\r?\n/).find((l) => l.trim().startsWith('configuration:'))?.trim() ?? ''

  const encoderText = encRes.stdout + encRes.stderr
  const filterText = filterRes.stdout + filterRes.stderr
  const muxerText = muxerRes.stdout + muxerRes.stderr

  const listedEncoders = new Set<string>()
  for (const line of encoderText.split(/\r?\n/)) {
    const m = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)
    if (m) listedEncoders.add(m[1])
  }
  const listedFilters = new Set<string>()
  for (const line of filterText.split(/\r?\n/)) {
    // Format: ` FLAGS NAME  INPUTS->OUTPUTS  DESCRIPTION`, where FLAGS is 2-3
    // characters from `T`, `S`, `.` (e.g. `..`, `TS`, `.S`).
    const m = /^\s*[TS.]{2,3}\s+(\S+)\s+\S*->\S+/.exec(line)
    if (m) listedFilters.add(m[1])
  }
  const listedMuxers = new Set<string>()
  for (const line of muxerText.split(/\r?\n/)) {
    const m = /^\s*[E.]\s+(\S+)/.exec(line)
    if (m) listedMuxers.add(m[1])
  }

  if (listedEncoders.size === 0) warnings.push('无法解析 `ffmpeg -encoders` 输出，编码器列表可能不准确。')

  // Verify hardware encoders that ffmpeg claims to have.
  const hwCandidates = ENCODER_CATALOGUE.filter((e) => e.kind !== 'software' && listedEncoders.has(e.ffmpegName))
  const hwResults = await Promise.all(hwCandidates.map((e) => verifyHardwareEncoder(ffmpegPath, e.ffmpegName)))
  const verified = new Set<string>()
  hwCandidates.forEach((e, i) => {
    if (hwResults[i]) verified.add(e.ffmpegName)
  })

  const workingSoftware = new Set([...listedEncoders].filter((n) => ENCODER_CATALOGUE.some((e) => e.ffmpegName === n && e.kind === 'software')))

  const encoders: EncoderOption[] = ENCODER_CATALOGUE.map((def) => {
    const listed = listedEncoders.has(def.ffmpegName)
    const isHw = def.kind !== 'software'
    const available = isHw ? verified.has(def.ffmpegName) : listed
    const option: EncoderOption = {
      value: def.value,
      label: def.label,
      codec: def.codec,
      kind: def.kind,
      available,
      presets: def.presets
    }
    if (def.note) option.note = def.note
    if (isHw && listed && !available) option.note = '驱动不可用或编码器初始化失败'
    if (isHw) option.verified = verified.has(def.ffmpegName)
    if (!listed && !isHw) option.note = 'ffmpeg 构建中未包含该编码器'
    return option
  })

  const availableEncoders = new Set<string>(
    encoders.filter((e) => e.available).map((e) => ENCODER_CATALOGUE.find((d) => d.value === e.value)!.ffmpegName)
  )
  // Ensure at least one software encoder per codec is usable even if the listing parse failed.
  if (availableEncoders.size === 0) {
    for (const name of workingSoftware) availableEncoders.add(name)
    if (availableEncoders.size === 0 && ffmpegVersion) {
      availableEncoders.add('libx264')
      warnings.push('未能确认任何可用视频编码器，已回退到 libx264。')
    }
  }

  const audioEncoders = AUDIO_CATALOGUE.map((a) => ({
    value: a.value,
    label: a.label,
    available: a.ffmpegName === '' || listedEncoders.has(a.ffmpegName)
  }))

  const containerFormats = (Object.keys(CONTAINER_MUXER) as ContainerName[]).map((c) => ({
    value: c,
    label: c.toUpperCase(),
    muxer: CONTAINER_MUXER[c],
    available: listedMuxers.has(CONTAINER_MUXER[c])
  }))

  const hasSubtitleFilter = listedFilters.has('subtitles')
  const hasOverlayFilter = listedFilters.has('overlay')
  if (!hasSubtitleFilter) warnings.push('当前 ffmpeg 未编译 `subtitles` 滤镜（缺少 libass），无法烧录文本字幕。')
  if (!listedEncoders.has('aac')) warnings.push('当前 ffmpeg 未包含 AAC 编码器，RTMP 推流建议改用 MP3。')
  const anyHw = encoders.some((e) => e.kind !== 'software' && e.available)
  if (!anyHw) warnings.push('未检测到可用硬件编码器，将使用软件编码（CPU 占用较高）。')

  const value: FfmpegCapabilities = {
    ffmpegPath,
    ffprobePath,
    ffmpegVersion,
    buildConfiguration,
    source,
    encoders: encoders.map((e) => ({
      ...e,
      available: e.kind === 'software' ? e.available : e.available
    })),
    audioEncoders,
    containerFormats,
    hasSubtitleFilter,
    hasOverlayFilter,
    warnings
  }

  // Stash the resolved encoder name set for the command builder.
  encoderNameSet = availableEncoders
  capabilityCache = { key, value }
  return value
}

/**
 * ffmpeg encoder names confirmed usable for this ffmpeg build/driver combination.
 * Populated by `getCapabilities`.
 */
let encoderNameSet = new Set<string>(['libx264'])
export function getAvailableEncoderNames(): Set<string> {
  return encoderNameSet
}
export function setAvailableEncoderNames(names: Set<string>): void {
  encoderNameSet = names
}
