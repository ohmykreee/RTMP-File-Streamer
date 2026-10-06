import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
  SessionSettings
} from '@shared/types'
import { IPC, SUPPORTED_SUBTITLE_EXT, SUPPORTED_VIDEO_EXT } from '@shared/types'
import type { Language, StreamProtocol } from '@shared/types'
import {
  addressMatchesProtocol,
  buildPushTarget,
  DEFAULT_STREAM_PROTOCOL,
  PROTOCOL_SCHEMES
} from '@shared/protocol'
import { buildCommandLine, buildTestCommand } from '@main/ffmpeg/command'
import { ENCODER_CATALOGUE, getCapabilities, resolveBinaries, runProcess, setAvailableEncoderNames } from '@main/ffmpeg/capabilities'
import { embeddedSubtitleRefs } from '@main/ffmpeg/probe'
import { probeCached } from '@main/store/playlist'
import { deletePreset, getPresetLocation, listPresets, renamePreset, savePreset } from '@main/store/presets'
import { getPersistedLogInfo } from '@main/store/logger'
import { readBuildInfo } from './buildInfo'
import { mainT } from './i18n'
import { BUILTIN_PRESETS } from '@shared/defaults'

/** Everything the IPC layer needs from the running application. */
export interface AppServices {
  getWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  mergeSettings: (patch: Partial<AppSettings>) => AppSettings
  /** Records an explicit interface-language choice; see `store/settings.ts`. */
  setLanguage: (language: Language) => AppSettings
  getPlaylist: () => PlaylistItem[]
  addItems: (paths: string[]) => Promise<PlaylistItem[]>
  attachSubtitle: (itemId: string, filePath: string) => Promise<PlaylistItem | null>
  removeItem: (itemId: string) => void
  clearPlaylist: () => void
  reorder: (orderedIds: string[]) => void
  updateItem: (itemId: string, patch: Partial<PlaylistItem>) => PlaylistItem | null
  logs: LogEntry[]
  pushLog: (level: LogEntry['level'], message: string) => void
  engineStatus: () => EngineStatus
  engineStart: () => Promise<EngineStatus>
  engineStop: () => Promise<EngineStatus>
  engineSkipNext: () => Promise<EngineStatus>
  engineJumpToItem: (itemId: string) => Promise<EngineStatus>
  enginePreviewCommand: () => string
  /** Live state of the obs-websocket compatible control server. */
  obsStatus: () => ObsWebSocketStatus
  /** Restarts that server from the current settings. */
  obsApply: () => ObsWebSocketStatus
}

export function registerIpc(services: AppServices): void {
  const win = (): BrowserWindow | null => services.getWindow()

  /* ---------------- app / settings ---------------- */

  ipcMain.handle(IPC.getAppInfo, (): AppInfo => {
    // Build identity comes from build-info.json when it exists (written by the
    // build script); a dev run without one falls back to package.json.
    const build = readBuildInfo()
    return {
      version: build?.version ?? app.getVersion(),
      ...(build?.commit ? { commit: build.commit } : {}),
      ...(build ? { nightly: build.nightly, builtAt: build.builtAt } : {}),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData')
    }
  })

  ipcMain.handle(IPC.getSettings, (): AppSettings => services.getSettings())
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<AppSettings>): AppSettings => services.mergeSettings(patch ?? {}))

  /**
   * Switches the interface language.
   *
   * Also re-broadcasts the settings so every window (and the renderer's own copy)
   * ends up with the value that was actually persisted — including `languageSet`,
   * which is what stops the setting from following the system locale next launch.
   */
  ipcMain.handle(IPC.setLanguage, (_e, language: Language): AppSettings => {
    const next = services.setLanguage(language)
    win()?.webContents.send(IPC.evtSettings, next)
    return next
  })

  ipcMain.handle(IPC.showItemInFolder, (_e, filePath: string): void => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(path.resolve(filePath))
  })

  /* ---------------- ffmpeg discovery / capabilities ---------------- */

  ipcMain.handle(IPC.getCapabilities, async (_e, force: boolean): Promise<FfmpegCapabilities> => {
    const settings = services.getSettings()
    const resolved = resolveBinaries(settings.ffmpegPath, settings.ffprobePath)
    const caps = await getCapabilities(resolved.ffmpeg, resolved.ffprobe, resolved.source, force === true, settings.language)
    const names = new Set<string>()
    for (const enc of caps.encoders) {
      if (!enc.available) continue
      const def = ENCODER_CATALOGUE.find((d) => d.value === enc.value)
      if (def) names.add(def.ffmpegName)
    }
    if (names.size === 0) names.add('libx264')
    setAvailableEncoderNames(names)
    return caps
  })

  ipcMain.handle(IPC.pickFfmpeg, async (): Promise<string | null> => {
    const filters =
      process.platform === 'win32'
        ? [{ name: mainT('main.dialog.executables'), extensions: ['exe'] }]
        : [{ name: mainT('main.dialog.allFiles'), extensions: ['*'] }]
    const parent = win()
    const options = { title: mainT('main.dialog.pickFfmpeg'), properties: ['openFile'] as string[], filters }
    const res = parent ? await dialog.showOpenDialog(parent, options as never) : await dialog.showOpenDialog(options as never)
    if (res.canceled || res.filePaths.length === 0) return null

    const chosen = res.filePaths[0]
    const sibling = path.join(path.dirname(chosen), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    const patch: Partial<AppSettings> = { ffmpegPath: chosen }
    if (fs.existsSync(sibling)) patch.ffprobePath = sibling
    services.mergeSettings(patch)
    services.pushLog('info', mainT('main.caps.ffmpegUpdated', { path: chosen }))
    return chosen
  })

  /* ---------------- file dialogs ---------------- */

  const mediaFilter = (exts: string[], label: string): { name: string; extensions: string[] }[] => [
    { name: label, extensions: exts.map((e) => e.replace(/^\./, '')) },
    { name: mainT('main.dialog.allFiles'), extensions: ['*'] }
  ]

  ipcMain.handle(IPC.pickVideoFiles, async (): Promise<string[]> => {
    const parent = win()
    const options = {
      title: mainT('main.dialog.pickVideos'),
      properties: ['openFile', 'multiSelections'] as string[],
      filters: mediaFilter(SUPPORTED_VIDEO_EXT, mainT('main.dialog.videoFiles'))
    }
    const res = parent ? await dialog.showOpenDialog(parent, options as never) : await dialog.showOpenDialog(options as never)
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.pickSubtitleFiles, async (): Promise<string[]> => {
    const parent = win()
    const options = {
      title: mainT('main.dialog.pickSubtitles'),
      properties: ['openFile', 'multiSelections'] as string[],
      filters: mediaFilter(SUPPORTED_SUBTITLE_EXT, mainT('main.dialog.subtitleFiles'))
    }
    const res = parent ? await dialog.showOpenDialog(parent, options as never) : await dialog.showOpenDialog(options as never)
    return res.canceled ? [] : res.filePaths
  })

  /* ---------------- probing ---------------- */

  ipcMain.handle(IPC.probe, async (_e, filePath: string): Promise<ProbeResult> => {
    const settings = services.getSettings()
    const resolved = resolveBinaries(settings.ffmpegPath, settings.ffprobePath)
    const info = await probeCached(resolved.ffprobe, filePath, settings.language)
    return { info, subtitles: embeddedSubtitleRefs(info) }
  })

  /* ---------------- playlist ---------------- */

  ipcMain.handle(IPC.getPlaylist, (): PlaylistItem[] => services.getPlaylist())
  ipcMain.handle(IPC.addItems, (_e, paths: string[]): Promise<PlaylistItem[]> => {
    const list = Array.isArray(paths) ? paths : []
    // Only video files belong in the playlist; a stray subtitle that slipped
    // into a drop would otherwise be probed as a "video" and fail to stream.
    const videos = list.filter((p) => SUPPORTED_VIDEO_EXT.includes(path.extname(String(p)).toLowerCase()))
    const skipped = list.length - videos.length
    if (skipped > 0) services.pushLog('info', mainT('main.engine.ignoredNonVideo', { n: skipped }))
    return services.addItems(videos)
  })
  ipcMain.handle(IPC.attachSubtitle, (_e, itemId: string, filePath: string): Promise<PlaylistItem | null> =>
    services.attachSubtitle(itemId, filePath)
  )
  ipcMain.handle(IPC.removeItem, (_e, itemId: string): void => services.removeItem(itemId))
  ipcMain.handle(IPC.clearPlaylist, (): void => services.clearPlaylist())
  ipcMain.handle(IPC.reorderPlaylist, (_e, orderedIds: string[]): void =>
    services.reorder(Array.isArray(orderedIds) ? orderedIds : [])
  )
  ipcMain.handle(IPC.updateItem, (_e, itemId: string, patch: Partial<PlaylistItem>): PlaylistItem | null =>
    services.updateItem(itemId, patch ?? {})
  )

  /* ---------------- engine ---------------- */

  ipcMain.handle(IPC.start, (): Promise<EngineStatus> => services.engineStart())
  ipcMain.handle(IPC.stop, (): Promise<EngineStatus> => services.engineStop())
  ipcMain.handle(IPC.skipNext, (): Promise<EngineStatus> => services.engineSkipNext())
  ipcMain.handle(IPC.jumpToItem, (_e, itemId: string): Promise<EngineStatus> => services.engineJumpToItem(String(itemId)))
  ipcMain.handle(IPC.getStatus, (): EngineStatus => services.engineStatus())
  ipcMain.handle(IPC.previewCommand, (): string => services.enginePreviewCommand())

  /* ---------------- logs ---------------- */

  ipcMain.handle(IPC.getLogs, (): LogEntry[] => services.logs)
  ipcMain.handle(IPC.clearLogs, (): void => {
    services.logs.length = 0
  })

  /* ---------------- presets ---------------- */

  const presetsPayload = (): PresetsPayload => ({
    location: getPresetLocation(),
    presets: [...BUILTIN_PRESETS, ...listPresets()]
  })

  ipcMain.handle(IPC.getPresets, (): PresetsPayload => presetsPayload())

  ipcMain.handle(IPC.savePreset, (_e, name: string, settings: SessionSettings): PresetsPayload => {
    const preset = savePreset({ name: String(name ?? ''), settings })
    services.pushLog('info', mainT('main.dialog.presetSaved', { name: preset.name, path: getPresetLocation().file }))
    return presetsPayload()
  })

  ipcMain.handle(IPC.deletePreset, (_e, presetId: string): PresetsPayload => {
    if (BUILTIN_PRESETS.some((p) => p.id === presetId)) throw new Error(mainT('main.dialog.builtinNoDelete'))
    const remaining = deletePreset(String(presetId))
    services.pushLog('info', mainT('main.dialog.presetDeleted', { n: remaining.length }))
    return presetsPayload()
  })

  ipcMain.handle(IPC.renamePreset, (_e, presetId: string, name: string): PresetsPayload => {
    if (BUILTIN_PRESETS.some((p) => p.id === presetId)) throw new Error(mainT('main.dialog.builtinNoRename'))
    renamePreset(String(presetId), String(name ?? ''))
    return presetsPayload()
  })

  ipcMain.handle(IPC.openDataDir, (): void => {
    const { dir } = getPresetLocation()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore: the shell will report a missing folder */
    }
    void shell.openPath(dir)
  })

  /* ---------------- persisted logs ---------------- */

  ipcMain.handle(IPC.openLogsDir, (): void => {
    const { dir } = getPersistedLogInfo()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore: the shell will report a missing folder */
    }
    void shell.openPath(dir)
  })

  ipcMain.handle(IPC.getLogFileInfo, (): PersistedLogInfo => getPersistedLogInfo())

  /* ---------------- obs-websocket compatible control server ---------------- */

  ipcMain.handle(IPC.getObsWebSocketStatus, (): ObsWebSocketStatus => services.obsStatus())
  ipcMain.handle(IPC.applyObsWebSocket, (): ObsWebSocketStatus => services.obsApply())

  /* ---------------- RTMP connection test ---------------- */

  ipcMain.handle(IPC.testRtmp, async (_e, req: RtmpTestRequest): Promise<RtmpTestResult> => {
    const settings = services.getSettings()
    const resolved = resolveBinaries(settings.ffmpegPath, settings.ffprobePath)
    if (!resolved.ffmpeg) return { ok: false, message: mainT('main.dialog.noFfmpegTest'), detail: '', elapsedMs: 0 }

    const url = String(req?.url ?? '').trim()
    const key = String(req?.streamKey ?? '').trim()
    // Test the session the caller sent (the settings on screen); fall back to the
    // persisted ones so a caller that predates the field still gets a test.
    const session = req?.session ?? settings.session
    // The protocol decides the address scheme the test accepts and how the key
    // travels (see `protocol.ts`).
    const protocol: StreamProtocol = session.output.protocol ?? DEFAULT_STREAM_PROTOCOL
    if (!addressMatchesProtocol(url, protocol)) {
      return { ok: false, message: mainT('main.dialog.badUrlProtocol', { schemes: PROTOCOL_SCHEMES[protocol] }), detail: '', elapsedMs: 0 }
    }
    // The stream key is optional: some servers take the whole path in the address.
    const target = buildPushTarget(url, key, protocol)
    // The summary and notes are shown in the UI, so the test is built in the
    // language the interface is running in.
    const test = buildTestCommand(session, url, key, settings.language)
    const args = test.args
    const timeoutMs = Math.max(5, Math.min(60, Number(req?.timeoutSec) || 20)) * 1000
    services.pushLog('debug', mainT('main.dialog.testTarget', { target }))
    // The summary is what makes "the test used different settings than the stream"
    // a visible fact instead of something the user has to infer from ffmpeg output.
    services.pushLog('debug', mainT('main.dialog.testParams', { params: test.summary.join(' · ') }))
    for (const note of test.notes) services.pushLog('info', mainT('main.dialog.testNote', { note }))
    services.pushLog('debug', mainT('main.dialog.testCommand', { command: buildCommandLine(resolved.ffmpeg, args) }))

    const started = Date.now()
    // The ffmpeg run has its own timeout; this guard only covers a hang below
    // runProcess (e.g. a stuck pipe) so the test can never wedge the UI.
    const guardMs = timeoutMs + 5000
    let guard: NodeJS.Timeout | null = null
    const timeoutResult = await Promise.race([
      runProcess(resolved.ffmpeg, args, timeoutMs),
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        guard = setTimeout(
          () => resolve({ code: -3, stdout: '', stderr: mainT('main.dialog.testAborted') }),
          guardMs
        )
      })
    ]).finally(() => {
      if (guard) clearTimeout(guard)
    })

    const elapsedMs = Date.now() - started
    const combined = `${timeoutResult.stderr}\n${timeoutResult.stdout}`
    const detail = combined
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-30)
      .join('\n')
    const timedOut = timeoutResult.code === -2 || timeoutResult.code === -3
    const failedPattern =
      /Connection refused|Server error|Unauthorized|Cannot open connection|Unknown error|Connection reset|timed out|No route to host|Name or service not known|Immediate exit requested/i
    const ok = !timedOut && timeoutResult.code === 0 && !failedPattern.test(combined)

    let message: string
    if (ok) {
      message = mainT('main.dialog.testOk', { target, sec: (elapsedMs / 1000).toFixed(1) })
    } else if (timeoutResult.code === -3) {
      message = mainT('main.dialog.testStuck')
    } else if (timedOut) {
      message = mainT('main.dialog.testTimeout', { sec: timeoutMs / 1000 })
    } else {
      const errLine = combined
        .split(/\r?\n/)
        .reverse()
        .find((l) => failedPattern.test(l))
      message = errLine ? errLine.trim() : mainT('main.dialog.testFailed', { code: timeoutResult.code ?? mainT('main.engine.unknown') })
    }
    services.pushLog(ok ? 'info' : 'error', mainT('main.dialog.result', { message }))
    return { ok, message, detail, elapsedMs, summary: test.summary, notes: test.notes }
  })
}
