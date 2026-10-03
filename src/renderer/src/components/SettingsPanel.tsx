import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  AudioCodecName,
  AudioRateControl,
  AudioSettings,
  ContainerName,
  FfmpegCapabilities,
  ObsWebSocketSettings,
  ObsWebSocketStatus,
  OutputSettings,
  PersistedLogInfo,
  Preset,
  PresetsPayload,
  RtmpTestResult,
  SubtitleRenderSettings,
  SubtitleMode,
  VideoCodecName,
  VideoEncoderChoice,
  VideoRateControl,
  VideoSettings
} from '@shared/types'
import { BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, OBS_PORT_MAX, OBS_PORT_MIN, SCALE_PRESETS } from '@shared/defaults'

interface SettingsPanelProps {
  settings: AppSettings
  capabilities: FfmpegCapabilities | null
  capsLoading: boolean
  info: AppInfo | null
  busy: boolean
  /** True while a stream is live: every control is frozen until it ends. */
  locked: boolean
  presets: PresetsPayload | null
  logInfo: PersistedLogInfo | null
  activePresetId: string
  /** Live state of the obs-websocket compatible endpoint. */
  obsStatus: ObsWebSocketStatus | null
  onSelectPreset: (preset: Preset) => void
  onSavePreset: (name: string) => void
  onDeletePreset: (presetId: string) => void
  onOpenConfigDir: () => void
  onOpenLogsDir: () => void
  onUpdateVideo: (patch: Partial<VideoSettings>) => void
  onUpdateAudio: (patch: Partial<AudioSettings>) => void
  onUpdateSubtitles: (patch: Partial<SubtitleRenderSettings>) => void
  onUpdateOutput: (patch: Partial<OutputSettings>) => void
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  onChooseFfmpeg: () => void
  onRefreshCapabilities: (force?: boolean) => void
  onTestRtmp: (url: string, key: string) => Promise<RtmpTestResult>
  onPreviewCommand: () => Promise<string>
  /** Restart the control endpoint after its settings changed. */
  onApplyObsWebSocket: () => Promise<ObsWebSocketStatus | null>
}

type TabKey = 'video' | 'audio' | 'subtitle' | 'output' | 'advanced'

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'video', label: '视频编码', icon: '🎞' },
  { key: 'audio', label: '音频编码', icon: '🔊' },
  { key: 'subtitle', label: '字幕', icon: '💬' },
  { key: 'output', label: '输出 / RTMP', icon: '📡' },
  { key: 'advanced', label: '高级', icon: '⚙' }
]

const CODEC_LABEL: Record<VideoCodecName, string> = {
  h264: 'H.264 / AVC（兼容性最好）',
  hevc: 'H.265 / HEVC（同画质更省带宽）',
  av1: 'AV1（最新，兼容性有限）',
  copy: '直接复制源视频（不重编码）'
}

const RATE_CONTROL_LABEL: Record<VideoRateControl, string> = {
  cbr: 'CBR 固定码率（直播推荐）',
  vbr: 'VBR 可变码率',
  abr: 'ABR 平均码率',
  crf: 'CRF 恒定质量',
  auto: '自动'
}

const AUDIO_CODEC_LABEL: Record<AudioCodecName, string> = {
  aac: 'AAC（原生编码器 · 推荐）',
  libmp3lame: 'MP3 (libmp3lame)',
  libopus: 'Opus (libopus)',
  copy: '复制源音频',
  none: '不要音频'
}

const CONTAINER_LABEL: Record<ContainerName, string> = {
  flv: 'FLV（标准 RTMP 推流）',
  mpegts: 'MPEG-TS（SRT/HLS 场景）',
  mkv: 'Matroska（本地文件测试）'
}

export default function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const { settings, capabilities: caps } = props
  const [tab, setTab] = useState<TabKey>('video')
  const [testState, setTestState] = useState<{ running: boolean; result: RtmpTestResult | null }>({ running: false, result: null })
  const [commandPreview, setCommandPreview] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const v = settings.session.video
  const a = settings.session.audio
  const s = settings.session.subtitles
  const o = settings.session.output

  const encoderOptions = useMemo(() => {
    if (!caps) return []
    const list = caps.encoders.filter((e) => e.codec === v.codec)
    return [{ value: 'auto' as VideoEncoderChoice, label: '自动选择（优先硬件）', available: true, presets: [] as string[], kind: 'auto', codec: v.codec, verified: undefined as boolean | undefined, note: undefined as string | undefined }, ...list]
  }, [caps, v.codec])

  const activeEncoder = useMemo(() => encoderOptions.find((e) => e.value === v.encoder) ?? encoderOptions[0], [encoderOptions, v.encoder])

  const presetOptions = useMemo<string[]>(() => {
    if (!activeEncoder) return []
    if (activeEncoder.presets && activeEncoder.presets.length > 0) return activeEncoder.presets
    // `auto`: gather presets of every encoder that could be chosen for this codec.
    const merged = new Set<string>()
    for (const e of encoderOptions) for (const p of e.presets ?? []) merged.add(p)
    return [...merged]
  }, [activeEncoder, encoderOptions])

  const runTest = async (): Promise<void> => {
    setTestState({ running: true, result: null })
    // Last-resort guard: the main process already bounds the ffmpeg run, this
    // only stops the button from staying "正在测试…" forever if the IPC answer
    // itself never arrives.
    const guard = new Promise<RtmpTestResult>((resolve) =>
      window.setTimeout(
        () => resolve({ ok: false, message: '测试超时：31 秒内未返回结果，已中止等待。', detail: '', elapsedMs: 31000 }),
        31000
      )
    )
    try {
      const result = await Promise.race([props.onTestRtmp(o.server, o.streamKey), guard])
      setTestState({ running: false, result })
    } catch (err) {
      setTestState({ running: false, result: { ok: false, message: String(err), detail: '', elapsedMs: 0 } })
    }
  }

  /** Writes the obs-websocket block of the output settings. */
  const updateObs = (patch: Partial<ObsWebSocketSettings>): void => {
    props.onUpdateOutput({ obsWebSocket: { ...o.obsWebSocket, ...patch } })
  }

  /**
   * Restarts the control endpoint.
   *
   * The main process reads the *persisted* settings when it (re)binds the port,
   * and writing them goes through IPC, so the restart has to wait for the write
   * to land — otherwise it would restart with the previous values (turning the
   * switch off would leave the old server listening). Only one restart is kept
   * in flight: typing in the port field would otherwise queue one per keystroke.
   */
  const [obsRestarting, setObsRestarting] = useState(false)
  const obsTimer = useRef<number | null>(null)
  const applyObsNow = async (): Promise<void> => {
    setObsRestarting(true)
    try {
      await props.onApplyObsWebSocket()
    } finally {
      setObsRestarting(false)
    }
  }
  const applyObs = (): void => {
    if (obsTimer.current !== null) window.clearTimeout(obsTimer.current)
    obsTimer.current = window.setTimeout(() => {
      obsTimer.current = null
      void applyObsNow()
    }, 250)
  }
  useEffect(
    () => () => {
      if (obsTimer.current !== null) window.clearTimeout(obsTimer.current)
    },
    []
  )

  const showCommand = async (): Promise<void> => {
    const cmd = await props.onPreviewCommand()
    setCommandPreview(cmd)
  }

  return (
    <section className="settings">
      <PresetBar
        presets={props.presets}
        activePresetId={props.activePresetId}
        locked={props.locked}
        onSelectPreset={props.onSelectPreset}
        onSavePreset={props.onSavePreset}
        onDeletePreset={props.onDeletePreset}
        onOpenConfigDir={props.onOpenConfigDir}
      />

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            <span className="tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {props.locked && (
        <div className="lock-note">
          <span>🔒 串流进行中，设置已锁定（串流使用的参数在开始时已确定）。停止串流后可修改。</span>
        </div>
      )}

      <div className="settings-body" inert={props.locked}>
        {/* ---------------------------------------------------------- VIDEO */}
        {tab === 'video' && (
          <>
            <Field label="视频编码格式" hint="RTMP 推流最通用的是 H.264">
              <select value={v.codec} onChange={(e) => props.onUpdateVideo({ codec: e.target.value as VideoCodecName, encoder: 'auto' })}>
                {(Object.keys(CODEC_LABEL) as VideoCodecName[]).map((c) => (
                  <option key={c} value={c}>
                    {CODEC_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>

            {v.codec !== 'copy' && (
              <>
                <Field label="编码器" hint="硬件编码器可大幅降低 CPU 占用；带 ✓ 表示已实测可用">
                  <select value={v.encoder} onChange={(e) => props.onUpdateVideo({ encoder: e.target.value as VideoEncoderChoice })}>
                    {encoderOptions.map((e) => (
                      <option key={e.value} value={e.value} disabled={!e.available && e.value !== 'auto'}>
                        {e.label}
                        {e.value !== 'auto' && !e.available ? '（不可用）' : ''}
                        {e.verified ? ' ✓' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                {activeEncoder?.note && <p className="hint warn small">{activeEncoder.note}</p>}

                <div className="field-grid">
                  <Field label="码率控制模式">
                    <select value={v.rateControl} onChange={(e) => props.onUpdateVideo({ rateControl: e.target.value as VideoRateControl })}>
                      {(Object.keys(RATE_CONTROL_LABEL) as VideoRateControl[])
                        .filter((r) => r !== 'auto')
                        .map((r) => (
                          <option key={r} value={r}>
                            {RATE_CONTROL_LABEL[r]}
                          </option>
                        ))}
                    </select>
                  </Field>

                  {v.rateControl === 'crf' ? (
                    <Field label="CRF 质量 (0-51，越小越清晰)" hint="18≈视觉无损，23≈默认，28≈体积小">
                      <input
                        type="number"
                        min={0}
                        max={51}
                        value={v.crf}
                        onChange={(e) => props.onUpdateVideo({ crf: Number(e.target.value) })}
                      />
                    </Field>
                  ) : (
                    <BitrateField
                      label="视频码率"
                      hint="1080p60 建议 4500–9000；720p30 建议 2500–4000"
                      valueKbps={v.bitrateKbps}
                      minKbps={100}
                      onChange={(bitrateKbps) => props.onUpdateVideo({ bitrateKbps })}
                    />
                  )}

                  {v.rateControl !== 'cbr' && v.rateControl !== 'crf' && (
                    <BitrateField
                      label="最大码率"
                      valueKbps={v.maxBitrateKbps}
                      minKbps={100}
                      onChange={(maxBitrateKbps) => props.onUpdateVideo({ maxBitrateKbps })}
                    />
                  )}

                  <BitrateField
                    label="缓冲区大小"
                    hint="0 = 按码率自动推算"
                    valueKbps={v.bufferSizeKbps}
                    minKbps={0}
                    allowZero
                    onChange={(bufferSizeKbps) => props.onUpdateVideo({ bufferSizeKbps })}
                  />
                </div>

                <div className="field-grid">
                  <Field label="编码预设 (preset)" hint="越快越省 CPU，同码率画质略低">
                    {presetOptions.length > 0 ? (
                      <select value={v.preset} onChange={(e) => props.onUpdateVideo({ preset: e.target.value })}>
                        {presetOptions.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input value={v.preset} onChange={(e) => props.onUpdateVideo({ preset: e.target.value })} />
                    )}
                  </Field>

                  <Field label="tune">
                    <select value={v.tune} onChange={(e) => props.onUpdateVideo({ tune: e.target.value })}>
                      <option value="">（不设置）</option>
                      <option value="zerolatency">zerolatency（零延迟）</option>
                      <option value="film">film（电影）</option>
                      <option value="animation">animation（动画）</option>
                      <option value="grain">grain（保留颗粒）</option>
                      <option value="fastdecode">fastdecode（易解码）</option>
                    </select>
                  </Field>

                  <Field label="profile">
                    <select value={v.profile} onChange={(e) => props.onUpdateVideo({ profile: e.target.value })}>
                      <option value="">（不设置）</option>
                      <option value="baseline">baseline（最兼容）</option>
                      <option value="main">main</option>
                      <option value="high">high（推荐）</option>
                    </select>
                  </Field>
                </div>
              </>
            )}

            <div className="field-grid">
              <ResolutionField
                value={v}
                onChange={(patch) => props.onUpdateVideo(patch)}
              />

              <Field label="帧率 (fps)" hint="0 = 保持源帧率">
                <input type="number" min={0} max={240} value={v.fps} onChange={(e) => props.onUpdateVideo({ fps: Number(e.target.value) })} />
              </Field>

              <Field label="关键帧间隔 (秒)" hint="直播建议 1–2 秒，影响观众加入直播的速度">
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={v.keyframeIntervalSec}
                  onChange={(e) => props.onUpdateVideo({ keyframeIntervalSec: Number(e.target.value) })}
                />
              </Field>

              <Field label="B 帧数量" hint="直播建议 0；B 帧会增加编码延迟">
                <input type="number" min={0} max={4} value={v.bFrames} onChange={(e) => props.onUpdateVideo({ bFrames: Number(e.target.value) })} />
              </Field>
            </div>

            <div className="field-grid">
              <Field label="像素格式" hint="yuv420p 兼容性最好；10bit 源需转换">
                <select value={v.pixelFormat} onChange={(e) => props.onUpdateVideo({ pixelFormat: e.target.value })}>
                  <option value="yuv420p">yuv420p (8-bit 4:2:0)</option>
                  <option value="yuv422p">yuv422p (8-bit 4:2:2)</option>
                  <option value="yuv444p">yuv444p (8-bit 4:4:4)</option>
                  <option value="nv12">nv12</option>
                  <option value="p010le">p010le (10-bit)</option>
                </select>
              </Field>
            </div>

            <Toggle
              label="每个关键帧重复 SPS/PPS 头"
              hint="部分 RTMP 服务器需要，建议保持开启"
              checked={v.repeatHeaders}
              onChange={(checked) => props.onUpdateVideo({ repeatHeaders: checked })}
            />
          </>
        )}

        {/* ---------------------------------------------------------- AUDIO */}
        {tab === 'audio' && (
          <>
            <Field label="音频编码格式" hint="RTMP/FLV 标准只支持 AAC 与 MP3">
              <select value={a.codec} onChange={(e) => props.onUpdateAudio({ codec: e.target.value as AudioCodecName })}>
                {(Object.keys(AUDIO_CODEC_LABEL) as AudioCodecName[]).map((c) => {
                  const supported = caps?.audioEncoders.find((x) => x.value === c)
                  const disabled = c !== 'copy' && c !== 'none' && supported ? !supported.available : false
                  return (
                    <option key={c} value={c} disabled={disabled}>
                      {AUDIO_CODEC_LABEL[c]}
                      {disabled ? '（当前 ffmpeg 不支持）' : ''}
                    </option>
                  )
                })}
              </select>
            </Field>

            {a.codec !== 'copy' && a.codec !== 'none' && (
              <>
                <div className="field-grid">
                  <Field label="码率 (kbps)" hint="立体声建议 128–192">
                    <input
                      type="number"
                      min={16}
                      max={512}
                      step={8}
                      value={a.bitrateKbps}
                      onChange={(e) => props.onUpdateAudio({ bitrateKbps: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="采样率 (Hz)">
                    <select value={a.sampleRate} onChange={(e) => props.onUpdateAudio({ sampleRate: Number(e.target.value) })}>
                      <option value={48000}>48000</option>
                      <option value={44100}>44100</option>
                      <option value={32000}>32000</option>
                      <option value={22050}>22050</option>
                    </select>
                  </Field>
                  <Field label="声道数">
                    <select value={a.channels} onChange={(e) => props.onUpdateAudio({ channels: Number(e.target.value) })}>
                      <option value={2}>立体声 (2)</option>
                      <option value={1}>单声道 (1)</option>
                    </select>
                  </Field>
                  <Field label="码率模式">
                    <select value={a.rateControl} onChange={(e) => props.onUpdateAudio({ rateControl: e.target.value as AudioRateControl })}>
                      <option value="cbr">CBR 固定码率</option>
                      <option value="vbr">VBR 可变码率</option>
                    </select>
                  </Field>
                </div>

                <Toggle
                  label="响度归一化 (loudnorm, -16 LUFS)"
                  hint="不同来源的视频音量差异较大时开启，可让音量更一致（略微增加 CPU 占用）"
                  checked={a.loudnorm}
                  onChange={(checked) => props.onUpdateAudio({ loudnorm: checked })}
                />
              </>
            )}

            {a.codec === 'copy' && (
              <p className="hint small">
                直接复制源音频可保持原始质量，但要求源音频编码能被 FLV 容器承载（AAC/MP3）。若服务器报错请改用 AAC。
              </p>
            )}
          </>
        )}

        {/* ------------------------------------------------------- SUBTITLE */}
        {tab === 'subtitle' && (
          <>
            <Field label="默认字幕处理方式" hint="每个文件可以在左侧列表中单独覆盖">
              <select value={s.mode} onChange={(e) => props.onUpdateSubtitles({ mode: e.target.value as SubtitleMode })}>
                <option value="off">关闭字幕</option>
                <option value="burn">烧录进画面（推荐，所有播放器可见）</option>
                <option value="copy">作为独立字幕轨复制（多数 RTMP 不转发）</option>
              </select>
            </Field>

            {s.mode === 'burn' && (
              <>
                <Field label="样式来源" hint="ASS/SSA 内挂字幕自带样式，可保留或强制覆盖">
                  <select
                    value={s.styleMode}
                    onChange={(e) => props.onUpdateSubtitles({ styleMode: e.target.value as SubtitleRenderSettings['styleMode'] })}
                  >
                    <option value="preserve">保留原字幕样式</option>
                    <option value="force">使用下面的样式覆盖</option>
                    <option value="plain">强制为纯文本样式</option>
                  </select>
                </Field>

                {s.styleMode !== 'preserve' && (
                  <>
                    <div className="field-grid">
                      <Field label="字体名称" hint="需为本机已安装字体，如 Microsoft YaHei / SimHei / Arial">
                        <input value={s.fontName} onChange={(e) => props.onUpdateSubtitles({ fontName: e.target.value })} list="font-presets" />
                        <datalist id="font-presets">
                          <option value="Microsoft YaHei" />
                          <option value="SimHei" />
                          <option value="SimSun" />
                          <option value="Noto Sans CJK SC" />
                          <option value="Source Han Sans SC" />
                          <option value="Arial" />
                          <option value="Segoe UI" />
                        </datalist>
                      </Field>
                      <Field label="字号">
                        <input
                          type="number"
                          min={8}
                          max={120}
                          value={s.fontSize}
                          onChange={(e) => props.onUpdateSubtitles({ fontSize: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="描边粗细">
                        <input
                          type="number"
                          min={0}
                          max={10}
                          step={0.5}
                          value={s.outlineWidth}
                          onChange={(e) => props.onUpdateSubtitles({ outlineWidth: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="阴影">
                        <input type="number" min={0} max={10} value={s.shadow} onChange={(e) => props.onUpdateSubtitles({ shadow: Number(e.target.value) })} />
                      </Field>
                    </div>

                    <div className="field-grid">
                      <Field label="文字颜色">
                        <div className="color-row">
                          <input
                            type="color"
                            value={s.primaryColor}
                            onChange={(e) => props.onUpdateSubtitles({ primaryColor: e.target.value })}
                          />
                          <input value={s.primaryColor} onChange={(e) => props.onUpdateSubtitles({ primaryColor: e.target.value })} />
                        </div>
                      </Field>
                      <Field label="描边颜色">
                        <div className="color-row">
                          <input
                            type="color"
                            value={s.outlineColor}
                            onChange={(e) => props.onUpdateSubtitles({ outlineColor: e.target.value })}
                          />
                          <input value={s.outlineColor} onChange={(e) => props.onUpdateSubtitles({ outlineColor: e.target.value })} />
                        </div>
                      </Field>
                      <Field label="垂直边距 (px)">
                        <input
                          type="number"
                          min={0}
                          max={400}
                          value={s.marginVertical}
                          onChange={(e) => props.onUpdateSubtitles({ marginVertical: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label="对齐方式">
                        <select value={s.alignment} onChange={(e) => props.onUpdateSubtitles({ alignment: Number(e.target.value) })}>
                          <option value={1}>左下</option>
                          <option value={2}>底部居中</option>
                          <option value={3}>右下</option>
                          <option value={4}>左中</option>
                          <option value={5}>正中</option>
                          <option value={6}>右中</option>
                          <option value={7}>左上</option>
                          <option value={8}>顶部居中</option>
                          <option value={9}>右上</option>
                        </select>
                      </Field>
                    </div>

                    <div className="toggle-row">
                      <Toggle label="加粗" checked={s.bold} onChange={(c) => props.onUpdateSubtitles({ bold: c })} compact />
                      <Toggle label="斜体" checked={s.italic} onChange={(c) => props.onUpdateSubtitles({ italic: c })} compact />
                    </div>
                  </>
                )}

                <p className="hint small">
                  烧录使用 ffmpeg 的 <code>subtitles</code> 滤镜（libass）。
                  {caps && !caps.hasSubtitleFilter && <strong className="warn"> 当前 ffmpeg 未编译该滤镜，烧录将失败。</strong>}
                  内挂 PGS/DVD 位图字幕无法用滤镜烧录，请改用外部文本字幕。
                </p>
              </>
            )}

            {s.mode === 'copy' && (
              <p className="hint warn small">
                FLV 容器与绝大多数 RTMP 服务器不会转发字幕轨道；除非你的服务器专门支持，否则请使用「烧录」模式。
              </p>
            )}
          </>
        )}

        {/* --------------------------------------------------------- OUTPUT */}
        {tab === 'output' && (
          <>
            <Field label="RTMP 推流地址">
              <input
                value={o.server}
                placeholder="rtmp://127.0.0.1/live/"
                onChange={(e) => props.onUpdateOutput({ server: e.target.value })}
                spellCheck={false}
              />
            </Field>

            <Field label="串流密钥 (可选)" hint="留空则不携带密钥">
              <div className="secret-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={o.streamKey}
                  placeholder="无"
                  onChange={(e) => props.onUpdateOutput({ streamKey: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="btn tiny ghost secret-toggle" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </Field>

            <div className="row-actions">
              <button className="btn primary" onClick={runTest} disabled={testState.running || props.busy}>
                {testState.running ? '正在测试…' : '测试连接（推送 5 秒测试画面）'}
              </button>
              <button className="btn ghost" onClick={showCommand}>
                查看 ffmpeg 命令
              </button>
            </div>

            {testState.result && (
              <div className={`test-result ${testState.result.ok ? 'ok' : 'fail'}`}>
                <strong>{testState.result.ok ? '✓ 连接成功' : '✗ 连接失败'}</strong>
                <p>{testState.result.message}</p>
                {testState.result.detail && (
                  <details>
                    <summary>ffmpeg 输出</summary>
                    <pre>{testState.result.detail}</pre>
                  </details>
                )}
              </div>
            )}

            {commandPreview && (
              <div className="command-preview">
                <div className="cp-head">
                  <span>当前设置的 ffmpeg 命令</span>
                  <div>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        void navigator.clipboard.writeText(commandPreview)
                      }}
                    >
                      复制
                    </button>
                    <button className="btn tiny ghost" onClick={() => setCommandPreview(null)}>
                      关闭
                    </button>
                  </div>
                </div>
                <pre>{commandPreview}</pre>
              </div>
            )}

            <Field label="输出容器格式">
              <select value={o.container} onChange={(e) => props.onUpdateOutput({ container: e.target.value as ContainerName })}>
                {(Object.keys(CONTAINER_LABEL) as ContainerName[]).map((c) => {
                  const supported = caps?.containerFormats.find((x) => x.value === c)
                  return (
                    <option key={c} value={c} disabled={supported ? !supported.available : false}>
                      {CONTAINER_LABEL[c]}
                      {supported && !supported.available ? '（当前 ffmpeg 不支持）' : ''}
                    </option>
                  )
                })}
              </select>
            </Field>

            <Field label="追加自定义参数" hint="追加到 ffmpeg 输出参数末尾，例如 -flvflags no_duration_filesize">
              <input
                value={o.extraOutputArgs}
                placeholder=""
                onChange={(e) => props.onUpdateOutput({ extraOutputArgs: e.target.value })}
                spellCheck={false}
              />
            </Field>

            {/* ------------------------------------- OBS WebSocket ---------- */}
            <h3 className="section-title">OBS WebSocket 控制</h3>
            <Toggle
              label="启用 obs-websocket 兼容接口"
              hint="使用 obs-websocket 控制本应用"
              checked={o.obsWebSocket.enabled}
              onChange={(c) => {
                updateObs({ enabled: c })
                // Both directions restart the endpoint: enabling binds the port,
                // disabling must release it again.
                applyObs()
              }}
            />

            {o.obsWebSocket.enabled && (
              <>
                <div className="field-grid">
                  <Field label="监听地址">
                    <input
                      value={o.obsWebSocket.host}
                      placeholder="127.0.0.1"
                      onChange={(e) => {
                        updateObs({ host: e.target.value })
                        applyObs()
                      }}
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="端口">
                    <input
                      type="number"
                      min={OBS_PORT_MIN}
                      max={OBS_PORT_MAX}
                      value={o.obsWebSocket.port}
                      onChange={(e) => {
                        updateObs({ port: clampNumber(Number(e.target.value), OBS_PORT_MIN, OBS_PORT_MAX, 4455) })
                        applyObs()
                      }}
                    />
                  </Field>
                  <Field label="密码" hint="无则客户端无需认证直接连接">
                    <div className="secret-row">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={o.obsWebSocket.password}
                        placeholder="无"
                        onChange={(e) => {
                          updateObs({ password: e.target.value })
                          applyObs()
                        }}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button type="button" className="btn tiny ghost secret-toggle" onClick={() => setShowKey((v) => !v)}>
                        {showKey ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </Field>
                </div>

                <div className="row-actions">
                  <button className="btn" onClick={() => void applyObsNow()} disabled={obsRestarting}>
                    {obsRestarting ? '正在应用…' : '应用并重启接口'}
                  </button>
                  <span className={`pill ${props.obsStatus?.running ? 'ok' : 'subtle'}`}>
                    {props.obsStatus?.running
                      ? `● 运行中 ${props.obsStatus.url}`
                      : props.obsStatus?.error
                        ? `● 未运行：${props.obsStatus.error}`
                        : '○ 未运行'}
                  </span>
                  {props.obsStatus?.running && props.obsStatus.clients > 0 && (
                    <span className="pill subtle">已连接 {props.obsStatus.clients}</span>
                  )}
                </div>

                <p className="hint small">
                  兼容 obs-websocket 5.x 握手。已实现
                  <code> SetStreamServiceSettings</code>（推流地址 / 串流密钥）、<code>StartStream</code>、<code>StopStream</code>，
                  以及客户端连接时会询问的 GetVersion / GetStreamStatus 等只读请求；其余请求一律返回成功，不会报错。
                </p>
              </>
            )}
          </>
        )}

        {/* ------------------------------------------------------- ADVANCED */}
        {tab === 'advanced' && (
          <>
            <h3 className="section-title">串流控制</h3>
            {/*
              The switch and its delay share a row, switch first: the delay only means
              anything while buffering is on, and reading them side by side is what
              makes that dependency visible. The delay stays in the DOM while disabled
              rather than disappearing, so the row does not reflow when it is toggled.
            */}
            <div className="field-grid stream-mode-grid">
              <Toggle
                label="双引擎推流"
                hint="编码 + 推流分离（推荐）"
                checked={o.buffered}
                onChange={(c) =>
                  props.onUpdateOutput({
                    buffered: c,
                    // Switching it on with a delay the engine would refuse would leave
                    // the setting looking enabled while nothing was actually buffered,
                    // so the value is raised to the smallest one that works.
                    ...(c ? { bufferSec: clampNumber(o.bufferSec, BUFFER_SEC_MIN, BUFFER_SEC_MAX, BUFFER_SEC_DEFAULT) } : {})
                  })
                }
              />
              <DelayField
                label="编码缓冲 (秒)"
                hint={
                  o.buffered
                    ? `编码最多领先推流多少秒：${BUFFER_SEC_MIN}–${BUFFER_SEC_MAX} s。每 1 秒约占 码率/8 KB 内存，越大越能扛住编码变慢`
                    : '需先开启双引擎推流'
                }
                value={o.bufferSec}
                min={BUFFER_SEC_MIN}
                max={BUFFER_SEC_MAX}
                disabled={!o.buffered}
                // The floor is applied when the field is committed, not per keystroke:
                // a lead below the floor cannot cover a file change, but the
                // intermediate states of a number being typed are not numbers yet.
                onCommit={(bufferSec) => props.onUpdateOutput({ bufferSec })}
              />
            </div>
            <Toggle
              label="实时节奏推流 (-re)"
              hint="关闭缓冲时按源文件原速度推送"
              checked={o.realtimePacing}
              onChange={(c) => props.onUpdateOutput({ realtimePacing: c })}
            />
            <Toggle
              label="播放列表循环"
              hint="最后一个文件结束后回到第一个文件；关闭则结束时停止推流"
              checked={o.loopPlaylist}
              onChange={(c) => props.onUpdateOutput({ loopPlaylist: c })}
            />
            <Toggle
              label="丢弃迟到帧"
              hint="编码跟不上时丢帧而不是累积延迟，适合低延迟场景"
              checked={o.dropLateFrames}
              onChange={(c) => props.onUpdateOutput({ dropLateFrames: c })}
            />

            <div className="field-grid">
              <Field label="断线重连间隔 (秒)">
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={o.reconnectDelaySec}
                  onChange={(e) => props.onUpdateOutput({ reconnectDelaySec: Number(e.target.value) })}
                />
              </Field>
              <Field label="最大重连次数" hint="0 = 不自动重连">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={o.maxReconnectAttempts}
                  onChange={(e) => props.onUpdateOutput({ maxReconnectAttempts: Number(e.target.value) })}
                />
              </Field>
            </div>

            <h3 className="section-title">FFmpeg</h3>
            <div className="kv-list">
              <div className="kv">
                <span>ffmpeg 路径</span>
                <code>{caps?.ffmpegPath || '未找到'}</code>
              </div>
              <div className="kv">
                <span>ffprobe 路径</span>
                <code>{caps?.ffprobePath || '未找到'}</code>
              </div>
              <div className="kv">
                <span>版本</span>
                <code>{caps?.ffmpegVersion || '—'}</code>
              </div>
              <div className="kv">
                <span>来源</span>
                <code>{caps?.source ?? '—'}</code>
              </div>
            </div>

            <div className="row-actions">
              <button className="btn" onClick={props.onChooseFfmpeg}>
                手动指定 ffmpeg 路径
              </button>
              <button className="btn ghost" onClick={() => props.onRefreshCapabilities(true)} disabled={props.capsLoading}>
                {props.capsLoading ? '检测中…' : '重新检测编码器'}
              </button>
            </div>

            {caps && caps.warnings.length > 0 && (
              <div className="warnings">
                {caps.warnings.map((w, i) => (
                  <p key={i} className="warn small">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}

            <h3 className="section-title">可用编码器</h3>
            <div className="encoder-table">
              {caps?.encoders.map((e) => (
                <div key={e.value} className={`enc-row${e.available ? '' : ' off'}`}>
                  <span className={`dot ${e.available ? (e.kind === 'software' ? 'sw' : 'hw') : 'na'}`} />
                  <span className="enc-name">{e.label}</span>
                  <span className="enc-kind">{e.kind === 'software' ? '软件' : e.kind.toUpperCase()}</span>
                </div>
              ))}
            </div>

            <h3 className="section-title">关于</h3>
            <div className="kv-list">
              <div className="kv">
                <span>应用版本</span>
                <code>{props.info?.version ?? '—'}</code>
              </div>
              <div className="kv">
                <span>Electron / Chromium</span>
                <code>
                  {props.info?.electron ?? '—'} / {props.info?.chrome ?? '—'}
                </code>
              </div>
              <div className="kv">
                <span>平台</span>
                <code>
                  {props.info?.platform ?? '—'} {props.info?.arch ?? ''}
                </code>
              </div>
              <div className="kv">
                <span>配置目录</span>
                <code>{props.info?.userDataPath ?? '—'}</code>
              </div>
            </div>

            <h3 className="section-title">日志留存</h3>
            <Toggle
              label="调试输出 (debug)"
              hint="把 debug 级日志写进界面与日志文件；关闭后只保留 info 及以上——排查串流问题需要它，长期挂机可以关掉以减小日志体积"
              checked={props.settings.debugLogging}
              onChange={(c) => void props.onSaveSettings({ debugLogging: c })}
            />
            <div className="kv-list">
              <div className="kv">
                <span>日志目录</span>
                <code>{props.logInfo?.dir ?? '—'}</code>
              </div>
              <div className="kv">
                <span>当前占用</span>
                <code>
                  {props.logInfo
                    ? `${props.logInfo.fileCount} 个文件 / ${(props.logInfo.totalBytes / 1024).toFixed(0)} KB · 上限 ${(props.logInfo.budgetBytes / 1024 / 1024).toFixed(0)} MB`
                    : '—'}
                </code>
              </div>
            </div>
            <div className="row-actions">
              <button className="btn ghost" onClick={props.onOpenLogsDir}>
                📂 打开日志目录
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Preset bar — save / load every tab's settings as one named preset
 * ------------------------------------------------------------------ */

function PresetBar({
  presets,
  activePresetId,
  locked,
  onSelectPreset,
  onSavePreset,
  onDeletePreset,
  onOpenConfigDir
}: {
  presets: PresetsPayload | null
  activePresetId: string
  locked: boolean
  onSelectPreset: (preset: Preset) => void
  onSavePreset: (name: string) => void
  onDeletePreset: (presetId: string) => void
  onOpenConfigDir: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [name, setName] = useState('')

  const all = presets?.presets ?? []
  const active = all.find((p) => p.id === activePresetId)
  const userPresets = all.filter((p) => !p.builtin)
  const writable = presets?.location.writable ?? true

  const save = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSavePreset(trimmed)
    setName('')
    setMenuOpen(false)
  }

  const presetOptions = (
    <>
      <optgroup label="内置预设">
        {all
          .filter((p) => p.builtin)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </optgroup>
      {userPresets.length > 0 && (
        <optgroup label="我的预设">
          {userPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )

  return (
    <div className="preset-bar">
      <span className="preset-label">预设</span>

      <select
        className="preset-select"
        value={active?.id ?? ''}
        disabled={locked}
        onChange={(e) => {
          const preset = all.find((p) => p.id === e.target.value)
          if (preset) onSelectPreset(preset)
        }}
        title="应用一个预设（覆盖当前所有选项卡的设置）"
      >
        <option value="">（自定义）</option>
        {presetOptions}
      </select>

      {active?.builtin && <span className="badge subtle">内置</span>}

      <button className="btn tiny" onClick={() => setMenuOpen((v) => !v)} disabled={locked} title="把当前所有设置保存为预设">
        💾 保存为预设
      </button>

      {active && !active.builtin && (
        <button
          className="btn tiny danger"
          onClick={() => onDeletePreset(active.id)}
          disabled={locked}
          title={`删除预设「${active.name}」`}
        >
          删除
        </button>
      )}

      <button className="btn tiny ghost" onClick={onOpenConfigDir} title={presets?.location.dir ?? '数据目录'}>
        📂 数据目录
      </button>

      {menuOpen && (
        <div className="preset-menu">
          <div className="preset-menu-title">保存当前全部设置（视频/音频/字幕/输出/高级）为预设</div>
          <div className="preset-menu-row">
            <input
              autoFocus
              value={name}
              placeholder="预设名称，例如 1080p60 游戏直播"
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setMenuOpen(false)
              }}
            />
            <button className="btn primary" onClick={save} disabled={!name.trim()}>
              保存
            </button>
            <button className="btn ghost" onClick={() => setMenuOpen(false)}>
              取消
            </button>
          </div>
          <div className="preset-menu-note muted small">
            {writable ? (
              <>
                同名预设会被覆盖 · 保存位置：<code>{presets?.location.file ?? '—'}</code>
              </>
            ) : (
              <span className="warn">数据目录不可写：{presets?.location.dir}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Small building blocks
 * ------------------------------------------------------------------ */

/**
 * One labelled control.
 *
 * The optional hint is rendered *below* the control, not inside the label row:
 * labels stay single-line, so every control in a `field-grid` row starts at the
 * same offset no matter how long its explanation is.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <em className="field-hint">{hint}</em>}
    </label>
  )
}

/* ------------------------------------------------------------------ *
 * Stream delay (buffered playout)
 * ------------------------------------------------------------------ */

/**
 * Numeric field that lets the value be typed freely and clamps it on blur.
 *
 * Clamping on every keystroke fights the user: the intermediate states of a number
 * are not valid numbers (clearing the box reads as 0, and "1" on the way to "12"
 * trips a floor that is only meant for the committed value), so a floor applied per
 * keystroke makes the field awkward for anything but a single digit. The committed
 * value is what gets clamped, and the box is resynced to it so what is displayed is
 * always what the engine will use.
 */
function DelayField({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onCommit
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  disabled: boolean
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  // The stored value can change without the user typing (a preset, or the switch
  // raising a delay the engine would refuse), so the box follows it while idle.
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  const commit = (): void => {
    setEditing(false)
    // An emptied box falls back to the value already in force, not to the floor: the
    // user cleared the field rather than asking for a tenth of a second, and silently
    // dropping the delay to its minimum would look like a bug.
    const next = clampNumber(Number(draft), min, max, value)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step={0.1}
        disabled={disabled}
        value={draft}
        onChange={(e) => {
          setEditing(true)
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // Escape abandons the edit rather than committing a value the user is
          // halfway through typing.
          if (e.key === 'Escape') {
            setEditing(false)
            setDraft(String(value))
            e.currentTarget.blur()
          }
        }}
      />
    </Field>
  )
}

/* ------------------------------------------------------------------ *
 * Bitrate with a kbps / Mbps unit selector
 * ------------------------------------------------------------------ */

type BitrateUnit = 'kbps' | 'mbps'

/**
 * Stores the value in kbps (what ffmpeg and the presets use) but lets the user
 * type in either kbps or Mbps. The displayed number is derived from the unit so
 * switching units re-expresses the same rate instead of rescaling the input.
 */
function BitrateField({
  label,
  hint,
  valueKbps,
  minKbps = 0,
  allowZero = false,
  onChange
}: {
  label: string
  hint?: string
  valueKbps: number
  minKbps?: number
  allowZero?: boolean
  onChange: (kbps: number) => void
}): React.JSX.Element {
  const [unit, setUnit] = useState<BitrateUnit>('kbps')
  // Keep what the user typed so a partial entry (e.g. "1.") is not rewritten.
  const [draft, setDraft] = useState<string | null>(null)

  const display = draft ?? (unit === 'kbps' ? String(Math.round(valueKbps)) : trimZeros(valueKbps / 1000))

  const commit = (raw: string): void => {
    setDraft(raw)
    if (raw.trim() === '') return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return
    const kbps = unit === 'kbps' ? Math.round(parsed) : Math.round(parsed * 1000)
    if (kbps < minKbps) return
    if (!allowZero && kbps <= 0) return
    onChange(kbps)
  }

  const switchUnit = (next: BitrateUnit): void => {
    setUnit(next)
    setDraft(null)
  }

  return (
    <Field label={label} hint={hint}>
      <div className="unit-input">
        <input
          type="number"
          min={unit === 'kbps' ? minKbps : trimZeros(minKbps / 1000)}
          step={unit === 'kbps' ? 100 : 0.1}
          value={display}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setDraft(null)}
        />
        <select value={unit} onChange={(e) => switchUnit(e.target.value as BitrateUnit)} aria-label={`${label}单位`}>
          <option value="kbps">kbps</option>
          <option value="mbps">Mbps</option>
        </select>
      </div>
    </Field>
  )
}

function trimZeros(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

/** Keeps a numeric field inside its documented range without ever being NaN. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/* ------------------------------------------------------------------ *
 * Resolution: width + height + "auto" checkbox
 * ------------------------------------------------------------------ */

function ResolutionField({
  value,
  onChange
}: {
  value: VideoSettings
  onChange: (patch: Partial<VideoSettings>) => void
}): React.JSX.Element {
  const enabled = Boolean(value.scale?.trim())

  const setEnabled = (on: boolean): void => {
    onChange({
      scale: on ? (value.scaleAuto ? `${value.scaleWidth}:-2` : `${value.scaleWidth}:${value.scaleHeight}`) : '',
      scaleWidth: value.scaleWidth || 1920,
      scaleHeight: value.scaleHeight || 1080
    })
  }

  const setWidth = (width: number): void => {
    onChange({
      scaleWidth: width,
      scale: value.scaleAuto ? `${width}:-2` : `${width}:${value.scaleHeight}`
    })
  }

  const setHeight = (height: number): void => {
    onChange({
      scaleHeight: height,
      scale: `${value.scaleWidth}:${height}`
    })
  }

  const setAuto = (auto: boolean): void => {
    onChange({
      scaleAuto: auto,
      scale: auto ? `${value.scaleWidth}:-2` : `${value.scaleWidth}:${value.scaleHeight}`
    })
  }

  const applyPreset = (label: string): void => {
    const preset = SCALE_PRESETS.find((p) => p.label === label)
    if (!preset) return
    onChange({
      scaleWidth: preset.width,
      scaleHeight: preset.height,
      scale: value.scaleAuto ? `${preset.width}:-2` : `${preset.width}:${preset.height}`
    })
  }

  const activePreset = SCALE_PRESETS.find(
    (p) => p.width === value.scaleWidth && (value.scaleAuto || p.height === value.scaleHeight)
  )

  return (
    <div className="field res-field">
      <span className="field-label">分辨率</span>

      <div className="res-inputs">
        <label className="toggle compact res-enable">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="toggle-track" aria-hidden>
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-text">缩放输出</span>
        </label>

        <select
          className="res-preset"
          value={activePreset?.label ?? ''}
          disabled={!enabled}
          onChange={(e) => applyPreset(e.target.value)}
          aria-label="分辨率预设"
        >
          <option value="">自定义…</option>
          {SCALE_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
        </select>

        <div className="res-pair">
          <input
            type="number"
            min={2}
            step={2}
            value={value.scaleWidth || ''}
            disabled={!enabled}
            onChange={(e) => setWidth(Number(e.target.value) || 0)}
            aria-label="宽度"
            placeholder="宽"
          />
          <span className="res-x">×</span>
          <input
            type="number"
            min={2}
            step={2}
            value={value.scaleAuto ? '' : value.scaleHeight || ''}
            disabled={!enabled || value.scaleAuto}
            onChange={(e) => setHeight(Number(e.target.value) || 0)}
            aria-label="高度"
            placeholder={value.scaleAuto ? '自动' : '高'}
            title={value.scaleAuto ? '宽度自适应已开启，高度按源画面比例计算' : ''}
          />
        </div>

        <label className={`auto-check${!enabled ? ' disabled' : ''}`} title="勾选后高度按源画面比例自动计算（宽度 × 自动高度）">
          <input type="checkbox" checked={value.scaleAuto} disabled={!enabled} onChange={(e) => setAuto(e.target.checked)} />
          高度自适应
        </label>
      </div>
      <em className="field-hint">关闭「缩放输出」则保持源分辨率；高度自适应时按源画面比例计算</em>
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  compact
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <label className={`toggle${compact ? ' compact' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        {label}
        {hint && <em className="field-hint">{hint}</em>}
      </span>
    </label>
  )
}
