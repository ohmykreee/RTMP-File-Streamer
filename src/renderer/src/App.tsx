import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EngineState, Language, PersistedLogInfo, PlaylistItem, Preset, RtmpTestResult } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { translatorFor } from '@shared/i18n'
import { useStreamer } from './hooks/useStreamer'
import PlaylistPanel from './components/PlaylistPanel'
import SettingsPanel from './components/SettingsPanel'
import Timeline from './components/Timeline'
import LogPanel from './components/LogPanel'
import LanguageSwitcher from './components/LanguageSwitcher'
import { I18nContext, LanguageContext, type T } from './i18n'
import { formatBitrate, formatDuration } from './lib/format'

/**
 * Engine state pills.
 *
 * Keys rather than text: the label is rendered through `t`, so switching the
 * language re-renders this table too. `preparing` and `live` share their wording
 * with the playlist's per-item badges (see `PlaylistPanel`), which is why they
 * point at the same keys.
 */
const STATE_KEY: Record<EngineState, TranslationKey> = {
  idle: 'app.state.idle',
  preparing: 'app.state.preparing',
  connecting: 'app.state.connecting',
  live: 'app.state.live',
  reconnecting: 'app.state.reconnecting',
  draining: 'app.state.draining',
  stopping: 'app.state.stopping',
  error: 'app.state.error'
}

/** Shown until the settings (and with them the saved language) arrive. */
const BOOT_LANGUAGE: Language = 'en'

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

  /*
   * The active language comes from the settings, which the main process has
   * already resolved (a saved choice, or the system locale on first launch). Until
   * they arrive the UI is behind a spinner, so the fallback never reaches the
   * screen — it only keeps the tree renderable while the first IPC round-trip is
   * in flight.
   */
  const language: Language = settings?.language ?? BOOT_LANGUAGE
  const t = useMemo<T>(() => translatorFor(language), [language])

  /* Keep the document in step with the UI language: it drives font selection and
     line-breaking, it is what a screen reader announces, and the window title is
     taken from the document in Electron. */
  useEffect(() => {
    document.documentElement.lang = language
    document.title = t('app.title')
  }, [language, t])

  const currentItem: PlaylistItem | null = status.currentIndex >= 0 ? (playlist[status.currentIndex] ?? null) : null
  const isActive = status.state !== 'idle' && status.state !== 'error'
  /**
   * While a session runs, every setting is frozen: the encoder command was built
   * from them, and silently ignoring edits mid-stream is worse than locking the
   * controls outright.
   */
  const locked = isActive
  const canStart = playlist.length > 0 && Boolean(capabilities?.ffmpegPath) && !isActive

  /* Persisted log usage, refreshed periodically for the log panel.
     Depends on the stable callback (not the whole hook object): `st` gets a new
     identity on every render, and an effect keyed on it would re-run — and fire
     a fresh IPC round-trip — on every single render, starving the renderer. */
  const [logInfo, setLogInfo] = useState<PersistedLogInfo | null>(null)
  const getLogFileInfo = st.getLogFileInfo
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const info = await getLogFileInfo()
        if (alive) setLogInfo((prev) => (prev && prev.totalBytes === info.totalBytes && prev.currentFile === info.currentFile ? prev : info))
      } catch {
        /* the bridge may not be ready yet */
      }
    }
    void load()
    const timer = window.setInterval(load, 15000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [getLogFileInfo])

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

  /* Settings editors wrap the hook's updates so manual edits deselect the preset.
     While locked they are no-ops: the disabled fieldset stops real interaction,
     but the guard also keeps the model frozen against programmatic events. */
  const editVideo = useCallback(
    (patch: Parameters<typeof st.updateVideo>[0]) => {
      if (locked) return
      setActivePresetId('')
      void st.updateVideo(patch)
    },
    [locked, st]
  )
  const editAudio = useCallback(
    (patch: Parameters<typeof st.updateAudio>[0]) => {
      if (locked) return
      setActivePresetId('')
      void st.updateAudio(patch)
    },
    [locked, st]
  )
  const editSubtitles = useCallback(
    (patch: Parameters<typeof st.updateSubtitles>[0]) => {
      if (locked) return
      setActivePresetId('')
      void st.updateSubtitles(patch)
    },
    [locked, st]
  )
  const editOutput = useCallback(
    (patch: Parameters<typeof st.updateOutput>[0]) => {
      if (locked) return
      setActivePresetId('')
      void st.updateOutput(patch)
    },
    [locked, st]
  )

  const selectPreset = useCallback(
    (preset: Preset) => {
      // Applying a preset would rewrite the settings the running encoder was
      // built from, so it is refused while a session is live.
      if (locked) return
      setActivePresetId(preset.id)
      void run(() => st.applyPreset(preset))
    },
    [locked, run, st]
  )

  /**
   * Switches the interface language.
   *
   * Goes through the dedicated IPC call rather than a settings patch: choosing a
   * language is a decision (it stops the setting from following the system locale
   * on future launches) and the main process has to re-render its own strings in
   * it, which `setLanguage` handles on the way through. The resulting settings are
   * the same shape, so the hook stores them like any other settings update.
   */
  const changeLanguage = useCallback(
    (next: Language) => {
      if (locked) return
      void run(() => st.setLanguage(next))
    },
    [locked, run, st]
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

  /* Keyboard shortcuts: space = start, Ctrl+→ = next file. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
      if (typing) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!isActive && canStart) void run(() => st.start())
      }
      if (e.ctrlKey && e.code === 'ArrowRight') {
        e.preventDefault()
        if (isActive) void run(() => st.skipNext())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canStart, isActive, run, st])

  /**
   * Clicking the bar jumps to that playlist entry.
   *
   * Seeking *inside* a file is deliberately gone: it needs the encoder to restart
   * mid-file, and with the buffered playout that restart also has to be spliced
   * into an already-published stream, which is not something the player can be
   * asked to tolerate. Jumping between files is the supported operation.
   */
  const handleJump = useCallback(
    (itemId: string) => {
      const currentId = playlist[status.currentIndex]?.id
      if (currentId !== itemId) void run(() => st.jumpToItem(itemId))
    },
    [playlist, run, st, status.currentIndex]
  )

  const testRtmp = useCallback(
    async (url: string, key: string): Promise<RtmpTestResult> => st.testRtmp(url, key),
    [st]
  )

  const tree = ((): React.JSX.Element => {
    if (st.bridgeMissing) {
      return (
        <div className="boot">
          <div className="boot-error">
            <h2>{t('app.bootErrorTitle')}</h2>
            <p>{t('app.bootErrorBody')}</p>
            <p className="muted small">
              {t('app.bootErrorRebuild1')}
              <code>pnpm build</code>
              {t('app.bootErrorRebuild2')}
              <code>pnpm start</code>
              {t('app.bootErrorRebuild3')}
            </p>
          </div>
        </div>
      )
    }

    if (!st.ready || !settings || !session) {
      return (
        <div className="boot">
          <div className="boot-spinner" />
          <p>{t('app.initializing')}</p>
        </div>
      )
    }

    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">▶</span>
            <div>
              <h1>{t('app.title')}</h1>
              <p className="muted small">{t('app.tagline')}</p>
            </div>
          </div>

          <div className="topbar-right">
            {capabilities && !capabilities.ffmpegPath && <span className="pill danger">{t('app.ffmpegMissing')}</span>}
            {capabilities?.ffmpegPath && (
              <span className="pill subtle mono" title={capabilities.ffmpegVersion}>
                FFmpeg {capabilities.ffmpegVersion.replace(/^ffmpeg version\s*/, '').split(/\s+/)[0]}
              </span>
            )}
            <span className={`pill state-${status.state}`}>
              <span className={`state-dot state-${status.state}`} />
              {t(STATE_KEY[status.state])}
              {status.connected && status.state === 'live' ? t('app.state.connectedSuffix') : ''}
            </span>
            {/* Last in the row: the language control is always in the same place,
                whatever the state pills to its left are saying. */}
            <LanguageSwitcher language={language} locked={locked} onSelect={changeLanguage} />
          </div>
        </header>

        {actionError && (
          <div className="banner error">
            <span>{actionError}</span>
            <button className="btn tiny ghost" onClick={() => setActionError(null)}>
              {t('app.close')}
            </button>
          </div>
        )}

        {capabilities && !capabilities.ffmpegPath && (
          <div className="banner warn">
            <span>{t('app.ffmpegMissingHint')}</span>
            <button className="btn tiny" onClick={() => void run(st.chooseFfmpeg)}>
              {t('app.chooseFfmpeg')}
            </button>
          </div>
        )}

        <main className="workspace">
          <PlaylistPanel
            items={playlist}
            currentIndex={status.currentIndex}
            active={isActive}
            busy={st.busy}
            locked={locked}
            onAddVideos={() => void run(st.addVideoFiles)}
            onAddPaths={(paths) => void run(() => st.addPaths(paths))}
            onRemove={(id) => void run(() => st.removeItem(id))}
            onClear={() => void run(st.clearPlaylist)}
            onReorder={(ids) => void run(() => st.reorderPlaylist(ids))}
            onJump={(id) => void run(() => st.jumpToItem(id))}
            onAttachSubtitle={(id) => void run(() => st.attachSubtitle(id))}
            onUpdateItem={(id, patch) => void run(() => st.updateItem(id, patch))}
            onReveal={(p) => void st.showItemInFolder(p)}
            onResolveDroppedPaths={st.resolveDroppedPaths}
            onFilesDropped={(paths) => void run(() => st.addPaths(paths))}
          />

          <SettingsPanel
            settings={settings}
            capabilities={capabilities}
            capsLoading={st.capsLoading}
            info={st.info}
            busy={st.busy}
            locked={locked}
            presets={st.presets}
            logInfo={logInfo}
            activePresetId={activePresetId}
            onSelectPreset={selectPreset}
            onSavePreset={(name) => void run(() => st.savePreset(name))}
            onDeletePreset={(id) => {
              setActivePresetId('')
              void run(() => st.deletePreset(id))
            }}
            onRenamePreset={(id, name) => void run(() => st.renamePreset(id, name))}
            onOpenDataDir={() => void run(st.openDataDir)}
            onOpenLogsDir={() => void run(st.openLogsDir)}
            onUpdateVideo={editVideo}
            onUpdateAudio={editAudio}
            onUpdateSubtitles={editSubtitles}
            onUpdateOutput={editOutput}
            onSaveSettings={st.saveSettings}
            onChooseFfmpeg={() => void run(st.chooseFfmpeg)}
            onRefreshCapabilities={(force) => void st.refreshCapabilities(force)}
            onTestRtmp={testRtmp}
            onPreviewCommand={() => st.previewCommand()}
            obsStatus={st.obsStatus}
            onApplyObsWebSocket={st.applyObsWebSocket}
          />
        </main>

        <footer className="player">
          <div className="player-info">
            <div className="now-playing">
              <span className="np-label muted small">
                {t('app.currentIndex', {
                  index: status.currentIndex >= 0 ? status.currentIndex + 1 : '—',
                  total: playlist.length || 0
                })}
              </span>
              <span className="np-name" title={currentItem?.path}>
                {currentItem ? currentItem.name : t('app.nonePlaying')}
              </span>
            </div>
            <div className="np-stats mono small">
              <span title={t('app.statDurationTitle')}>
                {formatDuration(status.positionSec)} / {formatDuration(status.currentDurationSec)}
              </span>
              {/* Buffered mode runs two processes: the figures above describe what has
                  been PUBLISHED, the marked ones describe the ENCODER, which is free
                  to run ahead of real time. */}
              {status.encoder ? (
                <>
                  <span className="warn">
                    {t('app.encoderSpeed', { speed: status.encoder.speed > 0 ? `${status.encoder.speed.toFixed(2)}×` : '—' })}
                  </span>
                  <span className="warn">fps {status.encoder.fps > 0 ? status.encoder.fps.toFixed(1) : '—'}</span>
                  <span className="warn">{formatBitrate(status.encoder.bitrateKbps)}</span>
                  <span title={t('app.statLeadTitle')}>{t('app.bufferLead', { sec: status.encoder.leadSec.toFixed(1) })}</span>
                  <span title={t('app.statSpeedTitle')}>
                    {t('app.publisherSpeed', { speed: status.speed > 0 ? `${status.speed.toFixed(2)}×` : '—' })}
                  </span>
                </>
              ) : (
                <>
                  <span title={t('app.statEncodeSpeedTitle')}>
                    {t('app.speed', { speed: status.speed > 0 ? `${status.speed.toFixed(2)}×` : '—' })}
                  </span>
                  <span title={t('app.statBitrateTitle')}>{formatBitrate(status.bitrateKbps)}</span>
                  <span title={t('app.statFpsTitle')}>fps {status.fps > 0 ? status.fps.toFixed(1) : '—'}</span>
                </>
              )}
              {status.droppedFrames > 0 && <span className="warn">{t('app.droppedFrames', { n: status.droppedFrames })}</span>}
              {status.reconnectCount > 0 && <span className="warn">{t('app.reconnectCount', { n: status.reconnectCount })}</span>}
              <span title={t('app.statElapsedTitle')}>{t('app.elapsed', { duration: formatDuration(status.elapsedSec) })}</span>
            </div>
          </div>

          <Timeline items={playlist} status={status} onJumpToItem={handleJump} disabled={playlist.length === 0} />

          <div className="player-controls">
            {/* The transport buttons only: the progress percentage belongs to the bar
                and is rendered under it (see `Timeline`), not among the buttons. */}
            <div className="controls">
              {!isActive ? (
                <button className="btn primary lg" onClick={() => void run(() => st.start())} disabled={!canStart || actionPending}>
                  {t('app.start')}
                </button>
              ) : (
                <>
                  <button className="btn" onClick={() => void run(() => st.skipNext())} disabled={actionPending} title="Ctrl+→">
                    {t('app.skipNext')}
                  </button>
                  <button className="btn danger" onClick={() => void run(() => st.stop())} disabled={actionPending}>
                    {t('app.stop')}
                  </button>
                </>
              )}
            </div>
          </div>
        </footer>

        <LogPanel
          logs={st.logs}
          onClear={() => void st.clearLogs()}
          expanded={logsOpen}
          onToggle={() => setLogsOpen((v) => !v)}
          logInfo={logInfo}
          onOpenLogsDir={() => void st.openLogsDir()}
        />
      </div>
    )
  })()

  return (
    <I18nContext.Provider value={t}>
      <LanguageContext.Provider value={language}>{tree}</LanguageContext.Provider>
    </I18nContext.Provider>
  )
}
