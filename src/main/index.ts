import path from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import type { AppSettings, LogEntry, PlaylistItem } from '@shared/types'
import { IPC } from '@shared/types'
import { resolveBinaries } from './ffmpeg/capabilities'
import { registerIpc, type AppServices } from './ipc'
import { ObsWebSocketServer } from './obs/websocket'
import { StreamEngine } from './stream/engine'
import { getSettingsPath, loadSettings, saveSettings } from './store/settings'
import { getPresetLocation, listPresets } from './store/presets'
import { setupDataPaths } from './store/paths'
import { appendLogEntry, closeLogSession, getPersistedLogInfo, startLogSession } from './store/logger'
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
    return probeCached(resolved.ffprobe, filePath)
  }
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
  mergeSettings: (patch: Partial<AppSettings>) => saveSettings(patch),  getPlaylist: () => playlist,
  addItems: async (paths: string[]) => {
    const s = loadSettings()
    const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
    pushLog('info', `正在解析 ${paths.length} 个文件…`)
    const { items, errors } = await createPlaylistItems(resolved.ffprobe, paths, { mode: s.session.subtitles.mode })
    for (const err of errors) pushLog('error', `无法读取「${path.basename(err.path)}」: ${err.message}`)
    if (items.length > 0) {
      playlist = [...playlist, ...items]
      engine.setPlaylist(playlist)
      mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
      schedulePersist()
      const withSubs = items.filter((i) => i.subtitleTracks.length > 0).length
      pushLog('info', `已添加 ${items.length} 个文件${withSubs > 0 ? `，其中 ${withSubs} 个已自动关联字幕` : ''}。`)
    }
    return items
  },
  attachSubtitle: async (itemId: string, filePath: string) => {
    const item = playlist.find((i) => i.id === itemId)
    if (!item) return null
    const s = loadSettings()
    const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
    const ref = await attachSubtitleFile(resolved.ffprobe, item, filePath)
    if (!ref) {
      pushLog('error', `无法解析字幕文件: ${path.basename(filePath)}`)
      return null
    }
    if (!item.subtitleTracks.some((t) => t.id === ref.id)) item.subtitleTracks.push(ref)
    item.selectedSubtitleId = ref.id
    if (item.mode === 'off') item.mode = s.session.subtitles.mode === 'off' ? 'burn' : s.session.subtitles.mode
    engine.setPlaylist(playlist)
    mainWindow?.webContents.send(IPC.evtPlaylist, playlist)
    pushLog('info', `已为「${item.name}」添加字幕 ${path.basename(filePath)}`)
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
  log: (level, message) => pushLog(level, message)
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
    title: 'RTMP 文件串流器',
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
    startLogSession(`app start (pid ${process.pid})`)

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
      pushLog('info', `已恢复上次的播放列表（${persisted.length} 个文件）。`)
      // Refresh durations in the background; files may have moved or changed.
      const s = loadSettings()
      const resolved = resolveBinaries(s.ffmpegPath, s.ffprobePath)
      void (async () => {
        let changed = false
        for (const item of playlist) {
          const info = await probeCached(resolved.ffprobe, item.path)
          if (info.probeError && info.streams.length === 0) {
            item.broken = true
            item.status = 'pending'
            pushLog('warn', `「${item.name}」无法访问：${info.probeError}`)
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
      pushLog('info', `ffmpeg: ${resolved.ffmpeg} (来源: ${resolved.source})`)
      if (resolved.ffprobe) pushLog('debug', `ffprobe: ${resolved.ffprobe}`)
      else pushLog('warn', '未找到 ffprobe，无法读取媒体时长与字幕轨道信息。')
    } else {
      pushLog('error', '未找到 ffmpeg。请安装 ffmpeg 并在“设置”中指定其路径后再开始串流。')
    }
    pushLog('debug', `配置文件: ${getSettingsPath()}`)
    {
      const loc = getPresetLocation()
      pushLog('info', `数据目录: ${loc.dir}${loc.writable ? '' : ' — 不可写，无法保存设置与预设'}`)
      pushLog('debug', `缓存目录: ${dataPaths.cacheDir}`)
      const logInfo = getPersistedLogInfo()
      pushLog(
        'info',
        `日志留存: ${logInfo.currentFile || '（未启用）'}（目录共 ${logInfo.fileCount} 个文件 / ${(logInfo.totalBytes / 1024).toFixed(0)} KB，上限 ${(logInfo.budgetBytes / 1024 / 1024).toFixed(0)} MB）`
      )
      if (dataPaths.migratedFrom) {
        pushLog('info', `已从旧位置迁移设置: ${dataPaths.migratedFrom}`)
      }
      const userCount = listPresets().length
      pushLog('debug', `已加载 ${userCount} 个自定义预设 + ${BUILTIN_PRESETS.length} 个内置预设`)
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
    pushLog('info', '应用退出，日志会话已关闭。')
    closeLogSession()
    obs.stop()
  })
}
