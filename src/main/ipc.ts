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
import { buildRtmpTarget } from '@shared/rtmp'
import { buildCommandLine, buildTestCommand } from '@main/ffmpeg/command'
import { ENCODER_CATALOGUE, getCapabilities, resolveBinaries, runProcess, setAvailableEncoderNames } from '@main/ffmpeg/capabilities'
import { embeddedSubtitleRefs } from '@main/ffmpeg/probe'
import { probeCached } from '@main/store/playlist'
import { deletePreset, getPresetLocation, listPresets, renamePreset, savePreset } from '@main/store/presets'
import { getPersistedLogInfo } from '@main/store/logger'
import { BUILTIN_PRESETS } from '@shared/defaults'

/** Everything the IPC layer needs from the running application. */
export interface AppServices {
  getWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  mergeSettings: (patch: Partial<AppSettings>) => AppSettings
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

  ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData')
  }))

  ipcMain.handle(IPC.getSettings, (): AppSettings => services.getSettings())
  ipcMain.handle(IPC.saveSettings, (_e, patch: Partial<AppSettings>): AppSettings => services.mergeSettings(patch ?? {}))

  ipcMain.handle(IPC.showItemInFolder, (_e, filePath: string): void => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(path.resolve(filePath))
  })

  /* ---------------- ffmpeg discovery / capabilities ---------------- */

  ipcMain.handle(IPC.getCapabilities, async (_e, force: boolean): Promise<FfmpegCapabilities> => {
    const settings = services.getSettings()
    const resolved = resolveBinaries(settings.ffmpegPath, settings.ffprobePath)
    const caps = await getCapabilities(resolved.ffmpeg, resolved.ffprobe, resolved.source, force === true)
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
        ? [{ name: '可执行文件', extensions: ['exe'] }]
        : [{ name: '所有文件', extensions: ['*'] }]
    const parent = win()
    const options = { title: '选择 ffmpeg 可执行文件', properties: ['openFile'] as string[], filters }
    const res = parent ? await dialog.showOpenDialog(parent, options as never) : await dialog.showOpenDialog(options as never)
    if (res.canceled || res.filePaths.length === 0) return null

    const chosen = res.filePaths[0]
    const sibling = path.join(path.dirname(chosen), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    const patch: Partial<AppSettings> = { ffmpegPath: chosen }
    if (fs.existsSync(sibling)) patch.ffprobePath = sibling
    services.mergeSettings(patch)
    services.pushLog('info', `已设置 ffmpeg 路径: ${chosen}`)
    return chosen
  })

  /* ---------------- file dialogs ---------------- */

  const mediaFilter = (exts: string[], label: string): { name: string; extensions: string[] }[] => [
    { name: label, extensions: exts.map((e) => e.replace(/^\./, '')) },
    { name: '所有文件', extensions: ['*'] }
  ]

  ipcMain.handle(IPC.pickVideoFiles, async (): Promise<string[]> => {
    const parent = win()
    const options = {
      title: '选择视频文件（可多选）',
      properties: ['openFile', 'multiSelections'] as string[],
      filters: mediaFilter(SUPPORTED_VIDEO_EXT, '视频文件')
    }
    const res = parent ? await dialog.showOpenDialog(parent, options as never) : await dialog.showOpenDialog(options as never)
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.pickSubtitleFiles, async (): Promise<string[]> => {
    const parent = win()
    const options = {
      title: '选择字幕文件',
      properties: ['openFile', 'multiSelections'] as string[],
      filters: mediaFilter(SUPPORTED_SUBTITLE_EXT, '字幕文件')
    }
    const res = parent ? await dialog.showOpenDialog(parent, options as never) : await dialog.showOpenDialog(options as never)
    return res.canceled ? [] : res.filePaths
  })

  /* ---------------- probing ---------------- */

  ipcMain.handle(IPC.probe, async (_e, filePath: string): Promise<ProbeResult> => {
    const settings = services.getSettings()
    const resolved = resolveBinaries(settings.ffmpegPath, settings.ffprobePath)
    const info = await probeCached(resolved.ffprobe, filePath)
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
    if (skipped > 0) services.pushLog('info', `已忽略 ${skipped} 个非视频文件。`)
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
    services.pushLog('info', `已保存预设「${preset.name}」→ ${getPresetLocation().file}`)
    return presetsPayload()
  })

  ipcMain.handle(IPC.deletePreset, (_e, presetId: string): PresetsPayload => {
    if (BUILTIN_PRESETS.some((p) => p.id === presetId)) throw new Error('内置预设不可删除')
    const remaining = deletePreset(String(presetId))
    services.pushLog('info', `已删除预设（剩余 ${remaining.length} 个自定义预设）`)
    return presetsPayload()
  })

  ipcMain.handle(IPC.renamePreset, (_e, presetId: string, name: string): PresetsPayload => {
    if (BUILTIN_PRESETS.some((p) => p.id === presetId)) throw new Error('内置预设不可重命名')
    renamePreset(String(presetId), String(name ?? ''))
    return presetsPayload()
  })

  ipcMain.handle(IPC.openConfigDir, (): void => {
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
    if (!resolved.ffmpeg) return { ok: false, message: '未找到 ffmpeg，无法测试连接', detail: '', elapsedMs: 0 }

    const url = String(req?.url ?? '').trim()
    const key = String(req?.streamKey ?? '').trim()
    if (!/^rtmps?:\/\//i.test(url)) {
      return { ok: false, message: '地址必须是以 rtmp:// 或 rtmps:// 开头的推流地址', detail: '', elapsedMs: 0 }
    }
    // Test the session the caller sent (the settings on screen); fall back to the
    // persisted ones so a caller that predates the field still gets a test.
    const session = req?.session ?? settings.session
    // The stream key is optional: some servers take the whole path in the address.
    const target = buildRtmpTarget(url, key)
    const test = buildTestCommand(session, url, key)
    const args = test.args
    const timeoutMs = Math.max(5, Math.min(60, Number(req?.timeoutSec) || 20)) * 1000
    services.pushLog('debug', `RTMP 测试目标: ${target}`)
    // The summary is what makes "the test used different settings than the stream"
    // a visible fact instead of something the user has to infer from ffmpeg output.
    services.pushLog('debug', `RTMP 测试参数: ${test.summary.join(' · ')}`)
    for (const note of test.notes) services.pushLog('info', `RTMP 测试：${note}`)
    services.pushLog('debug', `RTMP 测试命令: ${buildCommandLine(resolved.ffmpeg, args)}`)

    const started = Date.now()
    // The ffmpeg run has its own timeout; this guard only covers a hang below
    // runProcess (e.g. a stuck pipe) so the test can never wedge the UI.
    const guardMs = timeoutMs + 5000
    let guard: NodeJS.Timeout | null = null
    const timeoutResult = await Promise.race([
      runProcess(resolved.ffmpeg, args, timeoutMs),
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        guard = setTimeout(
          () => resolve({ code: -3, stdout: '', stderr: '[test aborted] 测试未能在时限内完成，已强制结束。' }),
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
      message = `连接成功：已向 ${target} 推送 5 秒测试流（耗时 ${(elapsedMs / 1000).toFixed(1)}s）`
    } else if (timeoutResult.code === -3) {
      message = '测试卡住，已强制中止（超过等待上限）'
    } else if (timedOut) {
      message = `测试超时（${timeoutMs / 1000}s）：服务器无响应或地址不可达`
    } else {
      const errLine = combined
        .split(/\r?\n/)
        .reverse()
        .find((l) => failedPattern.test(l))
      message = errLine ? errLine.trim() : `推流失败（ffmpeg 退出码 ${timeoutResult.code ?? '未知'}）`
    }
    services.pushLog(ok ? 'info' : 'error', `RTMP 测试：${message}`)
    return { ok, message, detail, elapsedMs, summary: test.summary, notes: test.notes }
  })
}
