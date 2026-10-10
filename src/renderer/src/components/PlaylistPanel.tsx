import { useMemo, useState } from 'react'
import type { PlaylistItem, SubtitleMode } from '@shared/types'
import { SUPPORTED_VIDEO_EXT } from '@shared/types'
import { Captions, CircleAlert, FilePlus2, Film, FolderOpen, Info, ListVideo, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@renderer/components/ui/empty'
import { Field, FieldLabel } from '@renderer/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@renderer/components/ui/native-select'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import NumberInput from './NumberInput'
import { formatBytes, formatDuration, languageLabel, STATUS_KEY } from '../lib/format'
import { useT } from '../i18n'

interface PlaylistPanelProps {
  items: PlaylistItem[]
  currentIndex: number
  active: boolean
  busy: boolean
  /** True while a stream is live: mutating the queue would break the session. */
  locked: boolean
  onAddVideos: () => void
  onAddPaths: (paths: string[]) => void
  onRemove: (itemId: string) => void
  onClear: () => void
  onReorder: (orderedIds: string[]) => void
  onJump: (itemId: string) => void
  onAttachSubtitle: (itemId: string) => void
  onUpdateItem: (
    itemId: string,
    patch: Partial<Pick<PlaylistItem, 'selectedSubtitleId' | 'mode' | 'syncOffsetSec' | 'subtitleDelaySec'>>
  ) => void
  onReveal: (filePath: string) => void
  /** Resolves dropped `File` objects to disk paths through the preload bridge. */
  onResolveDroppedPaths: (files: FileList | File[]) => string[]
  onFilesDropped: (paths: string[]) => void
}

/**
 * The queue.
 *
 * One row per file, two lines tall: name and facts on the left, state on the
 * right, actions on a third line that only steps forward on hover or on the live
 * row — a list of twenty files must stay scannable, and four buttons per row is
 * what makes it unreadable. The actions are icon-only, so each one carries both
 * an `aria-label` and a tooltip; `data-action` marks the four roles the e2e suite
 * distinguishes (jumping is allowed while a stream runs, the other three are not).
 */
export default function PlaylistPanel(props: PlaylistPanelProps): React.JSX.Element {
  const t = useT()
  const { items, currentIndex, locked } = props
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fileDrag, setFileDrag] = useState(false)

  const totalDuration = useMemo(() => items.reduce((s, i) => s + (i.durationSec || 0), 0), [items])
  const totalSize = useMemo(() => items.reduce((s, i) => s + (i.size || 0), 0), [items])

  /** Turns a drop event into video paths, resolving `File` → path via the bridge. */
  const videoPathsFromDrop = (e: React.DragEvent): string[] => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return []
    const resolved = props.onResolveDroppedPaths(files)
    return resolved.filter((p) => SUPPORTED_VIDEO_EXT.includes(p.slice(p.lastIndexOf('.')).toLowerCase()))
  }

  const handleDragStart = (itemId: string) => (e: React.DragEvent): void => {
    if (locked) {
      e.preventDefault()
      return
    }
    setDragId(itemId)
    e.dataTransfer.effectAllowed = 'move'
    // Required for Firefox/Chromium to start a drag.
    e.dataTransfer.setData('text/plain', itemId)
  }

  const handleDragOver = (itemId: string) => (e: React.DragEvent): void => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== itemId) setDropTarget(itemId)
  }

  const handleDrop = (itemId: string) => (e: React.DragEvent): void => {
    e.preventDefault()
    setDropTarget(null)
    if (!dragId || dragId === itemId) {
      setDragId(null)
      return
    }
    const ids = items.map((i) => i.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(itemId)
    if (from < 0 || to < 0) {
      setDragId(null)
      return
    }
    ids.splice(to, 0, ids.splice(from, 1)[0])
    setDragId(null)
    props.onReorder(ids)
  }

  /** An icon-only row action: no label text, so it needs both a name and a tooltip. */
  const action = (
    role: string,
    label: string,
    icon: React.JSX.Element,
    onClick: () => void,
    options?: { disabled?: boolean; variant?: 'ghost' | 'destructive' }
  ): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant={options?.variant ?? 'ghost'}
            data-action={role}
            aria-label={label}
            disabled={options?.disabled}
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <aside
      className={`playlist${fileDrag ? ' file-drag' : ''}`}
      onDragEnter={(e) => {
        if (locked) return
        if (!dragId && e.dataTransfer?.types?.includes('Files')) setFileDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setFileDrag(false)
      }}
      onDragOver={(e) => {
        if (locked) return
        if (!dragId && e.dataTransfer?.types?.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (locked || dragId) return
        e.preventDefault()
        setFileDrag(false)
        const paths = videoPathsFromDrop(e)
        if (paths.length > 0) props.onFilesDropped(paths)
      }}
    >
      <header className="panel-head">
        <div className="flex min-w-0 flex-col">
          <h2 className="flex items-center gap-1.5">
            <ListVideo className="size-3.5 text-primary" />
            {t('playlist.title')}
          </h2>
          {/* The counts line is truncated when the panel is dragged narrow; the
              tooltip keeps the whole figure reachable. */}
          <p
            className="muted small truncate"
            title={`${t('playlist.fileCount', { n: items.length })} · ${formatDuration(totalDuration)} · ${formatBytes(totalSize)}`}
          >
            {t('playlist.fileCount', { n: items.length })} · {formatDuration(totalDuration)} · {formatBytes(totalSize)}
          </p>
        </div>
        <div className="panel-head-actions">
          <Button
            size="xs"
            onClick={props.onAddVideos}
            disabled={props.busy || locked}
            title={locked ? t('playlist.addLockedTitle') : t('playlist.addTitle')}
          >
            <Plus data-icon="inline-start" />
            {t('playlist.addVideos')}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            data-action="clear"
            onClick={props.onClear}
            disabled={props.busy || items.length === 0 || locked}
            aria-label={t('playlist.clear')}
            title={t('playlist.clearTitle')}
          >
            <Trash2 />
          </Button>
        </div>
      </header>

      {items.length === 0 ? (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Film />
            </EmptyMedia>
            <EmptyTitle>{t('playlist.emptyTitle')}</EmptyTitle>
            <EmptyDescription className="text-xs">
              {t('playlist.emptyHint')}
              <br />
              {t('playlist.emptySubtitleHint')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="playlist-scroll">
          <ol className="playlist-items">
          {items.map((item, idx) => {
            const isCurrent = idx === currentIndex
            const selectedTrack = item.subtitleTracks.find((track) => track.id === item.selectedSubtitleId)
            const isOpen = expanded === item.id
            return (
              <li
                key={item.id}
                className={`playlist-item st-${item.status}${isCurrent ? ' current' : ''}${dropTarget === item.id ? ' drop-target' : ''}`}
                draggable={!locked}
                onDragStart={handleDragStart(item.id)}
                onDragOver={handleDragOver(item.id)}
                onDragLeave={() => setDropTarget((t) => (t === item.id ? null : t))}
                onDrop={handleDrop(item.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setDropTarget(null)
                }}
              >
                <div className="pi-main">
                  <span className="pi-index">{idx + 1}</span>
                  <div className="pi-info">
                    <div className="pi-name" title={item.path}>
                      {item.name}
                    </div>
                    <div className="pi-meta">
                      <span>{formatDuration(item.durationSec)}</span>
                      <span>{formatBytes(item.size)}</span>
                      {item.subtitleTracks.length > 0 && (
                        <Badge variant="secondary" className="badge">
                          <Captions data-icon="inline-start" />
                          {t('playlist.subtitleCount', { n: item.subtitleTracks.length })}
                          {selectedTrack ? ` · ${languageLabel(selectedTrack.language, t)}` : ''}
                        </Badge>
                      )}
                      {item.broken && (
                        <Badge variant="destructive" className="badge">
                          <CircleAlert data-icon="inline-start" />
                          {t('playlist.unreadable')}
                        </Badge>
                      )}
                    </div>
                    {item.error && <div className="pi-error">{item.error}</div>}
                  </div>
                  <Badge
                    variant={item.status === 'live' ? 'default' : item.status === 'error' ? 'destructive' : 'outline'}
                    className={cn('pi-status', `st-${item.status}`, item.status === 'done' && 'opacity-70')}
                  >
                    {t(STATUS_KEY[item.status])}
                  </Badge>
                </div>

                <div className="pi-actions">
                  {action('jump', t('playlist.startFromHereTitle'), <Play />, () => props.onJump(item.id))}
                  {/* The captions icon is the row's way into its subtitle settings; the
                      external-file picker lives inside that panel, next to the track
                      list it adds to. */}
                  {action(
                    'detail',
                    isOpen ? t('playlist.collapse') : t('playlist.detailTitle'),
                    <Captions className={cn(isOpen && 'text-primary')} />,
                    () => setExpanded(isOpen ? null : item.id),
                    { disabled: locked }
                  )}
                  {action('remove', t('playlist.removeTitle'), <Trash2 />, () => props.onRemove(item.id), {
                    disabled: locked,
                    variant: 'destructive'
                  })}
                </div>

                {isOpen && (
                  <div className="pi-detail">
                    {/* The actions come first: attaching a subtitle file and revealing the
                        media are why the panel gets opened, and at the bottom they were
                        the first thing squeezed out when the queue is dragged narrow. */}
                    <div className="pi-detail-footer">
                      <Button size="xs" variant="ghost" disabled={locked} onClick={() => props.onAttachSubtitle(item.id)}>
                        <FilePlus2 data-icon="inline-start" />
                        {t('playlist.addSubtitle')}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => props.onReveal(item.path)}>
                        <FolderOpen data-icon="inline-start" />
                        {t('playlist.reveal')}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={locked}
                        onClick={() => {
                          props.onUpdateItem(item.id, { syncOffsetSec: 0, subtitleDelaySec: 0 })
                        }}
                      >
                        <RotateCcw data-icon="inline-start" />
                        {t('playlist.resetDelay')}
                      </Button>
                    </div>

                    <Field className="field gap-1">
                      <FieldLabel className="field-label" htmlFor={`sub-track-${item.id}`}>
                        {t('playlist.subtitleTrack')}
                      </FieldLabel>
                      <NativeSelect
                        id={`sub-track-${item.id}`}
                        size="sm"
                        wrapperClassName="w-full"
                        value={item.selectedSubtitleId ?? ''}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { selectedSubtitleId: e.target.value || null })}
                      >
                        <NativeSelectOption value="">{t('playlist.noSubtitle')}</NativeSelectOption>
                        {item.subtitleTracks.map((track) => (
                          <NativeSelectOption key={track.id} value={track.id}>
                            {track.source === 'embedded' ? t('playlist.embeddedTrack', { index: track.streamIndex ?? '?' }) : t('playlist.externalFile')} ·{' '}
                            {languageLabel(track.language, t)} · {track.codec}
                            {track.title ? ` · ${track.title}` : ''}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>

                    <Field className="field gap-1">
                      <FieldLabel className="field-label" htmlFor={`sub-mode-${item.id}`}>
                        {t('playlist.subtitleMode')}
                      </FieldLabel>
                      <NativeSelect
                        id={`sub-mode-${item.id}`}
                        size="sm"
                        wrapperClassName="w-full"
                        value={item.mode}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { mode: e.target.value as SubtitleMode })}
                      >
                        <NativeSelectOption value="off">{t('playlist.modeOff')}</NativeSelectOption>
                        <NativeSelectOption value="burn">{t('playlist.modeBurn')}</NativeSelectOption>
                        <NativeSelectOption value="copy">{t('playlist.modeCopy')}</NativeSelectOption>
                      </NativeSelect>
                    </Field>

                    {/* Burn-in is only impossible for bitmap tracks (PGS/DVD/DVB), and
                        only that combination is worth saying so: the hint appears when
                        the selected track cannot do what the mode asks for, and is
                        absent the rest of the time. The engine skips the burn and logs
                        the same thing. */}
                    {item.mode === 'burn' && selectedTrack?.family === 'bitmap' && (
                      <p className="field-hint warn small">{t('playlist.bitmapBurnHint')}</p>
                    )}

                    <div className="pi-delay-grid">
                      <Field className="field gap-1">
                        <FieldLabel className="field-label" htmlFor={`av-delay-${item.id}`} title={t('playlist.avDelayTitle')}>
                          {t('playlist.avDelay')}
                        </FieldLabel>
                        <NumberInput
                          id={`av-delay-${item.id}`}
                          step="0.1"
                          className="h-7 text-xs"
                          value={item.syncOffsetSec}
                          disabled={locked}
                          onCommit={(syncOffsetSec) => props.onUpdateItem(item.id, { syncOffsetSec })}
                        />
                      </Field>

                      <Field className="field gap-1">
                        <FieldLabel className="field-label" htmlFor={`sub-delay-${item.id}`} title={t('playlist.subtitleDelayTitle')}>
                          {t('playlist.subtitleDelay')}
                        </FieldLabel>
                        <NumberInput
                          id={`sub-delay-${item.id}`}
                          step="0.1"
                          className="h-7 text-xs"
                          value={item.subtitleDelaySec}
                          disabled={locked}
                          onCommit={(subtitleDelaySec) => props.onUpdateItem(item.id, { subtitleDelaySec })}
                        />
                      </Field>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
          </ol>
        </ScrollArea>
      )}
      {fileDrag && !locked && (
        <div className="drop-overlay">
          <span className="flex items-center gap-2">
            <Info className="size-4" />
            {t('playlist.dropToAdd')}
          </span>
        </div>
      )}
    </aside>
  )
}
