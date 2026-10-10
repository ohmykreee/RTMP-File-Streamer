import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEntry, LogLevel, PersistedLogInfo } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { ChevronRight, FolderOpen, Trash2 } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
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

/** The value that represents "no filter" in the level toggle group. */
const ALL = 'all'

/**
 * Size of a filter button.
 *
 * Matches the 11 px figures around it rather than the registry's default control
 * size: this toolbar is a filter strip inside a 26 px header, not a form.
 */
const SEG_ITEM = 'seg-btn h-[22px] min-w-0 px-2 text-[11px] font-normal aria-pressed:font-medium'

/**
 * The run log drawer.
 *
 * Collapsed it is a single header line — the panel is a diagnostic surface, not
 * something that should cost vertical room while the operator is setting a stream
 * up. The header itself is the toggle, and the level filters are a multi-select
 * toggle group where the levels combine as OR: `警告` + `错误` shows both, and an
 * empty selection is what the `全部` button stands for, which is why pressing it
 * clears the set instead of joining it.
 */
export default function LogPanel({ logs, onClear, expanded, onToggle, onOpenLogsDir }: LogPanelProps): React.JSX.Element {
  const t = useT()
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set())
  const [autoscroll, setAutoscroll] = useState(true)
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const showingAll = levels.size === 0

  /**
   * The selection, and the two refs that keep it consistent with a *controlled*
   * toggle group.
   *
   * The group only reports the value it computed from the props it was rendered
   * with, so two clicks inside one task (which is exactly what a test, or a fast
   * double click, produces) are both computed against the pre-click set. Applying
   * the reported array wholesale would therefore drop the first click. Instead the
   * symmetric difference against the value the group last saw says which button
   * moved, and that single move is applied to the live set.
   */
  const levelsRef = useRef<Set<LogLevel>>(levels)
  const groupValueRef = useRef<string[]>([ALL])
  const groupValue = showingAll ? [ALL] : [...levels]
  groupValueRef.current = groupValue

  const onFilterChange = (next: string[]): void => {
    const before = groupValueRef.current
    const moved = [...next.filter((v) => !before.includes(v)), ...before.filter((v) => !next.includes(v))]
    const picked = new Set(levelsRef.current)
    for (const token of moved) {
      /* 「全部」 is a reset rather than one of the levels, so it clears the set
         whether it was just pressed or just released. */
      if (token === ALL) picked.clear()
      else if (next.includes(token)) picked.add(token as LogLevel)
      else picked.delete(token as LogLevel)
    }
    levelsRef.current = picked
    setLevels(picked)
  }

  const visible = useMemo(() => {
    if (showingAll) return logs
    // `debug` is a level of its own: 「信息」 no longer pulls it in.
    return logs.filter((l) => levels.has(l.level))
  }, [logs, levels, showingAll])

  useEffect(() => {
    if (expanded && autoscroll) endRef.current?.scrollIntoView({ block: 'end' })
  }, [visible, expanded, autoscroll])

  /** Visible / total, so an active filter cannot look like a lost log. */
  const countLabel = showingAll ? `${logs.length}` : `${visible.length}/${logs.length}`

  return (
    <section className={cn('logs', expanded ? 'expanded' : 'collapsed')}>
      <header className="logs-head" onClick={onToggle}>
        <span className="logs-title">
          <ChevronRight className={cn('chevron size-3.5', expanded && 'open')} aria-hidden />
          {t('log.title')}
          <span className="muted small">({countLabel})</span>
        </span>
        {/* The toolbar belongs to the log body: while the panel is collapsed it
            is hidden, and the header is only the affordance to open it. */}
        <div className={cn('logs-actions', !expanded && 'collapsed')} onClick={(e) => e.stopPropagation()}>
          <ToggleGroup className="seg" multiple value={groupValue} onValueChange={onFilterChange} spacing={0}>
            <ToggleGroupItem
              value={ALL}
              /* Sized down to the toolbar it sits in: the registry default (h-8,
                 text-sm) outweighs the plain `.seg-btn` rule, so the compact size
                 has to be stated in the same vocabulary as the component. */
              className={cn(SEG_ITEM, showingAll && 'active aria-pressed:bg-primary aria-pressed:text-primary-foreground')}
              title={t('log.showAllTitle')}
            >
              {t('log.all')}
            </ToggleGroupItem>
            {/* 「全部」 is a different kind of control (it replaces the selection
                rather than joining it), so it is set apart from the levels. */}
            <Separator orientation="vertical" className="seg-sep" aria-hidden="true" />
            {LEVELS.map((l) => (
              <ToggleGroupItem
                key={l.key}
                value={l.key}
                className={cn(SEG_ITEM, levels.has(l.key) && 'active aria-pressed:bg-primary aria-pressed:text-primary-foreground')}
                title={t('log.onlyLevelTitle', { level: t(l.labelKey) })}
              >
                {t(l.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Label htmlFor="log-autoscroll" className="muted flex items-center gap-1.5 text-[11px] font-normal">
            <Switch id="log-autoscroll" size="sm" checked={autoscroll} onCheckedChange={setAutoscroll} />
            {t('log.autoscroll')}
          </Label>
          <Button size="xs" variant="ghost" onClick={onOpenLogsDir} title={t('log.openDirTitle')}>
            <FolderOpen data-icon="inline-start" />
            {t('log.openDir')}
          </Button>
          <Button size="xs" variant="ghost" onClick={onClear}>
            <Trash2 data-icon="inline-start" />
            {t('playlist.clear')}
          </Button>
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
            <p className="muted small px-3 py-1">{t('log.empty')}</p>
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
