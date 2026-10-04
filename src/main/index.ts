import path from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import type { AppSettings, LogEntry, PlaylistItem } from '@shared/types'
import { IPC } from '@shared/types'
import { resolveBinaries } from './ffmpeg/capabilities'
import { registerIpc, type AppServices } from './ipc'
import { ObsWebSocketServer } from './obs/websocket'
import { StreamEngine } from './stream/engine'
import { getSettingsPath, loadSettings, saveSettings, setLanguage as persistLanguage } from './store/settings'
import { getPresetLocation, listPresets } from './store/presets'
import { setupDataPaths } from './store/paths'
import { appendLogEntry, closeLogSession, getPersistedLogInfo, startLogSession } from './store/logger'
import { mainT } from './i18n'
import { EN, TRANSLATIONS, assertCatalogsComplete } from '@shared/i18n'
import { BUILTIN_PRESETS, LOG_HISTORY_LIMIT } from '@shared/defaults'
import {
  attachSubtitleFile,
  createPlaylistItems,
  getCachedMedia,
  loadPersistedPlaylist,
  persistPlaylist,
  probeCached,
  reorderById
} from './store/playlist'

/**
 * Redirect Electron's writable paths into `<app>/Data` before anything reads
 * them, so settings, queue, presets and caches all stay inside the unpacked
 * application folder instead of the user profile.
 */
const dataPaths = setupDataPaths()

let mainWindow: BrowserWindow | null = null

/* ------------------------------------------------------------------ *
 * Application state
 * ------------------------------------------------------------------ */

const logs: LogEntry[] = []
const logSeq = { value: 1 }
let saveTimer: NodeJS.Timeout | null = null

/**
 * In-memory entry: shown in the UI log panel.
 * Persisted entry: appended to `Data/Logs/session-*.log` by the logger.
 *
 * `entry.id` is only unique per writer (this module and StreamEngine keep
 * separate counters), so consumers must not treat it as a list-wide key — the
 * renderer re-keys every entry when it appends it.
 */
function emitLog(entry: LogEntry, context?: { itemName?: string; itemPath?: string }): void {
  /*
   * Debug detail is opt-in. It is by far the largest part of the volume (relay
   * accounting per chunk, per-pass diagnostics, the buffer health line) and both
   * consumers are limited — the panel is a ring buffer, the file a rotated one — so a
   * long unattended run would otherwise spend that room on it. The gate is here, at the
   * single point every entry passes through, because the panel and the file have to
   * agree about what was dropped; `info` and above are never filtered, so the moment
   * the switch is turned off is itself in the log.
   */
  if (entry.level === 'debug' && !loadSettings().debugLogging) return
  logs.push(entry)
  if (logs.length > LOG_HISTORY_LIMIT) logs.splice(0, logs.length - LOG_HISTORY_LIMIT)
  mainWindow?.webContents.send(IPC.evtLog, entry)
  appendLogEntry(entry, context)
}

function pushLog(level: LogEntry['level'], message: string): void {
  emitLog({ id: logSeq.value++, ts: Date.now(), level, message })
}

let playlist: PlaylistItem[] = []

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistPlaylist(playlist)
  }, 700)
}

const engine = new StreamEngine({
  getFfmpegPath: () => resolveBinaries(loadSettings().ffmpegPath, loadSettings().ffprobePath).ffmpeg,
  getSettings: () => loadSettings().session,
  getMedia: (itemPath: string) => getCachedMedia(itemPath),
  probeMedia: async (filePath: string) => {
    const s = loadSettings()
    const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
    return probeCached(resolved.ffprobe, filePath, s.language)
  },
  // Read on every use rather than captured, so a language switch mid-session is
  // reflected in the next log line.
  getLanguage: () => loadSettings().language
})

engine.setSink({
  status: (status) => mainWindow?.webContents.send(IPC.evtStatus, status),
  log: (entry) => {
    // The engine tags entries with the file they belong to so a later reader can
    // tell which item a warning or failure came from.
    const idx = engine.getStatus().currentIndex
    const current = idx >= 0 ? playlist[idx] : undefined
    emitLog(entry, current ? { itemName: current.name, itemPath: current.path } : undefined)
  },
  playlist: (items) => {
    // The engine mutates the same objects we hold, so status changes flow through.
    playlist = items
    mainWindow?.webContents.send(IPC.evtPlaylist, items)
    schedulePersist()
  }
})

const services: AppServices = {
  getWindow: () => mainWindow,
  getSettings: () => loadSettings(),
  mergeSettings: (patch: Partial<AppSettings>) => {
    const before = loadSettings()
    const next = saveSettings(patch)
    // Written at `info` so the log always records which detail level it was collected
    // at — a log with no debug entries should say why, not look like a quiet run.
    if (before.debugLogging !== next.debugLogging) {
      pushLog('info', next.debugLogging ? mainT('main.engine.debugOn') : mainT('main.engine.debugOff'))
    }
    return next
  },
  setLanguage: (language) => persistLanguage(language),
  getPlaylist: () => playlist,
  addItems: async (paths: string[]) => {
    const s = loadSettings()
    const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
    pushLog('info', mainT('main.engine.parsingFiles', { n: paths.length }))
    const { items, errors } = await createPlaylistItems(resolved.ffprobe, paths, {
      mode: s.session.subtitles.mode,
      language: s.language
    })
    for (const err of errors) pushLog('error', mainT('main.engine.unreadableFile', { name: path.basename(err.path), message: err.message }))
    if (items.length > 0) {
      playlist = [...playlist, ...items]
      engine.setPlaylist(playlist)
      mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
      schedulePersist()
      const withSubs = items.filter((i) => i.subtitleTracks.length > 0).length
      pushLog(
        'info',
        mainT('main.engine.addedFiles', {
          n: items.length,
          extra: withSubs > 0 ? mainT('main.engine.addedFilesSubs', { n: withSubs }) : ''
        })
      )
    }
    return items
  },
  attachSubtitle: async (itemId: string, filePath: string) => {
    const item = playlist.find((i) => i.id === itemId)
    if (!item) return null
    const s = loadSettings()
    const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
    const ref = await attachSubtitleFile(resolved.ffprobe, item, filePath, s.language)
    if (!ref) {
      pushLog('error', mainT('main.engine.subtitleUnreadable', { name: path.basename(filePath) }))
      return null
    }
    if (!item.subtitleTracks.some((t) => t.id === ref.id)) item.subtitleTracks.push(ref)
    item.selectedSubtitleId = ref.id
    if (item.mode === 'off') item.mode = s.session.subtitles.mode === 'off' ? 'burn' : s.session.subtitles.mode
    engine.setPlaylist(playlist)
    mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
    pushLog('info', mainT('main.engine.subtitleAttached', { name: item.name, file: path.basename(filePath) }))
    schedulePersist()
    return item
  },
  removeItem: (itemId: string) => {
    playlist = playlist.filter((i) => i.id !== itemId)
    engine.setPlaylist(playlist)
    mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
    schedulePersist()
  },
  clearPlaylist: () => {
    playlist = []
    engine.setPlaylist(playlist)
    mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
    schedulePersist()
  },
  reorder: (orderedIds: string[]) => {
    playlist = reorderById(playlist, orderedIds)
    engine.setPlaylist(playlist)
    mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
    schedulePersist()
  },
  updateItem: (itemId: string, patch: Partial<PlaylistItem>) => {
    const item = playlist.find((i) => i.id === itemId)
    if (!item) return null
    if (patch.selectedSubtitleId !== undefined) item.selectedSubtitleId = patch.selectedSubtitleId
    if (patch.mode !== undefined) item.mode = patch.mode
    if (patch.syncOffsetSec !== undefined) item.syncOffsetSec = Number(patch.syncOffsetSec) || 0
    if (patch.subtitleDelaySec !== undefined) item.subtitleDelaySec = Number(patch.subtitleDelaySec) || 0
    mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
    schedulePersist()
    return item
  },
  logs,
  pushLog,
  engineStatus: () => engine.getStatus(),
  engineStart: () => engine.start(),
  engineStop: () => engine.stop(),
  engineSkipNext: () => engine.skipNext(),
  engineJumpToItem: (itemId: string) => engine.jumpToItem(itemId),
  enginePreviewCommand: () => engine.getCommandPreview(),
  obsStatus: () => obs.status(),
  obsApply: () => obs.apply()
}

/* ------------------------------------------------------------------ *
 * obs-websocket compatible control server
 * ------------------------------------------------------------------ */

/**
 * Remote control for the stream, so OBS clients can drive this app.
 *
 * It shares the engine and the settings store with the UI: `StartStream` starts
 * the same session the 「开始串流」 button does, and `SetStreamServiceSettings`
 * writes the address/key straight into the session settings (which the renderer
 * picks up on its next settings read).
 */
const obs = new ObsWebSocketServer({
  settings: () => loadSettings().session.output.obsWebSocket,
  streamTarget: () => {
    const out = loadSettings().session.output
    return { server: out.server, streamKey: out.streamKey }
  },
  applyStreamTarget: (patch) => {
    const current = loadSettings()
    saveSettings({ session: { ...current.session, output: { ...current.session.output, ...patch } } })
    // The renderer keeps its own copy of the settings, so tell it to re-read
    // them; otherwise the RTMP tab would still show the old destination.
    mainWindow?.webContents.send(IPC.evtSettings, saveSettings({}))
  },
  engineState: () => engine.getStatus().state,
  startStream: () => engine.start(),
  stopStream: () => engine.stop(),
  log: (level, message) => pushLog(level, message),
  // Read through the settings on every call, so a language switch is reflected in
  // the endpoint's next log line rather than at the next restart.
  t: (key, params) => mainT(key, params)
})

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    // The window title, like the interface, follows the language resolved at
    // startup (a saved choice, or the system locale on first launch).
    title: mainT('app.title'),
    webPreferences: {
      // electron-vite emits the preload bundle as ESM (.mjs); that requires sandbox: false.
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The e2e run moves the window off-screen (occluded); without this the
      // renderer's main thread gets throttled and CDP calls stall for seconds.
      backgroundThrottling: process.env.STREAMER_E2E !== '1'
    }
  })

  mainWindow.on('ready-to-show', () => {
    // E2E runs set STREAMER_E2E=1: the window moves off-screen and becomes
    // click-through, so stray physical mouse input cannot perturb a test while
    // CDP keeps full control.
    if (process.env.STREAMER_E2E === '1' && mainWindow) {
      mainWindow.setPosition(-32000, -32000)
      mainWindow.setIgnoreMouseEvents(true)
    }
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

// Single instance: two streaming sessions pushing the same key would fight.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)

    // Start persisting logs before anything can go wrong.
    startLogSession(mainT('main.engine.appStarted', { pid: process.pid }))

    /*
     * Resolve the interface language before the window exists.
     *
     * `loadSettings()` is what detects it (a saved choice wins; otherwise the
     * system locale decides, and the merged result is available immediately), and
     * the window title is built from it — so this has to run first. The log line
     * records which language a first launch landed on, which is the only way to
     * tell "the detection chose wrong" from "the user never set it" afterwards.
     */
    const initial = loadSettings()
    pushLog(
      'info',
      initial.languageSet
        ? mainT('main.engine.languageSaved', { language: initial.language })
        : mainT('main.engine.languageDetected', { language: initial.language })
    )

    /*
     * Report translation drift once per launch.
     *
     * A key missing from a translation is invisible in use — the UI renders that one
     * string in the fallback language, which reads as a styling accident rather than
     * a bug — so the check is run here (and in the unit suite) instead of being left
     * to whoever notices a stray English sentence.
     */
    for (const problem of assertCatalogsComplete(EN, { zh: TRANSLATIONS.zh, ja: TRANSLATIONS.ja })) {
      pushLog('warn', `[i18n] ${problem}`)
    }

    createWindow()
    registerIpc(services)

    // Bring the control endpoint up if it was left enabled; errors are reported
    // through the log and surfaced in the RTMP tab.
    obs.apply()

    /* Restore the queue and re-validate each entry. */
    const persisted = loadPersistedPlaylist()
    if (persisted.length > 0) {
      playlist = persisted
      engine.setPlaylist(playlist)
      mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
      pushLog('info', mainT('main.engine.restoredPlaylist', { n: persisted.length }))
      // Refresh durations in the background; files may have moved or changed.
      const s = loadSettings()
      const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
      void (async () => {
        let changed = false
        for (const item of playlist) {
          const info = await probeCached(resolved.ffprobe, item.path, s.language)
          if (info.probeError && info.streams.length === 0) {
            item.broken = true
            item.status = 'pending'
            pushLog('warn', mainT('main.engine.itemInaccessible', { name: item.name, message: info.probeError }))
            changed = true
            continue
          }
          if (info.durationSec && Math.abs(info.durationSec - item.durationSec) > 0.5) {
            item.durationSec = info.durationSec
            changed = true
          }
          if (item.subtitleTracks.length === 0 && info.subtitleStreams.length > 0) {
            const { embeddedSubtitleRefs } = await import('./ffmpeg/probe')
            item.subtitleTracks = embeddedSubtitleRefs(info)
            if (!item.selectedSubtitleId && item.subtitleTracks[0]) item.selectedSubtitleId = item.subtitleTracks[0].id
            changed = true
          }
        }
        if (changed) {
          engine.setPlaylist(playlist)
          mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
          schedulePersist()
        }
      })()
    }

    const s = loadSettings()
    const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
    if (resolved.ffmpeg) {
      pushLog('info', mainT('main.engine.ffmpegResolved', { path: resolved.ffmpeg, source: resolved.source }))
      if (resolved.ffprobe) pushLog('debug', `ffprobe: ${resolved.ffprobe}`)
      else pushLog('warn', mainT('main.engine.ffprobeMissing'))
    } else {
      pushLog('error', mainT('main.engine.ffmpegMissing'))
    }
    pushLog('debug', mainT('main.engine.configFile', { path: getSettingsPath() }))
    {
      const loc = getPresetLocation()
      pushLog(
        'info',
        mainT('main.engine.dataDir', { dir: loc.dir }) + (loc.writable ? '' : mainT('main.engine.dataDirReadOnly'))
      )
      pushLog('debug', mainT('main.engine.cacheDir', { dir: dataPaths.cacheDir }))
      const logInfo = getPersistedLogInfo()
      pushLog(
        'info',
        mainT('main.engine.logRetention', {
          file: logInfo.currentFile || mainT('main.engine.logRetentionOff'),
          files: logInfo.fileCount,
          kb: (logInfo.totalBytes / 1024).toFixed(0),
          mb: (logInfo.budgetBytes / 1024 / 1024).toFixed(0)
        })
      )
      const userCount = listPresets().length
      pushLog('debug', mainT('main.engine.presetsLoaded', { user: userCount, builtin: BUILTIN_PRESETS.length }))
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    obs.stop()
    void engine.stop().finally(() => {
      if (process.platform !== 'darwin') app.quit()
    })
  })

  app.on('before-quit', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persistPlaylist(playlist)
    pushLog('info', mainT('main.engine.exiting'))
    closeLogSession()
    obs.stop()
  })
}
