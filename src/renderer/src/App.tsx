import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EngineState, PlaylistItem, Preset, RtmpTestResult } from '@shared/types'
import { useStreamer } from './hooks/useStreamer'
import PlaylistPanel from './components/PlaylistPanel'
import SettingsPanel from './components/SettingsPanel'
import Timeline from './components/Timeline'
import LogPanel from './components/LogPanel'
import { formatBitrate, formatDuration } from './lib/format'

const STATE_LABEL: Record<EngineState, string> = {
  idle: '空闲',
  preparing: '准备中',
  connecting: '连接中',
  live: '推流中',
  paused: '已暂停',
  reconnecting: '重连中',
  stopping: '停止中',
  error: '错误'
}

export default function App(): React.JSX.Element {
  const st = useStreamer()
  const [logsOpen, setLogsOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  /**
   * Which preset the current settings came from. Any manual edit clears it, so
   * the select falls back to "自定义" instead of claiming to match a preset.
   */
  const [activePresetId, setActivePresetId] = useState('')

  const { playlist, status, session, capabilities, settings } = st

  const currentItem: PlaylistItem | null = status.currentIndex >= 0 ? (playlist[status.currentIndex] ?? null) : null
  const isActive = status.state !== 'idle' && status.state !== 'error'
  const canStart = playlist.length > 0 && Boolean(capabilities?.ffmpegPath) && !isActive

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      setActionPending(true)
      setActionError(null)
      try {
        await fn()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setActionPending(false)
      }
    },
    []
  )

  /* Settings editors wrap the hook's updates so manual edits deselect the preset. */
  const editVideo = useCallback(
    (patch: Parameters<typeof st.updateVideo>[0]) => {
      setActivePresetId('')
      void st.updateVideo(patch)
    },
    [st]
  )
  const editAudio = useCallback(
    (patch: Parameters<typeof st.updateAudio>[0]) => {
      setActivePresetId('')
      void st.updateAudio(patch)
    },
    [st]
  )
  const editSubtitles = useCallback(
    (patch: Parameters<typeof st.updateSubtitles>[0]) => {
      setActivePresetId('')
      void st.updateSubtitles(patch)
    },
    [st]
  )
  const editOutput = useCallback(
    (patch: Parameters<typeof st.updateOutput>[0]) => {
      setActivePresetId('')
      void st.updateOutput(patch)
    },
    [st]
  )

  const selectPreset = useCallback(
    (preset: Preset) => {
      setActivePresetId(preset.id)
      void run(() => st.applyPreset(preset))
    },
    [run, st]
  )

  /* Warn before closing while a stream is live. */
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      if (isActive) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isActive])

  /* Keyboard shortcuts: space = start/pause, Ctrl+→ = next file. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
      if (typing) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!isActive && canStart) void run(() => st.start())
        else if (status.state === 'live') void run(() => st.pause())
        else if (status.state === 'paused') void run(() => st.resume())
      }
      if (e.ctrlKey && e.code === 'ArrowRight') {
        e.preventDefault()
        if (isActive) void run(() => st.skipNext())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canStart, isActive, run, st, status.state])

  const handleSeek = useCallback(
    (positionSec: number, itemId: string) => {
      const target = playlist.find((i) => i.id === itemId)
      if (!target) return
      const currentId = playlist[status.currentIndex]?.id
      if (currentId !== itemId) void run(() => st.jumpToItem(itemId))
      else void run(() => st.seek(positionSec))
    },
    [playlist, run, st, status.currentIndex]
  )

  const testRtmp = useCallback(
    async (url: string, key: string): Promise<RtmpTestResult> => st.testRtmp(url, key),
    [st]
  )

  const totalDuration = useMemo(() => playlist.reduce((s, i) => s + (i.durationSec || 0), 0), [playlist])
  const progressPct = totalDuration > 0 ? Math.min(100, (status.completedSec / totalDuration) * 100) : 0

  if (st.bridgeMissing) {
    return (
      <div className="boot">
        <div className="boot-error">
          <h2>无法连接到主进程</h2>
          <p>预加载脚本未能加载，界面无法与 FFmpeg 引擎通信。</p>
          <p className="muted small">
            请重新构建应用：先运行 <code>pnpm build</code>，再用 <code>pnpm start</code> 启动；
            开发时使用 <code>pnpm dev</code>。
          </p>
        </div>
      </div>
    )
  }

  if (!st.ready || !settings || !session) {
    return (
      <div className="boot">
        <div className="boot-spinner" />
        <p>正在初始化…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▶</span>
          <div>
            <h1>RTMP 文件串流器</h1>
            <p className="muted small">FFmpeg 本地文件直播推送 · 支持字幕烧录与多文件顺序串流</p>
          </div>
        </div>

        <div className="topbar-right">
          {capabilities && !capabilities.ffmpegPath && (
            <span className="pill danger">未找到 FFmpeg</span>
          )}
          {capabilities?.ffmpegPath && (
            <span className="pill subtle mono" title={capabilities.ffmpegVersion}>
              FFmpeg {capabilities.ffmpegVersion.replace(/^ffmpeg version\s*/, '').split(/\s+/)[0]}
            </span>
          )}
          <span className={`pill state-${status.state}`}>
            <span className={`state-dot state-${status.state}`} />
            {STATE_LABEL[status.state]}
            {status.connected && status.state === 'live' ? ' · 已连接' : ''}
          </span>
        </div>
      </header>

      {actionError && (
        <div className="banner error">
          <span>{actionError}</span>
          <button className="btn tiny ghost" onClick={() => setActionError(null)}>
            关闭
          </button>
        </div>
      )}

      {capabilities && !capabilities.ffmpegPath && (
        <div className="banner warn">
          <span>未检测到 ffmpeg。请先安装 ffmpeg，或在「高级」选项卡中手动指定 ffmpeg 可执行文件路径。</span>
          <button className="btn tiny" onClick={() => void run(st.chooseFfmpeg)}>
            选择 ffmpeg
          </button>
        </div>
      )}

      <main className="workspace">
        <PlaylistPanel
          items={playlist}
          currentIndex={status.currentIndex}
          active={isActive}
          busy={st.busy}
          onAddVideos={() => void run(st.addVideoFiles)}
          onAddPaths={(paths) => void run(() => st.addPaths(paths))}
          onRemove={(id) => void run(() => st.removeItem(id))}
          onClear={() => void run(st.clearPlaylist)}
          onReorder={(ids) => void run(() => st.reorderPlaylist(ids))}
          onJump={(id) => void run(() => st.jumpToItem(id))}
          onAttachSubtitle={(id) => void run(() => st.attachSubtitle(id))}
          onUpdateItem={(id, patch) => void run(() => st.updateItem(id, patch))}
          onReveal={(p) => void st.showItemInFolder(p)}
          onFilesDropped={(paths) => void run(() => st.addPaths(paths))}
        />

        <SettingsPanel
          settings={settings}
          capabilities={capabilities}
          capsLoading={st.capsLoading}
          info={st.info}
          busy={st.busy}
          presets={st.presets}
          activePresetId={activePresetId}
          onSelectPreset={selectPreset}
          onSavePreset={(name) => void run(() => st.savePreset(name))}
          onDeletePreset={(id) => {
            setActivePresetId('')
            void run(() => st.deletePreset(id))
          }}
          onOpenConfigDir={() => void run(st.openConfigDir)}
          onUpdateVideo={editVideo}
          onUpdateAudio={editAudio}
          onUpdateSubtitles={editSubtitles}
          onUpdateOutput={editOutput}
          onSaveSettings={st.saveSettings}
          onChooseFfmpeg={() => void run(st.chooseFfmpeg)}
          onRefreshCapabilities={(force) => void st.refreshCapabilities(force)}
          onTestRtmp={testRtmp}
          onPreviewCommand={() => st.previewCommand()}
        />
      </main>

      <footer className="player">
        <div className="player-info">
          <div className="now-playing">
            <span className="np-label muted small">
              当前 #{status.currentIndex >= 0 ? status.currentIndex + 1 : '—'}/{playlist.length || 0}
            </span>
            <span className="np-name" title={currentItem?.path}>
              {currentItem ? currentItem.name : '未开始串流'}
            </span>
          </div>
          <div className="np-stats mono small">
            <span title="已推流时长 / 当前文件时长">
              {formatDuration(status.positionSec)} / {formatDuration(status.currentDurationSec)}
            </span>
            <span title="编码速度">速度 {status.speed > 0 ? `${status.speed.toFixed(2)}×` : '—'}</span>
            <span title="实时码率">{formatBitrate(status.bitrateKbps)}</span>
            <span title="编码帧率">fps {status.fps > 0 ? status.fps.toFixed(1) : '—'}</span>
            {status.droppedFrames > 0 && <span className="warn">丢帧 {status.droppedFrames}</span>}
            {status.reconnectCount > 0 && <span className="warn">重连 {status.reconnectCount}</span>}
            <span title="会话已运行时长">已运行 {formatDuration(status.elapsedSec)}</span>
          </div>
        </div>

        <Timeline
          items={playlist}
          status={status}
          onSeek={handleSeek}
          onJumpToItem={(id) => void run(() => st.jumpToItem(id))}
          disabled={playlist.length === 0}
        />

        <div className="player-controls">
          <div className="progress-pct mono">{progressPct.toFixed(1)}%</div>
          <div className="controls">
            {!isActive ? (
              <button className="btn primary lg" onClick={() => void run(() => st.start())} disabled={!canStart || actionPending}>
                ▶ 开始串流
              </button>
            ) : (
              <>
                {status.state === 'paused' ? (
                  <button className="btn primary" onClick={() => void run(() => st.resume())} disabled={actionPending}>
                    ▶ 继续
                  </button>
                ) : (
                  <button className="btn" onClick={() => void run(() => st.pause())} disabled={actionPending || status.state !== 'live'}>
                    ⏸ 暂停
                  </button>
                )}
                <button className="btn" onClick={() => void run(() => st.skipNext())} disabled={actionPending} title="Ctrl+→">
                  ⏭ 下一个文件
                </button>
                <button className="btn danger" onClick={() => void run(() => st.stop())} disabled={actionPending}>
                  ⏹ 停止
                </button>
              </>
            )}
            <button className={`btn ghost${logsOpen ? ' active' : ''}`} onClick={() => setLogsOpen((v) => !v)}>
              📋 日志
            </button>
          </div>
        </div>
      </footer>

      <LogPanel logs={st.logs} onClear={() => void st.clearLogs()} expanded={logsOpen} onToggle={() => setLogsOpen((v) => !v)} />
    </div>
  )
}
