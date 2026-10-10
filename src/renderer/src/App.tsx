import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EngineState, Language, NetworkState, PersistedLogInfo, PlaylistItem, Preset, RtmpTestResult } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { translatorFor } from '@shared/i18n'
import { CircleAlert, Play, SkipForward, Square, X } from 'lucide-react'
import { cn } from 'cn'
import { Alert, AlertAction, AlertDescription } from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/components/ui/resizable'
import { Spinner } from '@renderer/components/ui/spinner'
import BrandMark from './components/BrandMark'
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

/**
 * CSS class per link verdict, so the measured send rate is the one figure on the
 * status line that carries a judgement: white while the link keeps up, amber when it
 * is running at the edge, red when it is well short of what is being produced. The
 * verdict itself is the engine's (see `EngineStatus.networkState`), not a comparison
 * made here — the renderer has no idea what the session is trying to push.
 */
const NETWORK_CLASS: Record<NetworkState, string> = {
  ok: '',
  warn: 'warn',
  bad: 'bad'
}

/**
 * Colour of the engine-state chip, per state.
 *
 * Utilities rather than stylesheet rules because the badge component carries its own
 * `text-foreground` / `border-border`: a class in `styles.css` would lose to those,
 * so the state has to speak the same language the component does.
 *
 * A running session is GREEN, not red: this app is the thing that is on air, and
 * the question the chip answers is "is it working", not "is something wrong". Red
 * is kept for errors, amber for the states in between, and idle stays as quiet as
 * the metadata chips beside it.
 */
const STATE_CHIP: Record<EngineState, string> = {
  idle: 'border-border bg-card/60 text-muted-foreground',
  preparing: 'border-warn/45 bg-warn/10 text-warn',
  connecting: 'border-warn/45 bg-warn/10 text-warn',
  reconnecting: 'border-warn/45 bg-warn/10 text-warn',
  draining: 'border-warn/45 bg-warn/10 text-warn',
  stopping: 'border-warn/45 bg-warn/10 text-warn',
  live: 'border-ok/50 bg-ok/12 text-ok',
  error: 'border-destructive/50 bg-destructive/12 text-destructive'
}

/**
 * Width of the queue panel, as a percentage of the workspace, when nothing has been
 * dragged yet — and the range the panel is allowed to be dragged within.
 *
 * The value is handed to the panel as a *string*: the library reads a bare number as
 * pixels, so `27` would open the queue at 27 px (and, being under the minimum, pin it
 * there). The constraints below are pixel numbers on purpose — what the queue must not
 * lose is room for a file name, not a fraction of the window.
 */
const DEFAULT_PLAYLIST_PERCENT = '27'
const PLAYLIST_MIN_PX = 210
const PLAYLIST_MAX_PERCENT = '55'
const PLAYLIST_PANEL_ID = 'playlist'

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

  /*
   * Palette. `settings.theme` is `light`, `dark` or `system`, and `.dark` on <html>
   * is what the tokens and the vendored components' `dark:` variants key on.
   * `main.tsx` has already set the class from the OS so the first frame is right;
   * this is the part that knows about the saved preference, and it keeps following
   * the OS live while the preference is `system`.
   */
  const theme = settings?.theme ?? 'system'
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches))
    }
    apply()
    if (theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  /*
   * Queue width: read out of the settings once, when they first arrive.
   *
   * The value is captured rather than passed straight through, because the panel
   * treats its own `defaultSize` as an input: re-feeding the saved number while the
   * user is dragging (which is exactly what saving it does) would let the stored
   * value pull the divider back. The stored value is only ever the one the panel
   * itself reported.
   */
  const initialQueueWidthRef = useRef<string | null>(null)
  if (initialQueueWidthRef.current === null && settings) {
    initialQueueWidthRef.current = String(settings.playlistWidthPercent)
  }
  const initialQueueWidth = initialQueueWidthRef.current ?? DEFAULT_PLAYLIST_PERCENT
  /** The last width this session sent, so a re-layout with the same size is not a write. */
  const lastSavedQueueWidth = useRef<number | null>(null)

  /** Remembers a dragged split. The panel reports once per pointer release. */
  const rememberQueueWidth = useCallback(
    (layout: Record<string, number>, meta: { isUserInteraction: boolean }): void => {
      if (!meta.isUserInteraction) return
      const percent = Math.round((layout[PLAYLIST_PANEL_ID] ?? Number(DEFAULT_PLAYLIST_PERCENT)) * 10) / 10
      if (percent === lastSavedQueueWidth.current) return
      lastSavedQueueWidth.current = percent
      void st.saveSettings({ playlistWidthPercent: percent })
    },
    [st]
  )

  const currentItem: PlaylistItem | null = status.currentIndex >= 0 ? (playlist[status.currentIndex] ?? null) : null
  const isActive = status.state !== 'idle' && status.state !== 'error'
  /**
   * A session needs somewhere to go: the address field can be left empty (the store
   * keeps it that way), and starting without one would only reach ffmpeg as an empty
   * target. The output tab says so in place of the field's hint.
   */
  const hasTarget = (settings?.session.output.server ?? '').trim() !== ''
  /**
   * While a session runs, every setting is frozen: the encoder command was built
   * from them, and silently ignoring edits mid-stream is worse than locking the
   * controls outright.
   */
  const locked = isActive
  const canStart = playlist.length > 0 && Boolean(capabilities?.ffmpegPath) && hasTarget && !isActive

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
          <Alert variant="destructive" className="max-w-lg">
            <CircleAlert />
            <AlertDescription className="flex flex-col gap-2">
              <span className="text-foreground">{t('app.bootErrorTitle')}</span>
              <span>{t('app.bootErrorBody')}</span>
              <span className="text-xs">
                {t('app.bootErrorRebuild1')}
                <code className="mono bg-muted/60 rounded px-1 py-0.5">pnpm build</code>
                {t('app.bootErrorRebuild2')}
                <code className="mono bg-muted/60 rounded px-1 py-0.5">pnpm start</code>
                {t('app.bootErrorRebuild3')}
              </span>
            </AlertDescription>
          </Alert>
        </div>
      )
    }

    if (!st.ready || !settings || !session) {
      return (
        <div className="boot">
          <Spinner className="size-6 text-primary" />
          <p className="text-sm">{t('app.initializing')}</p>
        </div>
      )
    }

    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <BrandMark size={30} className="brand-mark" />
            <div className="brand-text">
              <h1>{t('app.title')}</h1>
              <p className="muted small truncate">{t('app.tagline')}</p>
            </div>
          </div>

          <div className="topbar-right">
            {capabilities && !capabilities.ffmpegPath && (
              <Badge variant="destructive" className="pill danger">
                <CircleAlert data-icon="inline-start" />
                {t('app.ffmpegMissing')}
              </Badge>
            )}
            {capabilities?.ffmpegPath && (
              <Badge variant="outline" className="pill subtle mono text-muted-foreground" title={capabilities.ffmpegVersion}>
                FFmpeg {capabilities.ffmpegVersion.replace(/^ffmpeg version\s*/, '').split(/\s+/)[0]}
              </Badge>
            )}
            <Badge variant="outline" className={cn('pill', `state-${status.state}`, STATE_CHIP[status.state])}>
              <span className={cn('state-dot', `state-${status.state}`)} aria-hidden />
              {t(STATE_KEY[status.state])}
              {status.connected && status.state === 'live' ? t('app.state.connectedSuffix') : ''}
              {/* The level meter is the one animated flourish in the chrome, and it
                  only exists while something is actually going out: it is a state
                  indicator, not decoration. */}
              {isActive && (
                <span className="meter" aria-hidden>
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </Badge>
            {/* Last in the row: the language control is always in the same place,
                whatever the state pills to its left are saying. */}
            <LanguageSwitcher language={language} locked={locked} onSelect={changeLanguage} />
          </div>
        </header>

        {actionError && (
          <Alert variant="destructive" className="banner error rounded-none border-x-0">
            <CircleAlert />
            <AlertDescription className="text-destructive">{actionError}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="xs" onClick={() => setActionError(null)} aria-label={t('app.close')}>
                <X />
              </Button>
            </AlertAction>
          </Alert>
        )}

        {capabilities && !capabilities.ffmpegPath && (
          <Alert className="banner warn rounded-none border-x-0">
            <CircleAlert />
            <AlertDescription className="text-warn">{t('app.ffmpegMissingHint')}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => void run(st.chooseFfmpeg)}>
                {t('app.chooseFfmpeg')}
              </Button>
            </AlertAction>
          </Alert>
        )}

        {/*
          The workspace split is the user's: the queue panel is dragged to whatever
          width the current job needs (the handle is a hairline that grows a grip on
          hover, so it is discoverable without being drawn over the content).
          Percentages are the default; the constraints are pixels, because what the
          queue must not lose is room for a file name, not a fraction of the window.
        */}
        <ResizablePanelGroup className="workspace" orientation="horizontal" onLayoutChanged={rememberQueueWidth}>
          <ResizablePanel
            id={PLAYLIST_PANEL_ID}
            defaultSize={initialQueueWidth}
            minSize={PLAYLIST_MIN_PX}
            maxSize={PLAYLIST_MAX_PERCENT}
            className="min-w-0"
          >
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
          </ResizablePanel>

          {/* The divider is the plain one: the registry handle draws a 1 px line with
              its own wider grab area, and only tints on hover/drag — no grip of its
              own to mistake for a control. */}
          <ResizableHandle className="workspace-handle hover:bg-primary/60 active:bg-primary" />

          <ResizablePanel id="settings" minSize={420} className="min-w-0">
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
              onChangeLanguage={changeLanguage}
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
          </ResizablePanel>
        </ResizablePanelGroup>

        {/*
          The transport: the timeline leads — nothing sits in front of it — with the
          buttons to its right and one line of small figures underneath. The figures
          are the published state (position, what the encoder is doing, what the wire
          is carrying); the buffer strip inside the bar shows the same gap the lead
          figure names, so the bar carries no caption of its own.
        */}
        <footer className="player">
          <div className="player-controls">
            <Timeline items={playlist} status={status} onJumpToItem={handleJump} disabled={playlist.length === 0} />

            <div className="controls">
              {!isActive ? (
                <Button className="btn" size="lg" onClick={() => void run(() => st.start())} disabled={!canStart || actionPending}>
                  <Play data-icon="inline-start" />
                  {t('app.start')}
                </Button>
              ) : (
                <>
                  <Button
                    className="btn"
                    variant="outline"
                    onClick={() => void run(() => st.skipNext())}
                    disabled={actionPending}
                    title="Ctrl+→"
                  >
                    <SkipForward data-icon="inline-start" />
                    {t('app.skipNext')}
                  </Button>
                  <Button className="btn" variant="destructive" onClick={() => void run(() => st.stop())} disabled={actionPending}>
                    <Square data-icon="inline-start" />
                    {t('app.stop')}
                  </Button>
                </>
              )}
            </div>

            <div className="player-info">
              <div className="now-playing">
                <span className="np-label">
                  {t('app.currentIndex', {
                    index: status.currentIndex >= 0 ? status.currentIndex + 1 : '—',
                    total: playlist.length || 0
                  })}
                </span>
                <span className="np-name" title={currentItem?.path}>
                  {currentItem ? currentItem.name : t('app.nonePlaying')}
                </span>
              </div>
              <div className="np-stats">
                <span title={t('app.statDurationTitle')}>
                  {formatDuration(status.positionSec)} / {formatDuration(status.currentDurationSec)}
                </span>
                {/* Buffered mode runs two processes: the figures above describe what has
                    been PUBLISHED, the rest describe the ENCODER, which is free to run
                    ahead of real time.
                    The last figure is the measured egress, i.e. what the link is
                    actually carrying, which nothing else on this line can say: the
                    encoder's bitrate is the rate it was asked for, not the bytes that
                    left. It is also the only figure that changes colour, because it is
                    the only one that can report a problem: the engine compares it with
                    what the session is pushing and says so (see `NetworkState`). */}
                {status.encoder ? (
                  <>
                    <span title={t('app.statEncoderTitle')}>
                      {t('app.encoderProcess', { speed: status.encoder.speed > 0 ? `${status.encoder.speed.toFixed(2)}×` : '—' })}
                    </span>
                    <span title={t('app.statEncoderTitle')}>fps {status.encoder.fps > 0 ? status.encoder.fps.toFixed(1) : '—'}</span>
                    <span title={t('app.statEncoderBitrateTitle')}>{t('app.encoderBitrate', { rate: formatBitrate(status.encoder.bitrateKbps) })}</span>
                    <span title={t('app.statLeadTitle')}>{t('app.bufferLead', { sec: status.encoder.leadSec.toFixed(1) })}</span>
                    <span className={NETWORK_CLASS[status.networkState]} title={t('app.statNetworkTitle')}>
                      {t('app.networkRate', { rate: formatBitrate(status.networkKbps) })}
                    </span>
                  </>
                ) : (
                  <>
                    <span title={t('app.statEncodeSpeedTitle')}>
                      {t('app.speed', { speed: status.speed > 0 ? `${status.speed.toFixed(2)}×` : '—' })}
                    </span>
                    <span title={t('app.statBitrateTitle')}>{t('app.encoderBitrate', { rate: formatBitrate(status.bitrateKbps) })}</span>
                    <span title={t('app.statFpsTitle')}>fps {status.fps > 0 ? status.fps.toFixed(1) : '—'}</span>
                    <span className={NETWORK_CLASS[status.networkState]} title={t('app.statNetworkTitle')}>
                      {t('app.networkRate', { rate: formatBitrate(status.networkKbps) })}
                    </span>
                  </>
                )}
                {status.droppedFrames > 0 && <span className="warn">{t('app.droppedFrames', { n: status.droppedFrames })}</span>}
                {status.reconnectCount > 0 && <span className="warn">{t('app.reconnectCount', { n: status.reconnectCount })}</span>}
                <span title={t('app.statElapsedTitle')}>{t('app.elapsed', { duration: formatDuration(status.elapsedSec) })}</span>
              </div>
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
