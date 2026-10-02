import { useMemo, useState } from 'react'
import type { PlaylistItem, SubtitleMode } from '@shared/types'
import { SUPPORTED_VIDEO_EXT } from '@shared/types'
import { formatBytes, formatDuration, languageLabel } from '../lib/format'

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

const STATUS_LABEL: Record<PlaylistItem['status'], string> = {
  pending: '待串流',
  preparing: '准备中',
  live: '推流中',
  done: '已完成',
  skipped: '已跳过',
  error: '错误'
}

export default function PlaylistPanel(props: PlaylistPanelProps): React.JSX.Element {
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
        if (!dragId && e.dataTransfer?.types?.includes('Files')) setFileDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setFileDrag(false)
      }}
      onDragOver={(e) => {
        if (!dragId && e.dataTransfer?.types?.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (dragId) return
        e.preventDefault()
        setFileDrag(false)
        const paths = videoPathsFromDrop(e)
        if (paths.length > 0) props.onFilesDropped(paths)
      }}
    >
      <header className="panel-head">
        <div>
          <h2>播放列表</h2>
          <p className="muted small">
            {items.length} 个文件 · {formatDuration(totalDuration)} · {formatBytes(totalSize)}
          </p>
        </div>
        <div className="panel-head-actions">
          <button className="btn primary" onClick={props.onAddVideos} disabled={props.busy} title="添加视频文件（可多选）">
            + 视频
          </button>
          <button className="btn ghost" onClick={props.onClear} disabled={props.busy || items.length === 0 || locked} title="清空播放列表">
            清空
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎬</div>
          <p>还没有文件</p>
          <p className="muted small">点击「+ 视频」选择本地文件，或直接把文件拖到这里</p>
          <p className="muted small">同名同目录的字幕 (.srt/.ass/.vtt) 会自动关联</p>
        </div>
      ) : (
        <ol className="playlist-items">
          {items.map((item, idx) => {
            const isCurrent = idx === currentIndex
            const selectedTrack = item.subtitleTracks.find((t) => t.id === item.selectedSubtitleId)
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
                          字幕 ×{item.subtitleTracks.length}
                          {selectedTrack ? ` · ${languageLabel(selectedTrack.language)}` : ''}
                        </span>
                      )}
                      {item.broken && <span className="badge danger">无法读取</span>}
                    </div>
                    {item.error && <div className="pi-error small">{item.error}</div>}
                  </div>
                  <span className={`pi-status st-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                </div>

                <div className="pi-actions">
                  <button
                    className="btn tiny"
                    onClick={() => props.onJump(item.id)}
                    title="从该文件开始串流"
                  >
                    ▶ 从此开始
                  </button>
                  <button
                    className="btn tiny"
                    onClick={() => setExpanded(isOpen ? null : item.id)}
                    disabled={locked}
                    title="字幕与同步设置"
                  >
                    {isOpen ? '收起' : '字幕/同步'}
                  </button>
                  <button className="btn tiny" onClick={() => props.onAttachSubtitle(item.id)} disabled={locked} title="关联外部字幕文件">
                    + 字幕
                  </button>
                  <button className="btn tiny danger" onClick={() => props.onRemove(item.id)} disabled={locked} title="移除">
                    ✕
                  </button>
                </div>

                {isOpen && (
                  <div className="pi-detail">
                    <label className="field">
                      <span>字幕轨道</span>
                      <select
                        value={item.selectedSubtitleId ?? ''}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { selectedSubtitleId: e.target.value || null })}
                      >
                        <option value="">（不使用字幕）</option>
                        {item.subtitleTracks.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.source === 'embedded' ? `内挂 #${t.streamIndex}` : '外部文件'} · {languageLabel(t.language)} · {t.codec}
                            {t.title ? ` · ${t.title}` : ''}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span>字幕处理</span>
                      <select value={item.mode} disabled={locked} onChange={(e) => props.onUpdateItem(item.id, { mode: e.target.value as SubtitleMode })}>
                        <option value="off">关闭</option>
                        <option value="burn">烧录进画面</option>
                        <option value="copy">作为独立轨道复制</option>
                      </select>
                    </label>

                    <label className="field">
                      <span>音视频延迟 (秒)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={item.syncOffsetSec}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { syncOffsetSec: Number(e.target.value) || 0 })}
                        title="正值 = 音视频整体延后播放"
                      />
                    </label>

                    <label className="field">
                      <span>字幕延迟 (秒)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={item.subtitleDelaySec}
                        disabled={locked}
                        onChange={(e) => props.onUpdateItem(item.id, { subtitleDelaySec: Number(e.target.value) || 0 })}
                        title="正值 = 字幕延后出现"
                      />
                    </label>

                    <div className="pi-detail-footer">
                      <button className="btn tiny ghost" onClick={() => props.onReveal(item.path)}>
                        在文件夹中显示
                      </button>
                      <button
                        className="btn tiny ghost"
                        disabled={locked}
                        onClick={() => {
                          props.onUpdateItem(item.id, { syncOffsetSec: 0, subtitleDelaySec: 0 })
                        }}
                      >
                        重置延迟
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {fileDrag && <div className="drop-overlay">松开以添加文件</div>}
    </aside>
  )
}
