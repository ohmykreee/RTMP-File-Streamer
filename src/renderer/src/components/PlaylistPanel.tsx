import { useMemo, useState } from 'react'
import type { PlaylistItem, SubtitleMode } from '@shared/types'
import { SUPPORTED_VIDEO_EXT } from '@shared/types'
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
        <div>
          <h2>{t('playlist.title')}</h2>
          <p className="muted small">
            {t('playlist.fileCount', { n: items.length })} · {formatDuration(totalDuration)} · {formatBytes(totalSize)}
          </p>
        </div>
        <div className="panel-head-actions">
          <button
            className="btn primary"
            onClick={props.onAddVideos}
            disabled={props.busy || locked}
            title={locked ? t('playlist.addLockedTitle') : t('playlist.addTitle')}
          >
            {t('playlist.addVideos')}
          </button>
          <button className="btn ghost" onClick={props.onClear} disabled={props.busy || items.length === 0 || locked} title={t('playlist.clearTitle')}>
            {t('playlist.clear')}
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎬</div>
          <p>{t('playlist.emptyTitle')}</p>
          <p className="muted small">{t('playlist.emptyHint')}</p>
          <p className="muted small">{t('playlist.emptySubtitleHint')}</p>
        </div>
      ) : (
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
                    <div className="pi-meta muted small">
                      <span>{formatDuration(item.durationSec)}</span>
                      <span>{formatBytes(item.size)}</span>
                      {item.subtitleTracks.length > 0 && (
                        <span className="badge subtle">
                          {t('playlist.subtitleCount', { n: item.subtitleTracks.length })}
                          {selectedTrack ? ` · ${languageLabel(selectedTrack.language, t)}` : ''}
                        </span>
                      )}
                      {item.broken && <span className="badge danger">{t('playlist.unreadable')}</span>}
                    </div>
                    {item.error && <div className="pi-error small">{item.error}</div>}
                  </div>
                  <span className={`pi-status st-${item.status}`}>{t(STATUS_KEY[item.status])}</span>
                </div>

                <div className="pi-actions">
                  <button
                    className="btn tiny"
                    onClick={() => props.onJump(item.id)}
                    title={t('playlist.startFromHereTitle')}
                  >
                    {t('playlist.startFromHere')}
                  </button>
                  <button
                    className="btn tiny"
                    onClick={() => setExpanded(isOpen ? null : item.id)}
                    disabled={locked}
                    title={t('playlist.detailTitle')}
                  >
                    {isOpen ? t('playlist.collapse') : t('playlist.subtitleSync')}
                  </button>
                  <button
                    className="btn tiny"
                    onClick={() => props.onAttachSubtitle(item.id)}
                    disabled={locked}
                    title={t('playlist.attachSubtitleTitle')}
                  >
                    {t('playlist.addSubtitle')}
                  </button>
                  <button className="btn tiny danger" onClick={() => props.onRemove(item.id)} disabled={locked} title={t('playlist.removeTitle')}>
                    ✕
                  </button>
                </div>

                {isOpen && (
                  <div className="pi-detail">
                    <label className="field">
                      <span>{t('playlist.subtitleTrack')}</span>
                      <select
                        value={item.selectedSubtitleId ?? ''}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { selectedSubtitleId: e.target.value || null })}
                      >
                        <option value="">{t('playlist.noSubtitle')}</option>
                        {item.subtitleTracks.map((track) => (
                          <option key={track.id} value={track.id}>
                            {track.source === 'embedded' ? t('playlist.embeddedTrack', { index: track.streamIndex ?? '?' }) : t('playlist.externalFile')} ·{' '}
                            {languageLabel(track.language, t)} · {track.codec}
                            {track.title ? ` · ${track.title}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span>{t('playlist.subtitleMode')}</span>
                      <select value={item.mode} disabled={locked} onChange={(e) => props.onUpdateItem(item.id, { mode: e.target.value as SubtitleMode })}>
                        <option value="off">{t('playlist.modeOff')}</option>
                        <option value="burn">{t('playlist.modeBurn')}</option>
                        <option value="copy">{t('playlist.modeCopy')}</option>
                      </select>
                    </label>

                    <label className="field">
                      <span>{t('playlist.avDelay')}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={item.syncOffsetSec}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { syncOffsetSec: Number(e.target.value) || 0 })}
                        title={t('playlist.avDelayTitle')}
                      />
                    </label>

                    <label className="field">
                      <span>{t('playlist.subtitleDelay')}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={item.subtitleDelaySec}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { subtitleDelaySec: Number(e.target.value) || 0 })}
                        title={t('playlist.subtitleDelayTitle')}
                      />
                    </label>

                    <div className="pi-detail-footer">
                      <button className="btn tiny ghost" onClick={() => props.onReveal(item.path)}>
                        {t('playlist.reveal')}
                      </button>
                      <button
                        className="btn tiny ghost"
                        disabled={locked}
                        onClick={() => {
                          props.onUpdateItem(item.id, { syncOffsetSec: 0, subtitleDelaySec: 0 })
                        }}
                      >
                        {t('playlist.resetDelay')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {fileDrag && !locked && <div className="drop-overlay">{t('playlist.dropToAdd')}</div>}
    </aside>
  )
}
