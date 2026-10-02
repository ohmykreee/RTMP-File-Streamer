import fs from 'node:fs'
import path from 'node:path'
import type { LogEntry } from '@shared/types'
import { ensureDir, logsDir } from './paths'

/**
 * Persists the run log to disk so a problem can still be diagnosed after the
 * app is closed (and after the in-memory buffer — capped at a few thousand
 * lines — has dropped the early entries).
 *
 * Files are JSON Lines, one per app launch:
 *   Data/Logs/session-20261002-032731.log
 *
 * The folder is rotated: when it grows past the total budget the oldest
 * sessions are deleted, so the feature can never eat the disk.
 */
const TOTAL_BUDGET_BYTES = 12 * 1024 * 1024 // 12 MB across all session files
const MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024 // roll over past this per file
const MAX_SESSION_FILES = 20
const FLUSH_INTERVAL_MS = 1200

export interface PersistedLogInfo {
  dir: string
  currentFile: string
  /** Bytes currently used by the whole Logs folder. */
  totalBytes: number
  fileCount: number
  budgetBytes: number
}

let stream: fs.WriteStream | null = null
let currentFile = ''
let buffered: string[] = []
let flushTimer: NodeJS.Timeout | null = null
let bytesWrittenToCurrent = 0
let enabled = true

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** ISO-like local timestamp; each field padded to exactly its natural width. */
export function isoTimestamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${ms}`
}

/** Deletes the oldest session files until the folder fits the budget. */
function rotate(): void {
  const dir = logsDir()
  let entries: { file: string; size: number; mtime: number }[]
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
      .map((f) => {
        const full = path.join(dir, f)
        const st = fs.statSync(full)
        return { file: full, size: st.size, mtime: st.mtimeMs }
      })
  } catch {
    return
  }

  entries.sort((a, b) => a.mtime - b.mtime) // oldest first
  let total = entries.reduce((sum, e) => sum + e.size, 0)
  let count = entries.length

  for (const entry of entries) {
    if (total <= TOTAL_BUDGET_BYTES && count <= MAX_SESSION_FILES) break
    if (entry.file === currentFile) continue // never delete the active file
    try {
      fs.unlinkSync(entry.file)
      total -= entry.size
      count -= 1
    } catch {
      /* ignore files we cannot remove */
    }
  }
}

function openSession(reason: string): void {
  if (!enabled) return
  try {
    const dir = logsDir()
    if (!ensureDir(dir)) {
      enabled = false
      return
    }
    currentFile = path.join(dir, `session-${stamp()}.log`)
    stream = fs.createWriteStream(currentFile, { flags: 'a', encoding: 'utf8' })
    stream.on('error', () => {
      enabled = false
      stream = null
    })
    bytesWrittenToCurrent = 0
    rotate()

    // Open every session with the context needed to interpret it later.
    for (const line of [
      '# RTMP File Streamer log session',
      `# started   : ${isoTimestamp(Date.now())}`,
      `# reason    : ${reason}`,
      `# appRoot   : ${path.dirname(logsDir())}`,
      `# platform  : ${process.platform} ${process.arch} node ${process.versions.node} electron ${process.versions.electron ?? '-'}`
    ]) {
      writeRaw(line)
    }
  } catch {
    enabled = false
  }
}

function writeRaw(line: string): void {
  if (!stream) return
  const payload = `${line}\n`
  bytesWrittenToCurrent += Buffer.byteLength(payload, 'utf8')
  if (bytesWrittenToCurrent > MAX_SINGLE_FILE_BYTES) {
    // Roll over to a new file rather than letting one session grow unbounded.
    stream.end()
    stream = null
    openSession('rollover: previous file reached the size cap')
    // Read the module variable through a local: TS cannot see that openSession
    // may have assigned it again.
    const reopened = stream as fs.WriteStream | null
    if (!reopened) return
    reopened.write(payload)
    return
  }
  stream.write(payload)
}

function flush(): void {
  if (buffered.length === 0) return
  const batch = buffered
  buffered = []
  for (const line of batch) writeRaw(line)
}

/** Converts one entry into a stable JSONL record. */
function serialise(entry: LogEntry, extra?: { itemName?: string; itemPath?: string }): string {
  const record: Record<string, unknown> = {
    ts: isoTimestamp(entry.ts),
    level: entry.level,
    message: entry.message
  }
  if (extra?.itemName) record.item = extra.itemName
  if (extra?.itemPath) record.file = extra.itemPath
  return JSON.stringify(record)
}

export function startLogSession(reason: string): void {
  if (stream) return
  openSession(reason)
}

export function appendLogEntry(entry: LogEntry, extra?: { itemName?: string; itemPath?: string }): void {
  if (!enabled) return
  if (!stream) startLogSession('first entry')
  buffered.push(serialise(entry, extra))
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
}

export function getPersistedLogInfo(): PersistedLogInfo {
  const dir = logsDir()
  let totalBytes = 0
  let fileCount = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('session-') || !f.endsWith('.log')) continue
      totalBytes += fs.statSync(path.join(dir, f)).size
      fileCount += 1
    }
  } catch {
    /* folder may not exist yet */
  }
  return { dir, currentFile, totalBytes, fileCount, budgetBytes: TOTAL_BUDGET_BYTES }
}

export function closeLogSession(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flush()
  if (stream) {
    writeRaw(`# ended     : ${isoTimestamp(Date.now())}`)
    stream.end()
    stream = null
  }
}
