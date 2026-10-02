import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EngineStatus, PlaylistItem } from '@shared/types'
import { formatDuration } from '../lib/format'

interface TimelineProps {
  items: PlaylistItem[]
  status: EngineStatus
  onJumpToItem: (itemId: string) => void
  disabled?: boolean
}

interface Segment {
  item: PlaylistItem
  start: number
  end: number
  duration: number
}

/**
 * A draggable progress bar covering the whole playlist.
 *
 * An RTMP push cannot be scrubbed once frames are on the wire, so the bar only
 * moves BETWEEN playlist entries: dragging to another segment jumps to that file.
 * Seeking inside the current file is not offered at all (it would require
 * restarting the encoder mid-file and splicing it into the published stream).
 */
export default function Timeline({ items, status, onJumpToItem, disabled }: TimelineProps): React.JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null)
  const [dragFraction, setDragFraction] = useState<number | null>(null)
  const [hoverFraction, setHoverFraction] = useState<number | null>(null)
  const draggingRef = useRef(false)

  const segments = useMemo<Segment[]>(() => {
    const durations = items.map((i) => Math.max(0, i.durationSec || 0))
    const total = durations.reduce((a, b) => a + b, 0)
    if (total <= 0) {
      // No durations known yet: give every entry an equal share so the bar still works.
      const share = items.length > 0 ? 1 / items.length : 0
      return items.map((item, idx) => ({ item, start: idx * share, end: (idx + 1) * share, duration: 0 }))
    }
    let cursor = 0
    return items.map((item, idx) => {
      const share = durations[idx] / total
      const seg: Segment = { item, start: cursor, end: cursor + share, duration: durations[idx] }
      cursor += share
      return seg
    })
  }, [items])

  const totalDuration = useMemo(() => items.reduce((sum, i) => sum + Math.max(0, i.durationSec || 0), 0), [items])

  const playedFraction = useMemo(() => {
    if (totalDuration <= 0) return 0
    const done = Math.max(0, status.completedSec)
    return Math.max(0, Math.min(1, done / totalDuration))
  }, [status.completedSec, totalDuration])

  const fraction = dragFraction ?? playedFraction

  const fractionFromEvent = useCallback((clientX: number): number => {
    const el = barRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const resolveTarget = useCallback(
    (frac: number): { itemId: string; positionSec: number; name: string; time: number } | null => {
      if (segments.length === 0) return null
      const seg = segments.find((s) => frac >= s.start && frac < s.end) ?? segments[segments.length - 1]
      const width = Math.max(1e-6, seg.end - seg.start)
      const within = Math.max(0, Math.min(1, (frac - seg.start) / width))
      const position = within * (seg.duration || 0)
      return { itemId: seg.item.id, positionSec: position, name: seg.item.name, time: position }
    },
    [segments]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      setDragFraction(fractionFromEvent(e.clientX))
    }
    const onUp = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      const frac = fractionFromEvent(e.clientX)
      setDragFraction(null)
      const target = resolveTarget(frac)
      if (!target) return
      const currentId = items[status.currentIndex]?.id
      // Only a jump to another entry does anything: releasing inside the entry
      // that is already live is a no-op.
      if (target.itemId !== currentId) onJumpToItem(target.itemId)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [fractionFromEvent, items, onJumpToItem, resolveTarget, status.currentIndex])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || segments.length === 0) return
    draggingRef.current = true
    setDragFraction(fractionFromEvent(e.clientX))
  }

  const preview = resolveTarget(hoverFraction ?? 0)

  return (
    <div className="timeline">
      <div className="timeline-row">
        <span className="timeline-time mono">{formatDuration(status.completedSec)}</span>
        <div
          ref={barRef}
          className={`timeline-bar${disabled ? ' disabled' : ''}${dragFraction !== null ? ' dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => !draggingRef.current && setHoverFraction(fractionFromEvent(e.clientX))}
          onPointerLeave={() => setHoverFraction(null)}
          title={disabled ? '播放列表为空' : '拖动可跳转到任意位置或文件'}
          role="slider"
          aria-label="串流进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalDuration)}
          aria-valuenow={Math.round(status.completedSec)}
          tabIndex={0}
        >
          {segments.map((seg, idx) => {
            const st = seg.item.status
            const isCurrent = idx === status.currentIndex
            return (
              <div
                key={seg.item.id}
                className={`timeline-seg st-${st}${isCurrent ? ' current' : ''}`}
                style={{ left: `${seg.start * 100}%`, width: `${Math.max(0, (seg.end - seg.start) * 100)}%` }}
                title={`${seg.item.name} · ${formatDuration(seg.duration)}`}
              />
            )
          })}
          <div className="timeline-fill" style={{ width: `${fraction * 100}%` }} />
          {items.length > 1 &&
            segments.slice(0, -1).map((seg) => (
              <div key={`div-${seg.item.id}`} className="timeline-divider" style={{ left: `${seg.end * 100}%` }} />
            ))}
          <div className="timeline-handle" style={{ left: `${fraction * 100}%` }} />
          {preview && dragFraction === null && hoverFraction !== null && (
            <div className="timeline-tooltip" style={{ left: `${hoverFraction * 100}%` }}>
              <div className="tt-name">{preview.name}</div>
              <div className="tt-time mono">{formatDuration(preview.time)}</div>
            </div>
          )}
          {preview && dragFraction !== null && (
            <div className="timeline-tooltip dragging" style={{ left: `${dragFraction * 100}%` }}>
              <div className="tt-name">{preview.name}</div>
              <div className="tt-time mono">{formatDuration(preview.time)}</div>
            </div>
          )}
        </div>
        <span className="timeline-time mono">{formatDuration(totalDuration)}</span>
      </div>
    </div>
  )
}
