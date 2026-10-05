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
  TranslationKey,
  VideoCodecName,
  VideoEncoderChoice,
  VideoRateControl,
  VideoSettings
} from '@shared/types'
import { BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, OBS_PORT_MAX, OBS_PORT_MIN, SCALE_PRESETS } from '@shared/defaults'
import { useT } from '../i18n'

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
  onRenamePreset: (presetId: string, name: string) => void
  onOpenDataDir: () => void
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

const TABS: { key: TabKey; labelKey: TranslationKey; icon: string }[] = [
  { key: 'video', labelKey: 'settings.tabs.video', icon: '🎞' },
  { key: 'audio', labelKey: 'settings.tabs.audio', icon: '🔊' },
  { key: 'subtitle', labelKey: 'settings.tabs.subtitle', icon: '💬' },
  { key: 'output', labelKey: 'settings.tabs.output', icon: '📡' },
  { key: 'advanced', labelKey: 'settings.tabs.advanced', icon: '⚙' }
]

const CODEC_KEY: Record<VideoCodecName, TranslationKey> = {
  h264: 'settings.video.codec.h264',
  hevc: 'settings.video.codec.hevc',
  av1: 'settings.video.codec.av1',
  copy: 'settings.video.codec.copy'
}

const RATE_CONTROL_KEY: Record<VideoRateControl, TranslationKey> = {
  cbr: 'settings.video.rc.cbr',
  vbr: 'settings.video.rc.vbr',
  abr: 'settings.video.rc.abr',
  crf: 'settings.video.rc.crf',
  auto: 'settings.video.rc.auto'
}

const AUDIO_CODEC_KEY: Record<AudioCodecName, TranslationKey> = {
  aac: 'settings.audio.codec.aac',
  libmp3lame: 'settings.audio.codec.mp3',
  libopus: 'settings.audio.codec.opus',
  copy: 'settings.audio.codec.copy',
  none: 'settings.audio.codec.none'
}

const CONTAINER_KEY: Record<ContainerName, TranslationKey> = {
  flv: 'settings.output.container.flv',
  mpegts: 'settings.output.container.mpegts',
  mkv: 'settings.output.container.mkv'
}

/** Libass alignment values, in the order the select lists them. */
const ALIGNMENT_KEY: Record<number, TranslationKey> = {
  1: 'settings.subtitle.align.bottomLeft',
  2: 'settings.subtitle.align.bottomCenter',
  3: 'settings.subtitle.align.bottomRight',
  4: 'settings.subtitle.align.middleLeft',
  5: 'settings.subtitle.align.middleCenter',
  6: 'settings.subtitle.align.middleRight',
  7: 'settings.subtitle.align.topLeft',
  8: 'settings.subtitle.align.topCenter',
  9: 'settings.subtitle.align.topRight'
}

export default function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const t = useT()
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
    return [
      {
        value: 'auto' as VideoEncoderChoice,
        label: t('settings.video.encoder.auto'),
        available: true,
        presets: [] as string[],
        kind: 'auto',
        codec: v.codec,
        verified: undefined as boolean | undefined,
        note: undefined as string | undefined
      },
      ...list
    ]
  }, [caps, t, v.codec])

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
        () => resolve({ ok: false, message: t('settings.output.testTimeout'), detail: '', elapsedMs: 31000 }),
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
        onRenamePreset={props.onRenamePreset}
        onOpenDataDir={props.onOpenDataDir}
      />

      <nav className="tabs">
        {TABS.map((tabDef) => (
          <button key={tabDef.key} className={`tab${tab === tabDef.key ? ' active' : ''}`} onClick={() => setTab(tabDef.key)}>
            <span className="tab-icon">{tabDef.icon}</span>
            {t(tabDef.labelKey)}
          </button>
        ))}
      </nav>

      {props.locked && (
        <div className="lock-note">
          <span>{t('settings.lockedNote')}</span>
        </div>
      )}

      <div className="settings-body" inert={props.locked}>
        {/* ---------------------------------------------------------- VIDEO */}
        {tab === 'video' && (
          <>
            <Field label={t('settings.video.codec')} hint={t('settings.video.codecHint')}>
              <select value={v.codec} onChange={(e) => props.onUpdateVideo({ codec: e.target.value as VideoCodecName, encoder: 'auto' })}>
                {(Object.keys(CODEC_KEY) as VideoCodecName[]).map((c) => (
                  <option key={c} value={c}>
                    {t(CODEC_KEY[c])}
                  </option>
                ))}
              </select>
            </Field>

            {v.codec !== 'copy' && (
              <>
                <Field label={t('settings.video.encoder')} hint={t('settings.video.encoderHint')}>
                  <select value={v.encoder} onChange={(e) => props.onUpdateVideo({ encoder: e.target.value as VideoEncoderChoice })}>
                    {encoderOptions.map((e) => (
                      <option key={e.value} value={e.value} disabled={!e.available && e.value !== 'auto'}>
                        {e.label}
                        {e.value !== 'auto' && !e.available ? t('settings.video.encoderUnavailable') : ''}
                        {e.verified ? ' ✓' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                {activeEncoder?.note && <p className="hint warn small">{activeEncoder.note}</p>}

                <div className="field-grid">
                  <Field label={t('settings.video.rateControl')}>
                    <select value={v.rateControl} onChange={(e) => props.onUpdateVideo({ rateControl: e.target.value as VideoRateControl })}>
                      {(Object.keys(RATE_CONTROL_KEY) as VideoRateControl[])
                        .filter((r) => r !== 'auto')
                        .map((r) => (
                          <option key={r} value={r}>
                            {t(RATE_CONTROL_KEY[r])}
                          </option>
                        ))}
                    </select>
                  </Field>

                  {v.rateControl === 'crf' ? (
                    <Field label={t('settings.video.crf')} hint={t('settings.video.crfHint')}>
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
                      label={t('settings.video.bitrate')}
                      hint={t('settings.video.bitrateHint')}
                      valueKbps={v.bitrateKbps}
                      minKbps={100}
                      onChange={(bitrateKbps) => props.onUpdateVideo({ bitrateKbps })}
                    />
                  )}

                  {v.rateControl !== 'cbr' && v.rateControl !== 'crf' && (
                    <BitrateField
                      label={t('settings.video.maxBitrate')}
                      valueKbps={v.maxBitrateKbps}
                      minKbps={100}
                      onChange={(maxBitrateKbps) => props.onUpdateVideo({ maxBitrateKbps })}
                    />
                  )}

                  <BitrateField
                    label={t('settings.video.bufferSize')}
                    hint={t('settings.video.bufferSizeHint')}
                    valueKbps={v.bufferSizeKbps}
                    minKbps={0}
                    allowZero
                    onChange={(bufferSizeKbps) => props.onUpdateVideo({ bufferSizeKbps })}
                  />
                </div>

                <div className="field-grid">
                  <Field label={t('settings.video.preset')} hint={t('settings.video.presetHint')}>
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

                  <Field label={t('settings.video.tune')}>
                    <select value={v.tune} onChange={(e) => props.onUpdateVideo({ tune: e.target.value })}>
                      <option value="">{t('settings.video.tuneUnset')}</option>
                      <option value="zerolatency">{t('settings.video.tune.zerolatency')}</option>
                      <option value="film">{t('settings.video.tune.film')}</option>
                      <option value="animation">{t('settings.video.tune.animation')}</option>
                      <option value="grain">{t('settings.video.tune.grain')}</option>
                      <option value="fastdecode">{t('settings.video.tune.fastdecode')}</option>
                    </select>
                  </Field>

                  <Field label={t('settings.video.profile')}>
                    <select value={v.profile} onChange={(e) => props.onUpdateVideo({ profile: e.target.value })}>
                      <option value="">{t('settings.video.tuneUnset')}</option>
                      <option value="baseline">{t('settings.video.profile.baseline')}</option>
                      <option value="main">main</option>
                      <option value="high">{t('settings.video.profile.high')}</option>
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

              <Field label={t('settings.video.fps')} hint={t('settings.video.fpsHint')}>
                <input type="number" min={0} max={240} value={v.fps} onChange={(e) => props.onUpdateVideo({ fps: Number(e.target.value) })} />
              </Field>

              <Field label={t('settings.video.keyframe')} hint={t('settings.video.keyframeHint')}>
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={v.keyframeIntervalSec}
                  onChange={(e) => props.onUpdateVideo({ keyframeIntervalSec: Number(e.target.value) })}
                />
              </Field>

              <Field label={t('settings.video.bFrames')} hint={t('settings.video.bFramesHint')}>
                <input type="number" min={0} max={4} value={v.bFrames} onChange={(e) => props.onUpdateVideo({ bFrames: Number(e.target.value) })} />
              </Field>
            </div>

            <div className="field-grid">
              <Field label={t('settings.video.pixelFormat')} hint={t('settings.video.pixelFormatHint')}>
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
              label={t('settings.video.repeatHeaders')}
              hint={t('settings.video.repeatHeadersHint')}
              checked={v.repeatHeaders}
              onChange={(checked) => props.onUpdateVideo({ repeatHeaders: checked })}
            />
          </>
        )}

        {/* ---------------------------------------------------------- AUDIO */}
        {tab === 'audio' && (
          <>
            <Field label={t('settings.audio.codec')} hint={t('settings.audio.codecHint')}>
              <select value={a.codec} onChange={(e) => props.onUpdateAudio({ codec: e.target.value as AudioCodecName })}>
                {(Object.keys(AUDIO_CODEC_KEY) as AudioCodecName[]).map((c) => {
                  const supported = caps?.audioEncoders.find((x) => x.value === c)
                  const disabled = c !== 'copy' && c !== 'none' && supported ? !supported.available : false
                  return (
                    <option key={c} value={c} disabled={disabled}>
                      {t(AUDIO_CODEC_KEY[c])}
                      {disabled ? t('settings.audio.codecUnsupported') : ''}
                    </option>
                  )
                })}
              </select>
            </Field>

            {a.codec !== 'copy' && a.codec !== 'none' && (
              <>
                <div className="field-grid">
                  <Field label={t('settings.audio.bitrate')} hint={t('settings.audio.bitrateHint')}>
                    <input
                      type="number"
                      min={16}
                      max={512}
                      step={8}
                      value={a.bitrateKbps}
                      onChange={(e) => props.onUpdateAudio({ bitrateKbps: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label={t('settings.audio.sampleRate')}>
                    <select value={a.sampleRate} onChange={(e) => props.onUpdateAudio({ sampleRate: Number(e.target.value) })}>
                      <option value={48000}>48000</option>
                      <option value={44100}>44100</option>
                      <option value={32000}>32000</option>
                      <option value={22050}>22050</option>
                    </select>
                  </Field>
                  <Field label={t('settings.audio.channels')}>
                    <select value={a.channels} onChange={(e) => props.onUpdateAudio({ channels: Number(e.target.value) })}>
                      <option value={2}>{t('settings.audio.stereo')}</option>
                      <option value={1}>{t('settings.audio.mono')}</option>
                    </select>
                  </Field>
                  <Field label={t('settings.audio.rateControl')}>
                    <select value={a.rateControl} onChange={(e) => props.onUpdateAudio({ rateControl: e.target.value as AudioRateControl })}>
                      <option value="cbr">{t('settings.audio.rc.cbr')}</option>
                      <option value="vbr">{t('settings.audio.rc.vbr')}</option>
                    </select>
                  </Field>
                </div>

                <Toggle
                  label={t('settings.audio.loudnorm')}
                  hint={t('settings.audio.loudnormHint')}
                  checked={a.loudnorm}
                  onChange={(checked) => props.onUpdateAudio({ loudnorm: checked })}
                />
              </>
            )}

            {a.codec === 'copy' && <p className="hint small">{t('settings.audio.copyHint')}</p>}
          </>
        )}

        {/* ------------------------------------------------------- SUBTITLE */}
        {tab === 'subtitle' && (
          <>
            <Field label={t('settings.subtitle.mode')} hint={t('settings.subtitle.modeHint')}>
              <select value={s.mode} onChange={(e) => props.onUpdateSubtitles({ mode: e.target.value as SubtitleMode })}>
                <option value="off">{t('settings.subtitle.modeOff')}</option>
                <option value="burn">{t('settings.subtitle.modeBurn')}</option>
                <option value="copy">{t('settings.subtitle.modeCopy')}</option>
              </select>
            </Field>

            {s.mode === 'burn' && (
              <>
                <Field label={t('settings.subtitle.styleSource')} hint={t('settings.subtitle.styleSourceHint')}>
                  <select
                    value={s.styleMode}
                    onChange={(e) => props.onUpdateSubtitles({ styleMode: e.target.value as SubtitleRenderSettings['styleMode'] })}
                  >
                    <option value="preserve">{t('settings.subtitle.stylePreserve')}</option>
                    <option value="force">{t('settings.subtitle.styleForce')}</option>
                    <option value="plain">{t('settings.subtitle.stylePlain')}</option>
                  </select>
                </Field>

                {s.styleMode !== 'preserve' && (
                  <>
                    <div className="field-grid">
                      <Field label={t('settings.subtitle.fontName')} hint={t('settings.subtitle.fontNameHint')}>
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
                      <Field label={t('settings.subtitle.fontSize')}>
                        <input
                          type="number"
                          min={8}
                          max={120}
                          value={s.fontSize}
                          onChange={(e) => props.onUpdateSubtitles({ fontSize: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label={t('settings.subtitle.outlineWidth')}>
                        <input
                          type="number"
                          min={0}
                          max={10}
                          step={0.5}
                          value={s.outlineWidth}
                          onChange={(e) => props.onUpdateSubtitles({ outlineWidth: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label={t('settings.subtitle.shadow')}>
                        <input type="number" min={0} max={10} value={s.shadow} onChange={(e) => props.onUpdateSubtitles({ shadow: Number(e.target.value) })} />
                      </Field>
                    </div>

                    <div className="field-grid">
                      <Field label={t('settings.subtitle.primaryColor')}>
                        <div className="color-row">
                          <input
                            type="color"
                            value={s.primaryColor}
                            onChange={(e) => props.onUpdateSubtitles({ primaryColor: e.target.value })}
                          />
                          <input value={s.primaryColor} onChange={(e) => props.onUpdateSubtitles({ primaryColor: e.target.value })} />
                        </div>
                      </Field>
                      <Field label={t('settings.subtitle.outlineColor')}>
                        <div className="color-row">
                          <input
                            type="color"
                            value={s.outlineColor}
                            onChange={(e) => props.onUpdateSubtitles({ outlineColor: e.target.value })}
                          />
                          <input value={s.outlineColor} onChange={(e) => props.onUpdateSubtitles({ outlineColor: e.target.value })} />
                        </div>
                      </Field>
                      <Field label={t('settings.subtitle.marginVertical')}>
                        <input
                          type="number"
                          min={0}
                          max={400}
                          value={s.marginVertical}
                          onChange={(e) => props.onUpdateSubtitles({ marginVertical: Number(e.target.value) })}
                        />
                      </Field>
                      <Field label={t('settings.subtitle.alignment')}>
                        <select value={s.alignment} onChange={(e) => props.onUpdateSubtitles({ alignment: Number(e.target.value) })}>
                          {(Object.keys(ALIGNMENT_KEY).map(Number) as number[]).map((value) => (
                            <option key={value} value={value}>
                              {t(ALIGNMENT_KEY[value])}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>

                    <div className="toggle-row">
                      <Toggle label={t('settings.subtitle.bold')} checked={s.bold} onChange={(c) => props.onUpdateSubtitles({ bold: c })} compact />
                      <Toggle label={t('settings.subtitle.italic')} checked={s.italic} onChange={(c) => props.onUpdateSubtitles({ italic: c })} compact />
                    </div>
                  </>
                )}

                <p className="hint small">
                  {/* Split around the conditional <strong> so each language can order
                      the two pieces its own way. */}
                  {t('settings.subtitle.burnHint1')}
                  {caps && !caps.hasSubtitleFilter && <strong className="warn">{t('settings.subtitle.burnHint3')}</strong>}
                </p>
              </>
            )}

            {s.mode === 'copy' && <p className="hint warn small">{t('settings.subtitle.copyHint')}</p>}
          </>
        )}

        {/* --------------------------------------------------------- OUTPUT */}
        {tab === 'output' && (
          <>
            <Field label={t('settings.output.server')}>
              <input
                value={o.server}
                placeholder="rtmp://127.0.0.1/live/"
                onChange={(e) => props.onUpdateOutput({ server: e.target.value })}
                spellCheck={false}
              />
            </Field>

            <Field label={t('settings.output.streamKey')} hint={t('settings.output.streamKeyHint')}>
              <div className="secret-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={o.streamKey}
                  placeholder={t('settings.output.nonePlaceholder')}
                  onChange={(e) => props.onUpdateOutput({ streamKey: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button type="button" className="btn tiny ghost secret-toggle" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? t('settings.output.hide') : t('settings.output.show')}
                </button>
              </div>
            </Field>

            <div className="row-actions">
              <button className="btn primary" onClick={runTest} disabled={testState.running || props.busy}>
                {testState.running ? t('settings.output.testing') : t('settings.output.testConnection')}
              </button>
              <button className="btn ghost" onClick={showCommand}>
                {t('settings.output.viewCommand')}
              </button>
            </div>

            {testState.result && (
              <div className={`test-result ${testState.result.ok ? 'ok' : 'fail'}`}>
                <strong>{testState.result.ok ? t('settings.output.testOk') : t('settings.output.testFail')}</strong>
                <p>{testState.result.message}</p>
                {testState.result.summary && testState.result.summary.length > 0 && (
                  <p className="test-summary">{t('settings.output.testSummary', { summary: testState.result.summary.join(' · ') })}</p>
                )}
                {testState.result.notes?.map((n) => (
                  <p className="hint warn small" key={n}>
                    {n}
                  </p>
                ))}
                {testState.result.detail && (
                  <details>
                    <summary>{t('settings.output.ffmpegOutput')}</summary>
                    <pre>{testState.result.detail}</pre>
                  </details>
                )}
              </div>
            )}

            {commandPreview && (
              <div className="command-preview">
                <div className="cp-head">
                  <span>{t('settings.output.commandPreviewTitle')}</span>
                  <div>
                    <button
                      className="btn tiny"
                      onClick={() => {
                        void navigator.clipboard.writeText(commandPreview)
                      }}
                    >
                      {t('settings.output.copy')}
                    </button>
                    <button className="btn tiny ghost" onClick={() => setCommandPreview(null)}>
                      {t('app.close')}
                    </button>
                  </div>
                </div>
                <pre>{commandPreview}</pre>
              </div>
            )}

            <Field label={t('settings.output.container')}>
              <select value={o.container} onChange={(e) => props.onUpdateOutput({ container: e.target.value as ContainerName })}>
                {(Object.keys(CONTAINER_KEY) as ContainerName[]).map((c) => {
                  const supported = caps?.containerFormats.find((x) => x.value === c)
                  return (
                    <option key={c} value={c} disabled={supported ? !supported.available : false}>
                      {t(CONTAINER_KEY[c])}
                      {supported && !supported.available ? t('settings.audio.codecUnsupported') : ''}
                    </option>
                  )
                })}
              </select>
            </Field>

            <Field label={t('settings.output.extraArgs')} hint={t('settings.output.extraArgsHint')}>
              <input
                value={o.extraOutputArgs}
                placeholder=""
                onChange={(e) => props.onUpdateOutput({ extraOutputArgs: e.target.value })}
                spellCheck={false}
              />
            </Field>

            {/* ------------------------------------- OBS WebSocket ---------- */}
            <h3 className="section-title">{t('settings.obs.title')}</h3>
            <Toggle
              label={t('settings.obs.enabled')}
              hint={t('settings.obs.enabledHint')}
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
                  <Field label={t('settings.obs.host')}>
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
                  <Field label={t('settings.obs.port')}>
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
                  <Field label={t('settings.obs.password')} hint={t('settings.obs.passwordHint')}>
                    <div className="secret-row">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={o.obsWebSocket.password}
                        placeholder={t('settings.output.nonePlaceholder')}
                        onChange={(e) => {
                          updateObs({ password: e.target.value })
                          applyObs()
                        }}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button type="button" className="btn tiny ghost secret-toggle" onClick={() => setShowKey((v) => !v)}>
                        {showKey ? t('settings.output.hide') : t('settings.output.show')}
                      </button>
                    </div>
                  </Field>
                </div>

                <div className="row-actions">
                  <button className="btn" onClick={() => void applyObsNow()} disabled={obsRestarting}>
                    {obsRestarting ? t('settings.obs.applying') : t('settings.obs.apply')}
                  </button>
                  <span className={`pill ${props.obsStatus?.running ? 'ok' : 'subtle'}`}>
                    {props.obsStatus?.running
                      ? t('settings.obs.running', { url: props.obsStatus.url })
                      : props.obsStatus?.error
                        ? t('settings.obs.error', { error: props.obsStatus.error })
                        : t('settings.obs.notRunning')}
                  </span>
                  {props.obsStatus?.running && props.obsStatus.clients > 0 && (
                    <span className="pill subtle">{t('settings.obs.clients', { n: props.obsStatus.clients })}</span>
                  )}
                </div>

                <p className="hint small">
                  {t('settings.obs.compatHint1')}
                  {t('settings.obs.compatHint2')}
                </p>
              </>
            )}
          </>
        )}

        {/* ------------------------------------------------------- ADVANCED */}
        {tab === 'advanced' && (
          <>
            <h3 className="section-title">{t('settings.advanced.streamControl')}</h3>
            {/*
              The switch and its delay share a row, switch first: the delay only means
              anything while buffering is on, and reading them side by side is what
              makes that dependency visible. The delay stays in the DOM while disabled
              rather than disappearing, so the row does not reflow when it is toggled.
            */}
            <div className="field-grid stream-mode-grid">
              <Toggle
                label={t('settings.advanced.buffered')}
                hint={t('settings.advanced.bufferedHint')}
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
                label={t('settings.advanced.bufferSec')}
                hint={
                  o.buffered
                    ? t('settings.advanced.bufferHint', { min: BUFFER_SEC_MIN, max: BUFFER_SEC_MAX })
                    : t('settings.advanced.bufferHintDisabled')
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
              label={t('settings.advanced.realtimePacing')}
              hint={t('settings.advanced.realtimePacingHint')}
              checked={o.realtimePacing}
              onChange={(c) => props.onUpdateOutput({ realtimePacing: c })}
            />
            <Toggle
              label={t('settings.advanced.loop')}
              hint={t('settings.advanced.loopHint')}
              checked={o.loopPlaylist}
              onChange={(c) => props.onUpdateOutput({ loopPlaylist: c })}
            />
            <Toggle
              label={t('settings.advanced.dropLateFrames')}
              hint={t('settings.advanced.dropLateFramesHint')}
              checked={o.dropLateFrames}
              onChange={(c) => props.onUpdateOutput({ dropLateFrames: c })}
            />

            <div className="field-grid">
              <Field label={t('settings.advanced.reconnectDelay')}>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={o.reconnectDelaySec}
                  onChange={(e) => props.onUpdateOutput({ reconnectDelaySec: Number(e.target.value) })}
                />
              </Field>
              <Field label={t('settings.advanced.maxReconnect')} hint={t('settings.advanced.maxReconnectHint')}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={o.maxReconnectAttempts}
                  onChange={(e) => props.onUpdateOutput({ maxReconnectAttempts: Number(e.target.value) })}
                />
              </Field>
            </div>

            <h3 className="section-title">{t('settings.advanced.ffmpegSection')}</h3>
            <div className="kv-list">
              <div className="kv">
                <span>{t('settings.advanced.ffmpegPath')}</span>
                <code>{caps?.ffmpegPath || t('settings.advanced.notFound')}</code>
              </div>
              <div className="kv">
                <span>{t('settings.advanced.ffprobePath')}</span>
                <code>{caps?.ffprobePath || t('settings.advanced.notFound')}</code>
              </div>
              <div className="kv">
                <span>{t('settings.advanced.version')}</span>
                <code>{caps?.ffmpegVersion || '—'}</code>
              </div>
              <div className="kv">
                <span>{t('settings.advanced.source')}</span>
                <code>{caps?.source ?? '—'}</code>
              </div>
            </div>

            <div className="row-actions">
              <button className="btn" onClick={props.onChooseFfmpeg}>
                {t('settings.advanced.chooseFfmpeg')}
              </button>
              <button className="btn ghost" onClick={() => props.onRefreshCapabilities(true)} disabled={props.capsLoading}>
                {props.capsLoading ? t('settings.advanced.detecting') : t('settings.advanced.redetect')}
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

            <h3 className="section-title">{t('settings.advanced.availableEncoders')}</h3>
            <div className="encoder-table">
              {caps?.encoders.map((e) => (
                <div key={e.value} className={`enc-row${e.available ? '' : ' off'}`}>
                  <span className={`dot ${e.available ? (e.kind === 'software' ? 'sw' : 'hw') : 'na'}`} />
                  <span className="enc-name">{e.label}</span>
                  <span className="enc-kind">{e.kind === 'software' ? t('settings.advanced.software') : e.kind.toUpperCase()}</span>
                </div>
              ))}
            </div>

            <h3 className="section-title">{t('settings.about.title')}</h3>
            <div className="kv-list">
              <div className="kv">
                <span>{t('settings.about.version')}</span>
                <code>{props.info?.version ?? '—'}</code>
              </div>
              <div className="kv">
                <span>Electron / Chromium</span>
                <code>
                  {props.info?.electron ?? '—'} / {props.info?.chrome ?? '—'}
                </code>
              </div>
              <div className="kv">
                <span>{t('settings.about.platform')}</span>
                <code>
                  {props.info?.platform ?? '—'} {props.info?.arch ?? ''}
                </code>
              </div>
              <div className="kv">
                <span>{t('settings.about.configDir')}</span>
                <code>{props.info?.userDataPath ?? '—'}</code>
              </div>
            </div>

            <h3 className="section-title">{t('settings.advanced.logRetention')}</h3>
            <Toggle
              label={t('settings.advanced.debugLogging')}
              hint={t('settings.advanced.debugLoggingHint')}
              checked={props.settings.debugLogging}
              onChange={(c) => void props.onSaveSettings({ debugLogging: c })}
            />
            <div className="kv-list">
              <div className="kv">
                <span>{t('settings.advanced.logsDir')}</span>
                <code>{props.logInfo?.dir ?? '—'}</code>
              </div>
              <div className="kv">
                <span>{t('settings.advanced.logUsage')}</span>
                <code>
                  {props.logInfo
                    ? t('settings.advanced.logUsageValue', {
                        n: props.logInfo.fileCount,
                        kb: (props.logInfo.totalBytes / 1024).toFixed(0),
                        mb: (props.logInfo.budgetBytes / 1024 / 1024).toFixed(0)
                      })
                    : '—'}
                </code>
              </div>
            </div>
            <div className="row-actions">
              <button className="btn ghost" onClick={props.onOpenLogsDir}>
                {t('settings.advanced.openLogsDir')}
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
  onRenamePreset,
  onOpenDataDir
}: {
  presets: PresetsPayload | null
  activePresetId: string
  locked: boolean
  onSelectPreset: (preset: Preset) => void
  onSavePreset: (name: string) => void
  onDeletePreset: (presetId: string) => void
  onRenamePreset: (presetId: string, name: string) => void
  onOpenDataDir: () => void
}): React.JSX.Element {
  const t = useT()
  /** Which inline form the "save / rename" row is showing, if any. */
  const [menu, setMenu] = useState<'none' | 'save' | 'rename'>('none')
  const [name, setName] = useState('')

  const all = presets?.presets ?? []
  const active = all.find((p) => p.id === activePresetId)
  const userPresets = all.filter((p) => !p.builtin)
  const writable = presets?.location.writable ?? true

  const closeMenu = (): void => {
    setMenu('none')
    setName('')
  }

  const save = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSavePreset(trimmed)
    closeMenu()
  }

  const rename = (): void => {
    const trimmed = name.trim()
    if (!active || !trimmed) return
    onRenamePreset(active.id, trimmed)
    closeMenu()
  }

  /**
   * Opens one of the two inline forms, or closes it when it is already open.
   *
   * Save starts empty so pressing the button twice cannot silently overwrite the
   * active preset with its own name; rename starts from the current name because
   * that is what the operator is about to edit.
   */
  const toggleMenu = (kind: 'save' | 'rename'): void => {
    if (menu === kind) return closeMenu()
    setName(kind === 'rename' ? (active?.name ?? '') : '')
    setMenu(kind)
  }

  const presetOptions = (
    <>
      <optgroup label={t('settings.preset.builtinGroup')}>
        {all
          .filter((p) => p.builtin)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </optgroup>
      {userPresets.length > 0 && (
        <optgroup label={t('settings.preset.userGroup')}>
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
      <span className="preset-label">{t('settings.preset.label')}</span>

      <select
        className="preset-select"
        value={active?.id ?? ''}
        disabled={locked}
        onChange={(e) => {
          const preset = all.find((p) => p.id === e.target.value)
          if (preset) onSelectPreset(preset)
        }}
        title={t('settings.preset.selectTitle')}
      >
        <option value="">{t('settings.preset.custom')}</option>
        {presetOptions}
      </select>

      {active?.builtin && <span className="badge subtle">{t('settings.preset.builtinBadge')}</span>}

      <button
        className="btn tiny"
        onClick={() => toggleMenu('save')}
        disabled={locked}
        title={t('settings.preset.saveTitle')}
      >
        {t('settings.preset.saveAs')}
      </button>

      {active && !active.builtin && (
        <>
          <button
            className="btn tiny"
            onClick={() => toggleMenu('rename')}
            disabled={locked}
            title={t('settings.preset.renameTitle', { name: active.name })}
          >
            {t('settings.preset.rename')}
          </button>
          <button
            className="btn tiny danger"
            onClick={() => {
              closeMenu()
              onDeletePreset(active.id)
            }}
            disabled={locked}
            title={t('settings.preset.deleteTitle', { name: active.name })}
          >
            {t('settings.preset.delete')}
          </button>
        </>
      )}

      <button className="btn tiny ghost" onClick={onOpenDataDir} title={presets?.location.dir ?? t('settings.preset.dataDirTitle')}>
        {t('settings.preset.dataDir')}
      </button>

      {menu !== 'none' && (
        <div className="preset-menu" data-mode={menu}>
          <div className="preset-menu-title">
            {menu === 'save' ? t('settings.preset.menuTitle') : t('settings.preset.renameMenuTitle')}
          </div>
          <div className="preset-menu-row">
            <input
              autoFocus
              value={name}
              placeholder={t('settings.preset.namePlaceholder')}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (menu === 'save' ? save : rename)()
                if (e.key === 'Escape') closeMenu()
              }}
            />
            <button className="btn primary" onClick={menu === 'save' ? save : rename} disabled={!name.trim()}>
              {menu === 'save' ? t('settings.preset.saveButton') : t('settings.preset.renameButton')}
            </button>
            <button className="btn ghost" onClick={closeMenu}>
              {t('settings.preset.cancel')}
            </button>
          </div>
          <div className="preset-menu-note muted small">
            {writable ? (
              <>
                {menu === 'save' ? t('settings.preset.overwriteNote') : t('settings.preset.renameNote')}{' '}
                <code>{presets?.location.file ?? '—'}</code>
              </>
            ) : (
              <span className="warn">{t('settings.preset.notWritable', { dir: presets?.location.dir ?? '—' })}</span>
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
  const t = useT()
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
        <select value={unit} onChange={(e) => switchUnit(e.target.value as BitrateUnit)} aria-label={t('settings.video.bitrateUnitAria', { label })}>
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
  const t = useT()
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
      <span className="field-label">{t('settings.video.resolution')}</span>

      <div className="res-inputs">
        <label className="toggle compact res-enable">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="toggle-track" aria-hidden>
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-text">{t('settings.video.scaleOutput')}</span>
        </label>

        <select
          className="res-preset"
          value={activePreset?.label ?? ''}
          disabled={!enabled}
          onChange={(e) => applyPreset(e.target.value)}
          aria-label={t('settings.video.resolutionPresetAria')}
        >
          <option value="">{t('settings.video.resolutionCustom')}</option>
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
            aria-label={t('settings.video.widthAria')}
            placeholder={t('settings.video.widthPlaceholder')}
          />
          <span className="res-x">×</span>
          <input
            type="number"
            min={2}
            step={2}
            value={value.scaleAuto ? '' : value.scaleHeight || ''}
            disabled={!enabled || value.scaleAuto}
            onChange={(e) => setHeight(Number(e.target.value) || 0)}
            aria-label={t('settings.video.heightAria')}
            placeholder={value.scaleAuto ? t('settings.video.rc.auto') : t('settings.video.heightPlaceholder')}
            title={value.scaleAuto ? t('settings.video.heightAutoTitle') : ''}
          />
        </div>

        <label className={`auto-check${!enabled ? ' disabled' : ''}`} title={t('settings.video.scaleAutoTitle')}>
          <input type="checkbox" checked={value.scaleAuto} disabled={!enabled} onChange={(e) => setAuto(e.target.checked)} />
          {t('settings.video.scaleAutoLabel')}
        </label>
      </div>
      <em className="field-hint">{t('settings.video.scaleHint')}</em>
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
