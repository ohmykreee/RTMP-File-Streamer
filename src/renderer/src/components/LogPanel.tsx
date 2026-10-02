import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogLevel, PersistedLogInfo } from '@shared/types'
import { formatClock } from '../lib/format'

interface LogPanelProps {
  logs: LogEntry[]
  onClear: () => void
  expanded: boolean
  onToggle: () => void
  /** Persisted log usage, shown next to the in-memory count. */
  logInfo: PersistedLogInfo | null
  onOpenLogsDir: () => void
}

const LEVELS: { key: LogLevel | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'info', label: '信息' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '错误' },
  { key: 'ffmpeg', label: 'FFmpeg' }
]

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  ffmpeg: 'FFM'
}

export default function LogPanel({ logs, onClear, expanded, onToggle, logInfo, onOpenLogsDir }: LogPanelProps): React.JSX.Element {
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')
  const [autoscroll, setAutoscroll] = useState(true)
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const visible = useMemo(() => {
    if (filter === 'all') return logs
    if (filter === 'info') return logs.filter((l) => l.level === 'info' || l.level === 'debug')
    return logs.filter((l) => l.level === filter)
  }, [logs, filter])

  useEffect(() => {
    if (expanded && autoscroll) endRef.current?.scrollIntoView({ block: 'end' })
  }, [visible, expanded, autoscroll])

  return (
    <section className={`logs${expanded ? ' expanded' : ' collapsed'}`}>
      <header className="logs-head" onClick={onToggle}>
        <span className="logs-title">
          <span className={`chevron${expanded ? ' open' : ''}`}>▸</span>
          运行日志
          <span className="muted small">({logs.length})</span>
          {logInfo && (
            <span className="muted small" title={`日志目录：${logInfo.dir}\n上限 ${(logInfo.budgetBytes / 1024 / 1024).toFixed(0)} MB，超出自动清理最旧日志`}>
              · 留存 {(logInfo.totalBytes / 1024).toFixed(0)} KB
            </span>
          )}
        </span>
        <div className="logs-actions" onClick={(e) => e.stopPropagation()}>
          <div className="seg">
            {LEVELS.map((l) => (
              <button key={l.key} className={`seg-btn${filter === l.key ? ' active' : ''}`} onClick={() => setFilter(l.key)}>
                {l.label}
              </button>
            ))}
          </div>
          <label className="mini-check">
            <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
            自动滚动
          </label>
          <button className="btn tiny ghost" onClick={onOpenLogsDir} title="打开留存日志所在的目录">
            📂 日志目录
          </button>
          <button className="btn tiny ghost" onClick={onClear}>
            清空
          </button>
        </div>
      </header>
      {expanded && (
        <div
          className="logs-body"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            if (atBottom !== autoscroll && atBottom) setAutoscroll(true)
            else if (!atBottom && autoscroll) setAutoscroll(false)
          }}
        >
          {visible.length === 0 ? (
            <p className="muted small pad">暂无日志</p>
          ) : (
            visible.map((entry) => (
              <div key={entry.id} className={`log-line lv-${entry.level}`}>
                <span className="log-time mono">{formatClock(entry.ts)}</span>
                <span className="log-tag">{LEVEL_TAG[entry.level]}</span>
                <span className="log-msg">{entry.message}</span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      )}
    </section>
  )
}
