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

/**
 * The level filters, in button order.
 *
 * 「全部」 is not one of them: it is the "no filter" state and is handled
 * separately from the level toggles below it in the toolbar.
 */
const LEVELS: { key: LogLevel; label: string }[] = [
  { key: 'debug', label: '调试' },
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

export default function LogPanel({ logs, onClear, expanded, onToggle, onOpenLogsDir }: LogPanelProps): React.JSX.Element {
  /**
   * Selected levels. An empty set means 「全部」 is active, which makes the two
   * states mutually exclusive by construction:
   *   - pressing 「全部」 clears every level button;
   *   - pressing a level leaves the "all" state (there is nothing to unselect
   *     there) and toggles that single level on or off.
   * Levels combine as OR, so 「警告」+「错误」 shows both.
   */
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set())
  const [autoscroll, setAutoscroll] = useState(true)
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const showingAll = levels.size === 0

  const visible = useMemo(() => {
    if (showingAll) return logs
    // `debug` is a level of its own: 「信息」 no longer pulls it in.
    return logs.filter((l) => levels.has(l.level))
  }, [logs, levels, showingAll])

  useEffect(() => {
    if (expanded && autoscroll) endRef.current?.scrollIntoView({ block: 'end' })
  }, [visible, expanded, autoscroll])

  const toggleLevel = (key: LogLevel): void => {
    setLevels((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Visible / total, so an active filter cannot look like a lost log. */
  const countLabel = showingAll ? `${logs.length}` : `${visible.length}/${logs.length}`

  return (
    <section className={`logs${expanded ? ' expanded' : ' collapsed'}`}>
      <header className="logs-head" onClick={onToggle}>
        <span className="logs-title">
          <span className={`chevron${expanded ? ' open' : ''}`}>▸</span>
          运行日志
          <span className="muted small">({countLabel})</span>
        </span>
        {/* The toolbar belongs to the log body: while the panel is collapsed it
            is hidden, and the header is only the affordance to open it. */}
        <div className="logs-actions" hidden={!expanded} onClick={(e) => e.stopPropagation()}>
          <div className="seg">
            <button
              type="button"
              className={`seg-btn${showingAll ? ' active' : ''}`}
              onClick={() => setLevels(new Set())}
              title="显示全部日志（同时取消下面所有等级筛选）"
            >
              全部
            </button>
            {/* 「全部」 is a different kind of control (it replaces the selection
                rather than joining it), so it is set apart from the levels. */}
            <span className="seg-sep" aria-hidden="true" />
            {LEVELS.map((l) => (
              <button
                key={l.key}
                type="button"
                className={`seg-btn${levels.has(l.key) ? ' active' : ''}`}
                onClick={() => toggleLevel(l.key)}
                title={`只看「${l.label}」日志（可多选）`}
              >
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
