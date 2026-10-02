import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  AudioSettings,
  EngineStatus,
  FfmpegCapabilities,
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
  droppedFrames: 0,
  frame: 0,
  order: [],
  itemStatus: {},
  itemError: {},
  commandLine: '',
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
    if (!api) throw new Error('预加载脚本未加载，无法与主进程通信。请重新构建应用（pnpm build）。')
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
      setSettings(settingsRes)
      setPlaylist(playlistRes)
      setStatus(statusRes)
      setLogs(logsRes.slice(-500))
      setReady(true)
      void refreshCapabilities(false)
    })()

    const offStatus = api.onStatus((s) => setStatus(s))
    const offPlaylist = api.onPlaylist((items) => setPlaylist(items))
    // The obs-websocket endpoint can rewrite the stream address outside the UI,
    // so the renderer re-reads the settings whenever the main process says so.
    const offSettings = api.onSettings((s) => setSettings(s))
    const offLog = api.onLog((entry) => {
      logBuf.current.push(entry)
      if (logBuf.current.length > 60) {
        const batch = logBuf.current
        logBuf.current = []
        setLogs((prev) => [...prev, ...batch].slice(-1500))
      }
    })
    const flush = window.setInterval(() => {
      if (logBuf.current.length > 0) {
        const batch = logBuf.current
        logBuf.current = []
        setLogs((prev) => [...prev, ...batch].slice(-1500))
      }
    }, 250)

    return () => {
      alive = false
      offStatus()
      offPlaylist()
      offSettings()
      offLog()
      window.clearInterval(flush)
    }
  }, [bridge, refreshCapabilities])

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
      const current = await ensureSettings()
      const nextSession: SessionSettings = { ...current.session, [key]: { ...current.session[key], ...patch } }
      const next = await api.saveSettings({ session: nextSession })
      setSettings(next)
    },
    [ensureSettings, requireBridge]
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

  const withBusy = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
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
  const seek = useCallback((positionSec: number) => requireBridge().seek(positionSec), [requireBridge])
  const start = useCallback(() => requireBridge().start(), [requireBridge])
  const pause = useCallback(() => requireBridge().pause(), [requireBridge])
  const resume = useCallback(() => requireBridge().resume(), [requireBridge])
  const stop = useCallback(() => requireBridge().stop(), [requireBridge])
  const skipNext = useCallback(() => requireBridge().skipNext(), [requireBridge])
  const previewCommand = useCallback(() => requireBridge().previewCommand(), [requireBridge])
  const testRtmp = useCallback(
    (url: string, key: string): Promise<RtmpTestResult> => requireBridge().testRtmp({ url, streamKey: key, timeoutSec: 25 }),
    [requireBridge]
  )
  const clearLogs = useCallback(() => requireBridge().clearLogs(), [requireBridge])
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
    const payload = await api.getPresets()
    setPresets(payload)
    return payload
  }, [bridge])

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  const applyPreset = useCallback(
    async (preset: Preset) => {
      const api = requireBridge()
      // A preset replaces every tab's settings at once, so the whole session
      // object is written rather than a per-section patch.
      const next = await api.saveSettings({ session: preset.settings })
      setSettings(next)
    },
    [requireBridge]
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

  const openConfigDir = useCallback(() => requireBridge().openConfigDir(), [requireBridge])

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
    updateVideo,
    updateAudio,
    updateSubtitles,
    updateOutput,
    chooseFfmpeg,
    playlist,
    status,
    logs,
    setLogs,
    addVideoFiles,
    addPaths,
    attachSubtitle,
    removeItem,
    clearPlaylist,
    reorderPlaylist,
    updateItem,
    jumpToItem,
    seek,
    start,
    pause,
    resume,
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
    loadPresets,
    applyPreset,
    savePreset,
    deletePreset,
    openConfigDir,
    obsStatus,
    refreshObsStatus,
    applyObsWebSocket
  }
}

export type Streamer = ReturnType<typeof useStreamer>
