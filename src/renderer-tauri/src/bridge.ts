/**
 * The Tauri bridge: implements the exact `StreamerApi` surface the Electron
 * preload exposed (`window.streamer`), over Tauri commands and events. The
 * renderer code is otherwise unchanged from `src/renderer`.
 *
 * The command names mirror `src-tauri/src/ipc.rs`; the event names are the
 * same strings the Electron IPC map used (evt:status / evt:log / evt:playlist
 * / evt:settings), so the app-level event contract is unchanged.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  AppInfo,
  AppSettings,
  EngineStatus,
  FfmpegCapabilities,
  LogEntry,
  ObsWebSocketStatus,
  PersistedLogInfo,
  PlaylistItem,
  PresetsPayload,
  ProbeResult,
  RtmpTestRequest,
  RtmpTestResult,
  StreamerApi,
} from '@shared/types'

/* ------------------------------------------------------------------ *
 * Drag-and-drop paths
 * ------------------------------------------------------------------ */

/**
 * Tauri's drag-drop handling is enabled on the window, so the webview does
 * not receive native drops on Windows — the DOM `drop` event never fires and
 * `File` objects carry no path. The webview-level drag-drop event carries the
 * real paths instead; they are captured here and served through the same
 * StreamerApi methods the Electron build used.
 */
let lastDroppedPaths: string[] = []

function subscribeDropEvents(): void {
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === 'drop') {
        lastDroppedPaths = [...(event.payload.paths ?? [])]
        for (const cb of dropListeners) cb(lastDroppedPaths)
      } else if (event.payload.type === 'leave') {
        // Keep the last paths; a fresh drop overwrites them.
      }
    })
    .then((unlisten) => {
      unlisteners.push(unlisten)
    })
}

const dropListeners = new Set<(paths: string[]) => void>()
const unlisteners: UnlistenFn[] = []

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let done = false
  void listen<T>(channel, (event) => cb(event.payload)).then((off) => {
    if (done) off()
    else unlisten = off
  })
  return () => {
    done = true
    unlisten?.()
  }
}

const api: StreamerApi = {
  getAppInfo: () => invoke('get_app_info') as Promise<AppInfo>,
  getSettings: () => invoke('get_settings') as Promise<AppSettings>,
  saveSettings: (patch) => invoke('save_settings', { patch }) as Promise<AppSettings>,
  setLanguage: (language) => invoke('set_language', { language }) as Promise<AppSettings>,
  getCapabilities: (force) => invoke('get_app_capabilities', { force: force ?? false }) as Promise<FfmpegCapabilities>,
  pickFfmpeg: () => invoke('pick_ffmpeg') as Promise<string | null>,
  pickVideoFiles: () => invoke('pick_video_files') as Promise<string[]>,
  pickSubtitleFiles: () => invoke('pick_subtitle_files') as Promise<string[]>,
  probe: (filePath) => invoke('probe', { path: filePath }) as Promise<ProbeResult>,
  addItems: (paths) => invoke('playlist_add', { paths }) as Promise<PlaylistItem[]>,
  attachSubtitle: (itemId, filePath) =>
    invoke('playlist_attach_subtitle', { itemId, filePath }) as Promise<PlaylistItem | null>,
  removeItem: (itemId) => invoke('playlist_remove', { itemId }) as Promise<void>,
  clearPlaylist: () => invoke('playlist_clear') as Promise<void>,
  reorderPlaylist: (orderedIds) => invoke('playlist_reorder', { orderedIds }) as Promise<void>,
  updateItem: (itemId, patch) => invoke('playlist_update_item', { itemId, patch }) as Promise<PlaylistItem | null>,
  getPlaylist: () => invoke('playlist_get') as Promise<PlaylistItem[]>,
  getStatus: () => invoke('engine_status') as Promise<EngineStatus>,
  getLogs: () => invoke('log_get') as Promise<LogEntry[]>,
  start: () => invoke('engine_start') as Promise<EngineStatus>,
  stop: () => invoke('engine_stop') as Promise<EngineStatus>,
  skipNext: () => invoke('engine_skip_next') as Promise<EngineStatus>,
  jumpToItem: (itemId) => invoke('engine_jump_to_item', { itemId }) as Promise<EngineStatus>,
  testRtmp: (req: RtmpTestRequest) => invoke('test_rtmp', { req }) as Promise<RtmpTestResult>,
  clearLogs: () => invoke('log_clear') as Promise<void>,
  showItemInFolder: (filePath) => invoke('shell_show_item', { filePath }) as Promise<void>,
  getPresets: () => invoke('presets_get') as Promise<PresetsPayload>,
  savePreset: (name, settings) => invoke('presets_save', { name, settings }) as Promise<PresetsPayload>,
  deletePreset: (presetId) => invoke('presets_delete', { presetId }) as Promise<PresetsPayload>,
  renamePreset: (presetId, name) => invoke('presets_rename', { presetId, name }) as Promise<PresetsPayload>,
  openDataDir: () => invoke('presets_open_dir') as Promise<void>,
  openLogsDir: () => invoke('logs_open_dir') as Promise<void>,
  getLogFileInfo: () => invoke('logs_info') as Promise<PersistedLogInfo>,
  getObsWebSocketStatus: () => invoke('obs_status') as Promise<ObsWebSocketStatus>,
  applyObsWebSocket: () => invoke('obs_apply') as Promise<ObsWebSocketStatus>,
  /**
   * Resolves the on-disk paths of dropped `File` objects. Under Tauri the real
   * paths arrive through the webview drag-drop event (see `onDropFiles`);
   * this serves the most recent drop so any DOM-level handler still works.
   */
  getPathsForFiles: (_files: File[]): string[] => lastDroppedPaths,
  /**
   * Tauri-only: the authoritative drop notifications with real file paths.
   * `App.tsx` subscribes to this instead of relying on the DOM drop event,
   * which the enabled drag-drop handler suppresses on Windows.
   */
  onDropFiles: (cb: (paths: string[]) => void): (() => void) => {
    dropListeners.add(cb)
    return () => {
      dropListeners.delete(cb)
    }
  },
  previewCommand: () => invoke('engine_preview_command') as Promise<string>,
  onStatus: (cb) => subscribe<EngineStatus>('evt:status', cb),
  onLog: (cb) => subscribe<LogEntry>('evt:log', cb),
  onPlaylist: (cb) => subscribe<PlaylistItem[]>('evt:playlist', cb),
  onSettings: (cb) => subscribe<AppSettings>('evt:settings', cb),
}

subscribeDropEvents()

/*
 * JS `window.close()` must quit the whole app, like it did under the Electron
 * shell. Under WebView2 the DOM call only destroys the webview container (wry
 * answers WindowCloseRequested by destroying its child window), which leaves
 * an empty shell behind. Route the call through the native close request
 * instead, so the close-confirm-while-streaming flow (`window.rs`) and the
 * graceful shutdown still run.
 */
window.close = () => {
  void getCurrentWindow().close()
}

// Install before the app renders, exactly like the Electron preload did.
window.streamer = api

