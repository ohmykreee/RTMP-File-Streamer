import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogLevel, PersistedLogInfo } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { formatClock } from '../lib/format'
import { useT } from '../i18n'

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
 * separately from the level toggles below it in the toolbar. `error` shares its
 * wording with the engine state pill, so it points at that key.
 */
const LEVELS: { key: LogLevel; labelKey: TranslationKey }[] = [
  { key: 'debug', labelKey: 'log.level.debug' },
  { key: 'info', labelKey: 'log.level.info' },
  { key: 'warn', labelKey: 'log.level.warn' },
  { key: 'error', labelKey: 'app.state.error' },
  /* Its own label is the product name, which is the same in every language. */
  { key: 'ffmpeg', labelKey: 'log.level.ffmpeg' }
]

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  ffmpeg: 'FFM'
}

export default function LogPanel({ logs, onClear, expanded, onToggle, onOpenLogsDir }: LogPanelProps): React.JSX.Element {
  const t = useT()
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
          {t('log.title')}
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
              title={t('log.showAllTitle')}
            >
              {t('log.all')}
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
                title={t('log.onlyLevelTitle', { level: t(l.labelKey) })}
              >
                {t(l.labelKey)}
              </button>
            ))}
          </div>
          <label className="mini-check">
            <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
            {t('log.autoscroll')}
          </label>
          <button className="btn tiny ghost" onClick={onOpenLogsDir} title={t('log.openDirTitle')}>
            {t('log.openDir')}
          </button>
          <button className="btn tiny ghost" onClick={onClear}>
            {t('playlist.clear')}
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
            <p className="muted small pad">{t('log.empty')}</p>
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
