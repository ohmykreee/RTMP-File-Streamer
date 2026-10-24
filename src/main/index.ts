import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from 'electron'
import type { AppSettings, LogEntry, PlaylistItem } from '@shared/types'
import { IPC } from '@shared/types'
import { detectStreamProtocol, networkForProtocol } from '@shared/protocol'
import { resolveBinaries } from './ffmpeg/capabilities'
import { registerIpc, type AppServices } from './ipc'
import { ObsWebSocketServer } from './obs/websocket'
import { StreamEngine } from './stream/engine'
import { getSettingsPath, loadSettings, saveSettings, setLanguage as persistLanguage } from './store/settings'
import { getPresetLocation, listPresets } from './store/presets'
import { setupDataPaths } from './store/paths'
import { setStoreErrorHandler } from './store/errors'
import { appendLogEntry, closeLogSession, getPersistedLogInfo, startLogSession } from './store/logger'
import { mainT } from './i18n'
import { collectSecrets, redactText } from './log-redact'
import { EN, JA, ZH, assertCatalogsComplete } from '@shared/i18n'
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

/**
 * Sends to the renderer without assuming it is still alive.
 *
 * A window that is closing can have `mainWindow` non-null but its `webContents`
 * already destroyed; sending then throws from inside a log/status callback, which
 * is the worst place to surface an exception during shutdown.
 */
function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

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
  /*
   * Every producer (engine command lines, ffmpeg's `Output #0 ... to '<target>'`
   * banner, the publisher's own log, the connection test) can print the push
   * target. Redact at this single sink so the persisted file, the panel and any
   * copy made from it are safe without each producer having to remember.
   */
  const safe: LogEntry = {
    ...entry,
    message: redactText(entry.message, collectSecrets(loadSettings().session.output))
  }
  logs.push(safe)
  if (logs.length > LOG_HISTORY_LIMIT) logs.splice(0, logs.length - LOG_HISTORY_LIMIT)
  sendToWindow(IPC.evtLog, safe)
  appendLogEntry(safe, context)
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

/**
 * Store writes that fail are reported into the log; the UI's log panel is the one
 * place a background failure can be seen without a modal on every keystroke.
 */
setStoreErrorHandler((area, error) => {
  pushLog('error', mainT('main.store.writeFailed', { area, error: error instanceof Error ? error.message : String(error) }))
})

/** Set once the control server exists; a settings save touches it when its block changed. */
let onObsSettingsChanged: () => void = () => {}

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
  status: (status) => sendToWindow(IPC.evtStatus, status),
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
    sendToWindow(IPC.evtPlaylist, items)
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
    // The window itself is painted in the palette this setting asks for.
    if (before.theme !== next.theme) syncWindowTheme()
    // Every save (preset apply, obs-websocket's own write, a settings tab) goes
    // through here. Comparing the blocks keeps the listener in step without
    // restarting it on unrelated saves.
    if (JSON.stringify(before.session.output.obsWebSocket) !== JSON.stringify(next.session.output.obsWebSocket)) {
      onObsSettingsChanged()
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
      sendToWindow(IPC.evtPlaylist, playlist)
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
    sendToWindow(IPC.evtPlaylist, playlist)
    pushLog('info', mainT('main.engine.subtitleAttached', { name: item.name, file: path.basename(filePath) }))
    schedulePersist()
    return item
  },
  removeItem: (itemId: string) => {
    playlist = playlist.filter((i) => i.id !== itemId)
    engine.setPlaylist(playlist)
    sendToWindow(IPC.evtPlaylist, playlist)
    schedulePersist()
  },
  clearPlaylist: () => {
    playlist = []
    engine.setPlaylist(playlist)
    sendToWindow(IPC.evtPlaylist, playlist)
    schedulePersist()
  },
  reorder: (orderedIds: string[]) => {
    playlist = reorderById(playlist, orderedIds)
    engine.setPlaylist(playlist)
    sendToWindow(IPC.evtPlaylist, playlist)
    schedulePersist()
  },
  updateItem: (itemId: string, patch: Partial<PlaylistItem>) => {
    const item = playlist.find((i) => i.id === itemId)
    if (!item) return null
    if (patch.selectedSubtitleId !== undefined) item.selectedSubtitleId = patch.selectedSubtitleId
    if (patch.mode !== undefined) item.mode = patch.mode
    if (patch.syncOffsetSec !== undefined) item.syncOffsetSec = Number(patch.syncOffsetSec) || 0
    if (patch.subtitleDelaySec !== undefined) item.subtitleDelaySec = Number(patch.subtitleDelaySec) || 0
    sendToWindow(IPC.evtPlaylist, playlist)
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
    const output = { ...current.session.output, ...patch }
    if (patch.server !== undefined) {
      if (!output.server.trim()) throw new Error(mainT('main.dialog.emptyServer'))
      // The protocol is derived from the address everywhere else; a remote client
      // writing `srt://…` into a session still marked rtmp would otherwise reach
      // ffmpeg as `-f flv srt://…`.
      const protocol = detectStreamProtocol(output.server)
      output.protocol = protocol
      output.network = networkForProtocol(protocol, output.network)
    }
    // One write, not two: the second `saveSettings({})` used to rewrite the same
    // file and broadcast the same settings again.
    const next = saveSettings({ session: { ...current.session, output } })
    sendToWindow(IPC.evtSettings, next)
  },
  engineState: () => engine.getStatus().state,
  startStream: () => engine.start(),
  stopStream: () => engine.stop(),
  log: (level, message) => pushLog(level, message),
  // Read through the settings on every call, so a language switch is reflected in
  // the endpoint's next log line rather than at the next restart.
  t: (key, params) => mainT(key, params)
})

onObsSettingsChanged = () => {
  obs.apply()
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

/**
 * Window background for the appearance in force.
 *
 * The renderer paints its own palette, but the window is created (and resized, and
 * shown before the first frame) with this colour, so it has to match or the app
 * flashes the other theme on startup. `system` asks Electron, which is the same
 * signal the renderer's `prefers-color-scheme` resolves to.
 */
function windowBackground(): string {
  const theme = loadSettings().theme
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? '#09090b' : '#ffffff'
}

/** Keeps the window's own colour in step with the appearance setting. */
function syncWindowTheme(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setBackgroundColor(windowBackground())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    // Follows the appearance setting (see `windowBackground`): the window must not
    // flash the other palette while the first paint is on its way.
    backgroundColor: windowBackground(),
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
    try {
      const scheme = new URL(url).protocol
      // Only ordinary web links go to the system browser. A `file:`/`javascript:`
      // target from a compromised page must not become an arbitrary handler call.
      if (scheme === 'http:' || scheme === 'https:') void shell.openExternal(url)
    } catch {
      /* malformed URL: deny silently */
    }
    return { action: 'deny' }
  })
  // The renderer never navigates away from its own page. Chromium's default for an
  // unhandled file drop is to navigate to the dropped file, which replaced the whole
  // UI while the stream kept running.
  const blockNavigation = (event: Electron.Event, url: string): void => {
    if (mainWindow && url === mainWindow.webContents.getURL()) return
    event.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', blockNavigation)
  mainWindow.webContents.on('will-redirect', blockNavigation)
  /*
   * The renderer's `beforeunload` cancels the close while a session is live, and
   * without this listener Electron simply refuses to close — no prompt, no reason.
   * Ask here, and let the unload proceed only when the user chooses to leave.
   */
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!engine.isActive()) return
    const choice = dialog.showMessageBoxSync(mainWindow as BrowserWindow, {
      type: 'question',
      buttons: [mainT('main.dialog.leaveWhileStreaming'), mainT('main.dialog.stayWhileStreaming')],
      defaultId: 1,
      cancelId: 1,
      title: mainT('main.dialog.closeWhileStreamingTitle'),
      message: mainT('main.dialog.closeWhileStreaming')
    })
    if (choice === 0) event.preventDefault()
  })

  // A packaged build must ignore the dev-server variable even if the environment
  // happens to set it, or a local page could take over the app's bridge.
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
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
    } else {
      // macOS can keep the process alive with no window; a second launch should
      // bring the app back rather than silently do nothing.
      createWindow()
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
    for (const problem of assertCatalogsComplete(EN, { zh: ZH, ja: JA })) {
      pushLog('warn', `[i18n] ${problem}`)
    }

    createWindow()
    registerIpc(services)

    // While the appearance follows the system, the window keeps up with it too — the
    // renderer watches `prefers-color-scheme` for the same reason.
    nativeTheme.on('updated', syncWindowTheme)

    // Bring the control endpoint up if it was left enabled; errors are reported
    // through the log and surfaced in the RTMP tab.
    obs.apply()

    /* Restore the queue and re-validate each entry. */
    const persisted = loadPersistedPlaylist()
    if (persisted.length > 0) {
      playlist = persisted
      engine.setPlaylist(playlist)
      sendToWindow(IPC.evtPlaylist, playlist)
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
          // The file is readable again: clear a stale "unreadable" badge.
          if (item.broken) {
            item.broken = false
            delete item.error
            changed = true
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
          sendToWindow(IPC.evtPlaylist, playlist)
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
      // macOS keeps the process alive after the last window closes, but
      // `window-all-closed` stopped the control endpoint. Bring it back with the
      // saved settings so the remote clients are not permanently orphaned.
      onObsSettingsChanged()
    })
  })

  app.on('window-all-closed', () => {
    obs.stop()
    void engine.stop().catch(() => {}).finally(() => {
      if (process.platform !== 'darwin') app.quit()
    })
  })

  let quitting = false
  let quitFinished = false
  app.on('before-quit', (event) => {
    /*
     * Quitting must not leave ffmpeg pushing. `window-all-closed` covers the
     * ordinary close, but macOS Dock→Quit, a system logout and `app.quit()` do not
     * go through it; Electron does not reap child processes on exit.
     */
    if (quitFinished) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persistPlaylist(playlist)
    pushLog('info', mainT('main.engine.exiting'))
    void engine
      .stop()
      .catch(() => {})
      .finally(() => {
        obs.stop()
        closeLogSession()
        quitFinished = true
        app.quit()
      })
  })
}
