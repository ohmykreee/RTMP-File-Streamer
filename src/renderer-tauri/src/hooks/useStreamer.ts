import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  AudioSettings,
  EngineStatus,
  FfmpegCapabilities,
  Language,
  LogEntry,
  ObsWebSocketStatus,
  OutputSettings,
  PlaylistItem,
  Preset,
  PresetsPayload,
  RtmpTestResult,
  SessionSettings,
  SubtitleRenderSettings,
  VideoSettings
} from '@shared/types'
import { LOG_HISTORY_LIMIT } from '@shared/defaults'
import { translatorFor } from '@shared/i18n'

export interface StreamerState {
  ready: boolean
  bridgeMissing: boolean
  info: AppInfo | null
  capabilities: FfmpegCapabilities | null
  capsLoading: boolean
  settings: AppSettings | null
  playlist: PlaylistItem[]
  status: EngineStatus
  logs: LogEntry[]
}

const EMPTY_STATUS: EngineStatus = {
  state: 'idle',
  currentIndex: -1,
  positionSec: 0,
  currentDurationSec: 0,
  completedSec: 0,
  totalDurationSec: 0,
  speed: 0,
  fps: 0,
  bitrateKbps: 0,
  networkKbps: 0,
  networkState: 'ok',
  droppedFrames: 0,
  frame: 0,
  order: [],
  itemStatus: {},
  itemError: {},
  reconnectCount: 0,
  connected: false,
  startedAt: null,
  elapsedSec: 0
}

export function useStreamer() {
  const [ready, setReady] = useState(false)
  const [bridgeMissing, setBridgeMissing] = useState(false)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [capabilities, setCapabilities] = useState<FfmpegCapabilities | null>(null)
  const [capsLoading, setCapsLoading] = useState(true)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([])
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const logBuf = useRef<LogEntry[]>([])
  /**
   * Keys for the log list.
   *
   * `LogEntry.id` is only unique per writer: the main process numbers its own
   * messages while StreamEngine numbers the engine's, and both start at 1. Using
   * those values as React keys makes the two streams collide, which silently
   * drops rows and makes level filtering look like it only covers part of the
   * log. The renderer therefore re-keys every entry it appends with a counter
   * that never restarts.
   */
  const logKey = useRef(0)
  /** Latest settings, for callbacks that must not capture a stale language. */
  const settingsRef = useRef<AppSettings | null>(null)
  settingsRef.current = settings

  /** Stamps renderer-unique keys and trims the history to the shared limit. */
  const appendLogs = useCallback((entries: LogEntry[]): void => {
    if (entries.length === 0) return
    const keyed = entries.map((e) => ({ ...e, id: ++logKey.current }))
    setLogs((prev) => [...prev, ...keyed].slice(-LOG_HISTORY_LIMIT))
  }, [])

  /* ---------------- bootstrap + subscriptions ---------------- */

  /**
   * The preload bridge is normally always present, but if it fails to load the
   * renderer must not crash while merely rendering: every action goes through
   * this guard so the UI can show a helpful message instead of a blank window.
   */
  const bridge = useCallback((): Window['streamer'] | null => {
    const api = typeof window !== 'undefined' ? window.streamer : undefined
    if (!api) return null
    return api
  }, [])

  const requireBridge = useCallback((): Window['streamer'] => {
    const api = bridge()
    if (!api) {
      const language = settingsRef.current?.language ?? 'en'
      throw new Error(translatorFor(language)('app.bridgeMissing'))
    }
    return api
  }, [bridge])

  const refreshCapabilities = useCallback(
    async (force = false): Promise<FfmpegCapabilities | null> => {
      const api = bridge()
      if (!api) {
        setCapsLoading(false)
        return null
      }
      setCapsLoading(true)
      try {
        const caps = await api.getCapabilities(force)
        setCapabilities(caps)
        return caps
      } catch (err) {
        // A refresh triggered by a language switch must not become an unhandled
        // rejection; keep the previous table and report it through the log channel.
        console.error('[capabilities]', err)
        return null
      } finally {
        setCapsLoading(false)
      }
    },
    [bridge]
  )

  useEffect(() => {
    let alive = true
    const api = bridge()
    if (!api) {
      setBridgeMissing(true)
      setCapsLoading(false)
      setReady(true)
      return
    }

    /*
     * Subscribe before asking for the initial snapshots. A status/playlist event
     * that arrives while the snapshot round-trip is in flight is newer than the
     * snapshot, and applying the snapshot afterwards would overwrite it until the
     * next engine report (~0.5 s of visibly stale UI). The flags make the snapshot
     * fill only what no event has already delivered.
     */
    const seen = { status: false, playlist: false, settings: false, log: false }
    const offStatus = api.onStatus((s) => {
      seen.status = true
      setStatus(s)
    })
    const offPlaylist = api.onPlaylist((items) => {
      seen.playlist = true
      setPlaylist(items)
    })
    // The obs-websocket endpoint can rewrite the stream address outside the UI,
    // so the renderer re-reads the settings whenever the main process says so.
    const offSettings = api.onSettings((s) => {
      seen.settings = true
      setSettings(s)
    })
    const offLog = api.onLog((entry) => {
      seen.log = true
      logBuf.current.push(entry)
      if (logBuf.current.length > 60) {
        const batch = logBuf.current
        logBuf.current = []
        appendLogs(batch)
      }
    })
    const flush = window.setInterval(() => {
      if (logBuf.current.length > 0) {
        const batch = logBuf.current
        logBuf.current = []
        appendLogs(batch)
      }
    }, 250)

    void (async () => {
      const [infoRes, settingsRes, playlistRes, statusRes, logsRes] = await Promise.all([
        api.getAppInfo(),
        api.getSettings(),
        api.getPlaylist(),
        api.getStatus(),
        api.getLogs()
      ])
      if (!alive) return
      setInfo(infoRes)
      if (!seen.settings) setSettings(settingsRes)
      if (!seen.playlist) setPlaylist(playlistRes)
      if (!seen.status) setStatus(statusRes)
      // The whole history the main process still holds, so the level filter and
      // the 全部 view cover earlier pushes too, not just what arrived since this
      // window opened. If a live entry arrived first, appending the snapshot
      // afterwards would duplicate it.
      if (!seen.log) appendLogs(logsRes.slice(-LOG_HISTORY_LIMIT))
      setReady(true)
      void refreshCapabilities(false)
    })()

    return () => {
      alive = false
      offStatus()
      offPlaylist()
      offSettings()
      offLog()
      window.clearInterval(flush)
    }
  }, [appendLogs, bridge, refreshCapabilities])

  /* ---------------- settings updates ---------------- */

  const session = settings?.session ?? null

  const ensureSettings = useCallback(async (): Promise<AppSettings> => {
    if (settings) return settings
    const s = await requireBridge().getSettings()
    setSettings(s)
    return s
  }, [requireBridge, settings])

  const patchSession = useCallback(
    async <K extends keyof SessionSettings>(key: K, patch: Partial<SessionSettings[K]>) => {
      const api = requireBridge()
      /*
       * Send only the section that changed. The main process merges it into the
       * current settings, so two edits that overlap (two fields blurred in quick
       * succession) cannot overwrite each other with a stale full-session copy.
       */
      const payload = { session: { [key]: patch } } as unknown as Partial<AppSettings>
      const next = await api.saveSettings(payload)
      setSettings(next)
    },
    [requireBridge]
  )

  const updateVideo = useCallback((patch: Partial<VideoSettings>) => patchSession('video', patch), [patchSession])
  const updateAudio = useCallback((patch: Partial<AudioSettings>) => patchSession('audio', patch), [patchSession])
  const updateSubtitles = useCallback((patch: Partial<SubtitleRenderSettings>) => patchSession('subtitles', patch), [patchSession])
  const updateOutput = useCallback((patch: Partial<OutputSettings>) => patchSession('output', patch), [patchSession])

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await requireBridge().saveSettings(patch)
      setSettings(next)
      return next
    },
    [requireBridge]
  )

  /**
   * Switches the interface language.
   *
   * Its own IPC call rather than a `saveSettings` patch, because it also has to
   * tell the main process to re-render the text it produces itself (log lines,
   * ffmpeg diagnostics) and to record the choice as deliberate, so it stops
   * following the system locale on the next launch. The returned settings replace
   * the local copy like any other update, which is what re-renders the UI.
   */
  const setLanguage = useCallback(
    async (language: Language) => {
      const next = await requireBridge().setLanguage(language)
      setSettings(next)
      // Encoder labels and capability warnings are produced by the main process
      // in the old language; re-read them now rather than after a restart.
      void refreshCapabilities(false)
      return next
    },
    [refreshCapabilities, requireBridge]
  )

  const chooseFfmpeg = useCallback(async () => {
    const api = requireBridge()
    const chosen = await api.pickFfmpeg()
    if (!chosen) return
    const s = await api.getSettings()
    setSettings(s)
    await refreshCapabilities(true)
  }, [refreshCapabilities, requireBridge])

  /* ---------------- obs-websocket control server ---------------- */

  const [obsStatus, setObsStatus] = useState<ObsWebSocketStatus | null>(null)

  const refreshObsStatus = useCallback(async (): Promise<ObsWebSocketStatus | null> => {
    const api = bridge()
    if (!api) return null
    try {
      const status = await api.getObsWebSocketStatus()
      setObsStatus(status)
      return status
    } catch {
      return null
    }
  }, [bridge])

  /**
   * Restarts the control server from the current settings. Called after the
   * enable switch, address or port change, so the badge in the RTMP tab always
   * describes the server that is actually listening.
   */
  const applyObsWebSocket = useCallback(async (): Promise<ObsWebSocketStatus | null> => {
    const api = requireBridge()
    const status = await api.applyObsWebSocket()
    setObsStatus(status)
    return status
  }, [requireBridge])

  useEffect(() => {
    void refreshObsStatus()
    const timer = window.setInterval(() => void refreshObsStatus(), 5000)
    return () => window.clearInterval(timer)
  }, [refreshObsStatus])

  /* ---------------- playlist actions ---------------- */

  const busyDepth = useRef(0)
  const withBusy = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    busyDepth.current += 1
    setBusy(true)
    try {
      return await fn()
    } finally {
      // Counter, not a boolean: a nested call finishing first used to clear the
      // busy state while the outer operation was still running.
      busyDepth.current -= 1
      if (busyDepth.current <= 0) {
        busyDepth.current = 0
        setBusy(false)
      }
    }
  }, [])

  const addVideoFiles = useCallback(async () => {
    const api = requireBridge()
    const paths = await api.pickVideoFiles()
    if (paths.length === 0) return
    await withBusy(() => api.addItems(paths))
  }, [requireBridge, withBusy])

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      const api = requireBridge()
      await withBusy(() => api.addItems(paths))
    },
    [requireBridge, withBusy]
  )

  const attachSubtitle = useCallback(
    async (itemId: string) => {
      const api = requireBridge()
      const paths = await api.pickSubtitleFiles()
      if (paths.length === 0) return
      await withBusy(async () => {
        for (const p of paths) await api.attachSubtitle(itemId, p)
      })
    },
    [requireBridge, withBusy]
  )

  /* ---------------- engine controls ---------------- */

  const removeItem = useCallback((id: string) => requireBridge().removeItem(id), [requireBridge])
  const clearPlaylist = useCallback(() => requireBridge().clearPlaylist(), [requireBridge])
  const reorderPlaylist = useCallback((ids: string[]) => requireBridge().reorderPlaylist(ids), [requireBridge])
  const updateItem = useCallback(
    (id: string, patch: Partial<Pick<PlaylistItem, 'selectedSubtitleId' | 'mode' | 'syncOffsetSec' | 'subtitleDelaySec'>>) =>
      requireBridge().updateItem(id, patch),
    [requireBridge]
  )
  const jumpToItem = useCallback((id: string) => requireBridge().jumpToItem(id), [requireBridge])
  const start = useCallback(() => requireBridge().start(), [requireBridge])
  const stop = useCallback(() => requireBridge().stop(), [requireBridge])
  const skipNext = useCallback(() => requireBridge().skipNext(), [requireBridge])
  const previewCommand = useCallback(() => requireBridge().previewCommand(), [requireBridge])
  const testRtmp = useCallback(
    (url: string, key: string, sessionOverride?: SessionSettings): Promise<RtmpTestResult> =>
      // The session travels with the request: the test must push what is on screen,
      // not a copy of it read back from disk. A caller that has just committed a
      // draft address passes the resulting session explicitly, because this hook's
      // `settings` will not have re-rendered yet.
      requireBridge().testRtmp({ url, streamKey: key, timeoutSec: 25, session: sessionOverride ?? settings?.session }),
    [requireBridge, settings]
  )
  /**
   * Empties the log panel.
   *
   * The renderer holds the list it renders, and the main process keeps its own
   * ring buffer — both have to go, otherwise the panel stays populated (the
   * renderer never learns about the clear) or the next batch of buffered entries
   * refills it from the main-process copy.
   */
  const clearLogs = useCallback(async (): Promise<void> => {
    logBuf.current = []
    setLogs([])
    await requireBridge().clearLogs()
  }, [requireBridge])
  const showItemInFolder = useCallback((p: string) => requireBridge().showItemInFolder(p), [requireBridge])

  const openLogsDir = useCallback(() => requireBridge().openLogsDir(), [requireBridge])
  const getLogFileInfo = useCallback(() => requireBridge().getLogFileInfo(), [requireBridge])

  /**
   * Turns dropped `File` objects into disk paths.
   * Electron no longer exposes `File.path`, so the lookup goes through the
   * preload bridge (`webUtils.getPathForFile`).
   */
  const resolveDroppedPaths = useCallback(
    (files: FileList | File[]): string[] => {
      const api = bridge()
      if (!api) return []
      return api.getPathsForFiles(Array.from(files))
    },
    [bridge]
  )

  /* ---------------- presets ---------------- */

  const [presets, setPresets] = useState<PresetsPayload | null>(null)

  const loadPresets = useCallback(async (): Promise<PresetsPayload | null> => {
    const api = bridge()
    if (!api) return null
    try {
      const payload = await api.getPresets()
      setPresets(payload)
      return payload
    } catch (err) {
      console.error('[presets]', err)
      return null
    }
  }, [bridge])

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  const applyPreset = useCallback(
    async (preset: Preset) => {
      const api = requireBridge()
      // A user preset is a complete snapshot, including where it streams to. An
      // INTERNAL preset is a starting point for encoder settings, so applying one
      // must not replace the user's real address/key or disable obs-websocket —
      // those blocks carry placeholder values in the built-in table.
      if (preset.builtin) {
        const current = await ensureSettings()
        const next = await api.saveSettings({
          session: { ...preset.settings, output: current.session.output }
        })
        setSettings(next)
      } else {
        const next = await api.saveSettings({ session: preset.settings })
        setSettings(next)
      }
    },
    [ensureSettings, requireBridge]
  )

  const savePreset = useCallback(
    async (name: string) => {
      const api = requireBridge()
      const current = await ensureSettings()
      const payload = await api.savePreset(name, current.session)
      setPresets(payload)
      return payload
    },
    [ensureSettings, requireBridge]
  )

  const deletePreset = useCallback(
    async (presetId: string) => {
      const payload = await requireBridge().deletePreset(presetId)
      setPresets(payload)
    },
    [requireBridge]
  )

  const renamePreset = useCallback(
    async (presetId: string, name: string) => {
      const payload = await requireBridge().renamePreset(presetId, name)
      setPresets(payload)
      return payload
    },
    [requireBridge]
  )

  const openDataDir = useCallback(() => requireBridge().openDataDir(), [requireBridge])

  return {
    ready,
    bridgeMissing,
    busy,
    info,
    capabilities,
    capsLoading,
    refreshCapabilities,
    settings,
    session,
    saveSettings,
    setLanguage,
    updateVideo,
    updateAudio,
    updateSubtitles,
    updateOutput,
    chooseFfmpeg,
    playlist,
    status,
    logs,
    addVideoFiles,
    addPaths,
    attachSubtitle,
    removeItem,
    clearPlaylist,
    reorderPlaylist,
    updateItem,
    jumpToItem,
    start,
    stop,
    skipNext,
    previewCommand,
    testRtmp,
    clearLogs,
    showItemInFolder,
    openLogsDir,
    getLogFileInfo,
    resolveDroppedPaths,
    presets,
    applyPreset,
    savePreset,
    deletePreset,
    renamePreset,
    openDataDir,
    obsStatus,
    applyObsWebSocket
  }
}

export type Streamer = ReturnType<typeof useStreamer>
