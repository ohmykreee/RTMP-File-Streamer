import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfo,
  AppSettings,
  EngineStatus,
  FfmpegCapabilities,
  LogEntry,
  MediaInfo,
  ObsWebSocketStatus,
  PersistedLogInfo,
  PlaylistItem,
  PresetsPayload,
  ProbeResult,
  RtmpTestRequest,
  RtmpTestResult,
  StreamerApi,
  SubtitleTrackRef
} from '@shared/types'
import { IPC } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

const api: StreamerApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo) as Promise<AppInfo>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<AppSettings>,
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch) as Promise<AppSettings>,
  getCapabilities: (force) => ipcRenderer.invoke(IPC.getCapabilities, force ?? false) as Promise<FfmpegCapabilities>,
  pickFfmpeg: () => ipcRenderer.invoke(IPC.pickFfmpeg) as Promise<string | null>,
  pickVideoFiles: () => ipcRenderer.invoke(IPC.pickVideoFiles) as Promise<string[]>,
  pickSubtitleFiles: () => ipcRenderer.invoke(IPC.pickSubtitleFiles) as Promise<string[]>,
  probe: (filePath) => ipcRenderer.invoke(IPC.probe, filePath) as Promise<ProbeResult>,
  addItems: (paths) => ipcRenderer.invoke(IPC.addItems, paths) as Promise<PlaylistItem[]>,
  attachSubtitle: (itemId, filePath) => ipcRenderer.invoke(IPC.attachSubtitle, itemId, filePath) as Promise<PlaylistItem | null>,
  removeItem: (itemId) => ipcRenderer.invoke(IPC.removeItem, itemId) as Promise<void>,
  clearPlaylist: () => ipcRenderer.invoke(IPC.clearPlaylist) as Promise<void>,
  reorderPlaylist: (orderedIds) => ipcRenderer.invoke(IPC.reorderPlaylist, orderedIds) as Promise<void>,
  updateItem: (itemId, patch) => ipcRenderer.invoke(IPC.updateItem, itemId, patch) as Promise<PlaylistItem | null>,
  getPlaylist: () => ipcRenderer.invoke(IPC.getPlaylist) as Promise<PlaylistItem[]>,
  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<EngineStatus>,
  getLogs: () => ipcRenderer.invoke(IPC.getLogs) as Promise<LogEntry[]>,
  start: () => ipcRenderer.invoke(IPC.start) as Promise<EngineStatus>,
  stop: () => ipcRenderer.invoke(IPC.stop) as Promise<EngineStatus>,
  skipNext: () => ipcRenderer.invoke(IPC.skipNext) as Promise<EngineStatus>,
  seek: (positionSec) => ipcRenderer.invoke(IPC.seek, positionSec) as Promise<EngineStatus>,
  jumpToItem: (itemId) => ipcRenderer.invoke(IPC.jumpToItem, itemId) as Promise<EngineStatus>,
  testRtmp: (req: RtmpTestRequest) => ipcRenderer.invoke(IPC.testRtmp, req) as Promise<RtmpTestResult>,
  clearLogs: () => ipcRenderer.invoke(IPC.clearLogs) as Promise<void>,
  showItemInFolder: (filePath) => ipcRenderer.invoke(IPC.showItemInFolder, filePath) as Promise<void>,
  getPresets: () => ipcRenderer.invoke(IPC.getPresets) as Promise<PresetsPayload>,
  savePreset: (name, settings) => ipcRenderer.invoke(IPC.savePreset, name, settings) as Promise<PresetsPayload>,
  deletePreset: (presetId) => ipcRenderer.invoke(IPC.deletePreset, presetId) as Promise<PresetsPayload>,
  renamePreset: (presetId, name) => ipcRenderer.invoke(IPC.renamePreset, presetId, name) as Promise<PresetsPayload>,
  openConfigDir: () => ipcRenderer.invoke(IPC.openConfigDir) as Promise<void>,
  openLogsDir: () => ipcRenderer.invoke(IPC.openLogsDir) as Promise<void>,
  getLogFileInfo: () => ipcRenderer.invoke(IPC.getLogFileInfo) as Promise<PersistedLogInfo>,
  getObsWebSocketStatus: () => ipcRenderer.invoke(IPC.getObsWebSocketStatus) as Promise<ObsWebSocketStatus>,
  applyObsWebSocket: () => ipcRenderer.invoke(IPC.applyObsWebSocket) as Promise<ObsWebSocketStatus>,
  /**
   * Resolves the on-disk paths of dropped `File` objects.
   *
   * Electron 32 removed `File.path`, so the renderer cannot learn the path on
   * its own. `webUtils.getPathForFile` must run on the real File object, which
   * only exists in the renderer's world — contextBridge passes the object
   * through to this function, so the lookup happens here.
   */
  getPathsForFiles: (files: File[]): string[] => {
    const out: string[] = []
    for (const file of files) {
      try {
        const p = webUtils.getPathForFile(file)
        if (p) out.push(p)
      } catch {
        /* skip entries without a resolvable path */
      }
    }
    return out
  },
  previewCommand: () => ipcRenderer.invoke(IPC.previewCommand) as Promise<string>,
  onStatus: (cb) => subscribe<EngineStatus>(IPC.evtStatus, cb),
  onLog: (cb) => subscribe<LogEntry>(IPC.evtLog, cb),
  onPlaylist: (cb) => subscribe<PlaylistItem[]>(IPC.evtPlaylist, cb),
  onSettings: (cb) => subscribe<AppSettings>(IPC.evtSettings, cb)
}

contextBridge.exposeInMainWorld('streamer', api)

export type { MediaInfo, SubtitleTrackRef }
