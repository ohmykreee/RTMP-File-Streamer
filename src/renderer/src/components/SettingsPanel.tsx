import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AudioLines,
  Bookmark,
  Captions,
  CircleCheck,
  CircleX,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  Gauge,
  Info,
  Lock,
  PenLine,
  PlugZap,
  Radio,
  RefreshCw,
  Save,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Terminal,
  Trash2,
  TriangleAlert,
  Webhook,
  X
} from 'lucide-react'
import { cn } from 'cn'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Field as FieldShell, FieldDescription, FieldGroup, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@renderer/components/ui/native-select'
import { Separator } from '@renderer/components/ui/separator'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type {
  AppInfo,
  AppSettings,
  AudioCodecName,
  AudioRateControl,
  AudioSettings,
  FfmpegCapabilities,
  ObsWebSocketSettings,
  ObsWebSocketStatus,
  OutputSettings,
  PersistedLogInfo,
  Preset,
  PresetsPayload,
  RtmpTestResult,
  StreamNetwork,
  StreamProtocol,
  SubtitleRenderSettings,
  SubtitleMode,
  ThemePreference,
  TranslationKey,
  VideoCodecName,
  VideoEncoderChoice,
  VideoRateControl,
  VideoSettings
} from '@shared/types'
import { BUFFER_SEC_DEFAULT, BUFFER_SEC_MAX, BUFFER_SEC_MIN, OBS_PORT_MAX, OBS_PORT_MIN, SCALE_PRESETS } from '@shared/defaults'
import { LANGUAGE_NATIVE_NAME, LANGUAGES, type Language } from '@shared/i18n'
import { detectStreamProtocol, networkForProtocol, PROTOCOL_NETWORKS, STREAM_PROTOCOLS } from '@shared/protocol'
import NumberInput from './NumberInput'
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
  /** Switch the interface language; an application decision, not a session setting. */
  onChangeLanguage: (language: Language) => void
  /** Restart the control endpoint after its settings changed. */
  onApplyObsWebSocket: () => Promise<ObsWebSocketStatus | null>
}

type TabKey = 'video' | 'audio' | 'subtitle' | 'output' | 'advanced'

const TABS: { key: TabKey; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { key: 'video', labelKey: 'settings.tabs.video', icon: Film },
  { key: 'audio', labelKey: 'settings.tabs.audio', icon: AudioLines },
  { key: 'subtitle', labelKey: 'settings.tabs.subtitle', icon: Captions },
  { key: 'output', labelKey: 'settings.tabs.output', icon: Radio },
  { key: 'advanced', labelKey: 'settings.tabs.advanced', icon: Settings2 }
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

const PROTOCOL_KEY: Record<StreamProtocol, TranslationKey> = {
  rtmp: 'settings.output.protocol.rtmp',
  srt: 'settings.output.protocol.srt',
  rtsp: 'settings.output.protocol.rtsp',
  whip: 'settings.output.protocol.whip'
}

/** Per-protocol meaning of the stream key field; see `@shared/protocol`. */
const STREAM_KEY_HINT: Record<StreamProtocol, TranslationKey> = {
  rtmp: 'settings.output.streamKeyHint',
  srt: 'settings.output.streamKeyHintSrt',
  rtsp: 'settings.output.streamKeyHintRtsp',
  whip: 'settings.output.streamKeyHintWhip'
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

/** Appearance options, in the order the select lists them. */
const THEME_KEY: Record<ThemePreference, TranslationKey> = {
  light: 'settings.ui.themeLight',
  dark: 'settings.ui.themeDark',
  system: 'settings.ui.themeSystem'
}

export default function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  const t = useT()
  const { settings, capabilities: caps } = props
  const [tab, setTab] = useState<TabKey>('video')
  const [testState, setTestState] = useState<{ running: boolean; result: RtmpTestResult | null }>({ running: false, result: null })
  const [commandPreview, setCommandPreview] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  /**
   * The push address while it is being typed.
   *
   * The address is only written back to the model on leave (see the field's
   * `onBlur`): committing per keystroke would run protocol detection against
   * half-typed addresses, and the model would answer back into the box mid-edit.
   * `null` means "not editing" — the stored value is what shows.
   */
  const [serverDraft, setServerDraft] = useState<string | null>(null)
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

      {/* The tab strip and the panels below it are the only flexible part of the
          section, so the panel — and the scroll area inside it — fills whatever
          height the workspace gives the settings pane. */}
      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="tabs group-data-horizontal/tabs:h-10 w-full shrink-0 justify-start gap-0.5 rounded-none border-b border-border bg-transparent">
          {TABS.map((tabDef) => {
            const Icon = tabDef.icon
            const isActive = tab === tabDef.key
            return (
              <TabsTrigger
                key={tabDef.key}
                value={tabDef.key}
                className={cn('tab flex-none gap-1.5 px-3 text-sm data-active:bg-muted data-active:text-foreground', isActive && 'active')}
              >
                <Icon className="size-4" aria-hidden />
                {t(tabDef.labelKey)}
              </TabsTrigger>
            )
          })}
        </TabsList>

        {props.locked && (
          <div className="lock-note shrink-0">
            <Lock className="size-3.5" aria-hidden />
            <span>{t('settings.lockedNote')}</span>
          </div>
        )}

        {/* ------------------------------------------------------------ VIDEO */}
        <TabPane value="video" locked={props.locked}>
          <Field label={t('settings.video.codec')} hint={t('settings.video.codecHint')}>
            <NativeSelect
              wrapperClassName="w-full"
              value={v.codec}
              onChange={(e) => props.onUpdateVideo({ codec: e.target.value as VideoCodecName, encoder: 'auto' })}
            >
              {(Object.keys(CODEC_KEY) as VideoCodecName[]).map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {t(CODEC_KEY[c])}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          {v.codec !== 'copy' && (
            <>
              <Field label={t('settings.video.encoder')} hint={t('settings.video.encoderHint')}>
                <NativeSelect
                  wrapperClassName="w-full"
                  value={v.encoder}
                  onChange={(e) => props.onUpdateVideo({ encoder: e.target.value as VideoEncoderChoice })}
                >
                  {encoderOptions.map((e) => (
                    <NativeSelectOption key={e.value} value={e.value} disabled={!e.available && e.value !== 'auto'}>
                      {e.label}
                      {e.value !== 'auto' && !e.available ? t('settings.video.encoderUnavailable') : ''}
                      {e.verified ? t('settings.video.encoderVerified') : ''}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>

              {activeEncoder?.note && (
                <Alert className="border-warn/40 bg-warn/5">
                  <TriangleAlert aria-hidden />
                  <AlertDescription className="text-warn">{activeEncoder.note}</AlertDescription>
                </Alert>
              )}

              <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
                <Field label={t('settings.video.rateControl')}>
                  <NativeSelect
                    wrapperClassName="w-full"
                    value={v.rateControl}
                    onChange={(e) => props.onUpdateVideo({ rateControl: e.target.value as VideoRateControl })}
                  >
                    {(Object.keys(RATE_CONTROL_KEY) as VideoRateControl[])
                      .filter((r) => r !== 'auto')
                      .map((r) => (
                        <NativeSelectOption key={r} value={r}>
                          {t(RATE_CONTROL_KEY[r])}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                </Field>

                {v.rateControl === 'crf' ? (
                  <Field label={t('settings.video.crf')} hint={t('settings.video.crfHint')}>
                    <NumberInput min={0} max={51} value={v.crf} onCommit={(n) => props.onUpdateVideo({ crf: n })} />
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
              </FieldGroup>

              <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
                <Field label={t('settings.video.preset')} hint={t('settings.video.presetHint')}>
                  {presetOptions.length > 0 ? (
                    <NativeSelect
                      wrapperClassName="w-full"
                      value={v.preset}
                      onChange={(e) => props.onUpdateVideo({ preset: e.target.value })}
                    >
                      {presetOptions.map((p) => (
                        <NativeSelectOption key={p} value={p}>
                          {p}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Input value={v.preset} onChange={(e) => props.onUpdateVideo({ preset: e.target.value })} />
                  )}
                </Field>

                <Field label={t('settings.video.tune')}>
                  <NativeSelect
                    wrapperClassName="w-full"
                    value={v.tune}
                    onChange={(e) => props.onUpdateVideo({ tune: e.target.value })}
                  >
                    <NativeSelectOption value="">{t('settings.video.tuneUnset')}</NativeSelectOption>
                    <NativeSelectOption value="zerolatency">{t('settings.video.tune.zerolatency')}</NativeSelectOption>
                    <NativeSelectOption value="film">{t('settings.video.tune.film')}</NativeSelectOption>
                    <NativeSelectOption value="animation">{t('settings.video.tune.animation')}</NativeSelectOption>
                    <NativeSelectOption value="grain">{t('settings.video.tune.grain')}</NativeSelectOption>
                    <NativeSelectOption value="fastdecode">{t('settings.video.tune.fastdecode')}</NativeSelectOption>
                  </NativeSelect>
                </Field>

                <Field label={t('settings.video.profile')}>
                  <NativeSelect
                    wrapperClassName="w-full"
                    value={v.profile}
                    onChange={(e) => props.onUpdateVideo({ profile: e.target.value })}
                  >
                    <NativeSelectOption value="">{t('settings.video.tuneUnset')}</NativeSelectOption>
                    <NativeSelectOption value="baseline">{t('settings.video.profile.baseline')}</NativeSelectOption>
                    <NativeSelectOption value="main">main</NativeSelectOption>
                    <NativeSelectOption value="high">{t('settings.video.profile.high')}</NativeSelectOption>
                  </NativeSelect>
                </Field>
              </FieldGroup>
            </>
          )}

          <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
            <ResolutionField value={v} onChange={(patch) => props.onUpdateVideo(patch)} />

            <Field label={t('settings.video.fps')} hint={t('settings.video.fpsHint')}>
              <NumberInput min={0} max={240} value={v.fps} onCommit={(n) => props.onUpdateVideo({ fps: n })} />
            </Field>

            <Field label={t('settings.video.keyframe')} hint={t('settings.video.keyframeHint')}>
              <NumberInput
                min={0}
                max={10}
                step={0.5}
                value={v.keyframeIntervalSec}
                onCommit={(n) => props.onUpdateVideo({ keyframeIntervalSec: n })}
              />
            </Field>

            <Field label={t('settings.video.bFrames')} hint={t('settings.video.bFramesHint')}>
              <NumberInput min={0} max={4} value={v.bFrames} onCommit={(n) => props.onUpdateVideo({ bFrames: n })} />
            </Field>
          </FieldGroup>

          <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
            <Field label={t('settings.video.pixelFormat')} hint={t('settings.video.pixelFormatHint')}>
              <NativeSelect
                wrapperClassName="w-full"
                value={v.pixelFormat}
                onChange={(e) => props.onUpdateVideo({ pixelFormat: e.target.value })}
              >
                <NativeSelectOption value="yuv420p">yuv420p (8-bit 4:2:0)</NativeSelectOption>
                <NativeSelectOption value="yuv422p">yuv422p (8-bit 4:2:2)</NativeSelectOption>
                <NativeSelectOption value="yuv444p">yuv444p (8-bit 4:4:4)</NativeSelectOption>
                <NativeSelectOption value="nv12">nv12</NativeSelectOption>
                <NativeSelectOption value="p010le">p010le (10-bit)</NativeSelectOption>
              </NativeSelect>
            </Field>
          </FieldGroup>

          <Toggle
            label={t('settings.video.repeatHeaders')}
            hint={t('settings.video.repeatHeadersHint')}
            checked={v.repeatHeaders}
            onChange={(checked) => props.onUpdateVideo({ repeatHeaders: checked })}
          />
        </TabPane>

        {/* ------------------------------------------------------------ AUDIO */}
        <TabPane value="audio" locked={props.locked}>
          <Field label={t('settings.audio.codec')} hint={t('settings.audio.codecHint')}>
            <NativeSelect
              wrapperClassName="w-full"
              value={a.codec}
              onChange={(e) => props.onUpdateAudio({ codec: e.target.value as AudioCodecName })}
            >
              {(Object.keys(AUDIO_CODEC_KEY) as AudioCodecName[]).map((c) => {
                const supported = caps?.audioEncoders.find((x) => x.value === c)
                const disabled = c !== 'copy' && c !== 'none' && supported ? !supported.available : false
                return (
                  <NativeSelectOption key={c} value={c} disabled={disabled}>
                    {t(AUDIO_CODEC_KEY[c])}
                    {disabled ? t('settings.audio.codecUnsupported') : ''}
                  </NativeSelectOption>
                )
              })}
            </NativeSelect>
          </Field>

          {a.codec !== 'copy' && a.codec !== 'none' && (
            <>
              <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
                <Field label={t('settings.audio.bitrate')} hint={t('settings.audio.bitrateHint')}>
                  <NumberInput
                    min={16}
                    max={512}
                    step={8}
                    value={a.bitrateKbps}
                    onCommit={(n) => props.onUpdateAudio({ bitrateKbps: n })}
                  />
                </Field>
                <Field label={t('settings.audio.sampleRate')}>
                  <NativeSelect
                    wrapperClassName="w-full"
                    value={a.sampleRate}
                    onChange={(e) => props.onUpdateAudio({ sampleRate: Number(e.target.value) })}
                  >
                    <NativeSelectOption value={48000}>48000</NativeSelectOption>
                    <NativeSelectOption value={44100}>44100</NativeSelectOption>
                    <NativeSelectOption value={32000}>32000</NativeSelectOption>
                    <NativeSelectOption value={22050}>22050</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field label={t('settings.audio.channels')}>
                  <NativeSelect
                    wrapperClassName="w-full"
                    value={a.channels}
                    onChange={(e) => props.onUpdateAudio({ channels: Number(e.target.value) })}
                  >
                    <NativeSelectOption value={2}>{t('settings.audio.stereo')}</NativeSelectOption>
                    <NativeSelectOption value={1}>{t('settings.audio.mono')}</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field label={t('settings.audio.rateControl')}>
                  <NativeSelect
                    wrapperClassName="w-full"
                    value={a.rateControl}
                    onChange={(e) => props.onUpdateAudio({ rateControl: e.target.value as AudioRateControl })}
                  >
                    <NativeSelectOption value="cbr">{t('settings.audio.rc.cbr')}</NativeSelectOption>
                    <NativeSelectOption value="vbr">{t('settings.audio.rc.vbr')}</NativeSelectOption>
                  </NativeSelect>
                </Field>
              </FieldGroup>

              <Toggle
                label={t('settings.audio.loudnorm')}
                hint={t('settings.audio.loudnormHint')}
                checked={a.loudnorm}
                onChange={(checked) => props.onUpdateAudio({ loudnorm: checked })}
              />
            </>
          )}

          {a.codec === 'copy' && <p className="hint small">{t('settings.audio.copyHint')}</p>}
        </TabPane>

        {/* --------------------------------------------------------- SUBTITLE */}
        <TabPane value="subtitle" locked={props.locked}>
          <Field label={t('settings.subtitle.mode')} hint={t('settings.subtitle.modeHint')}>
            <NativeSelect
              wrapperClassName="w-full"
              value={s.mode}
              onChange={(e) => props.onUpdateSubtitles({ mode: e.target.value as SubtitleMode })}
            >
              <NativeSelectOption value="off">{t('settings.subtitle.modeOff')}</NativeSelectOption>
              <NativeSelectOption value="burn">{t('settings.subtitle.modeBurn')}</NativeSelectOption>
              <NativeSelectOption value="copy">{t('settings.subtitle.modeCopy')}</NativeSelectOption>
            </NativeSelect>
          </Field>

          {s.mode === 'burn' && (
            <>
              <Field label={t('settings.subtitle.styleSource')} hint={t('settings.subtitle.styleSourceHint')}>
                <NativeSelect
                  wrapperClassName="w-full"
                  value={s.styleMode}
                  onChange={(e) => props.onUpdateSubtitles({ styleMode: e.target.value as SubtitleRenderSettings['styleMode'] })}
                >
                  <NativeSelectOption value="preserve">{t('settings.subtitle.stylePreserve')}</NativeSelectOption>
                  <NativeSelectOption value="force">{t('settings.subtitle.styleForce')}</NativeSelectOption>
                  <NativeSelectOption value="plain">{t('settings.subtitle.stylePlain')}</NativeSelectOption>
                </NativeSelect>
              </Field>

              {s.styleMode !== 'preserve' && (
                <>
                  <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
                    <Field label={t('settings.subtitle.fontName')} hint={t('settings.subtitle.fontNameHint')}>
                      <Input
                        value={s.fontName}
                        onChange={(e) => props.onUpdateSubtitles({ fontName: e.target.value })}
                        list="font-presets"
                      />
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
                      <NumberInput
                        min={8}
                        max={120}
                        value={s.fontSize}
                        onCommit={(n) => props.onUpdateSubtitles({ fontSize: n })}
                      />
                    </Field>
                    <Field label={t('settings.subtitle.outlineWidth')}>
                      <NumberInput
                        min={0}
                        max={10}
                        step={0.5}
                        value={s.outlineWidth}
                        onCommit={(n) => props.onUpdateSubtitles({ outlineWidth: n })}
                      />
                    </Field>
                    <Field label={t('settings.subtitle.shadow')}>
                      <NumberInput min={0} max={10} value={s.shadow} onCommit={(n) => props.onUpdateSubtitles({ shadow: n })} />
                    </Field>
                  </FieldGroup>

                  <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
                    <Field label={t('settings.subtitle.primaryColor')}>
                      <div className="color-row">
                        <Input
                          type="color"
                          className="h-8 w-9 shrink-0 p-0.5"
                          value={s.primaryColor}
                          onChange={(e) => props.onUpdateSubtitles({ primaryColor: e.target.value })}
                        />
                        <Input
                          className="h-8 flex-1 font-mono text-xs"
                          value={s.primaryColor}
                          onChange={(e) => props.onUpdateSubtitles({ primaryColor: e.target.value })}
                        />
                      </div>
                    </Field>
                    <Field label={t('settings.subtitle.outlineColor')}>
                      <div className="color-row">
                        <Input
                          type="color"
                          className="h-8 w-9 shrink-0 p-0.5"
                          value={s.outlineColor}
                          onChange={(e) => props.onUpdateSubtitles({ outlineColor: e.target.value })}
                        />
                        <Input
                          className="h-8 flex-1 font-mono text-xs"
                          value={s.outlineColor}
                          onChange={(e) => props.onUpdateSubtitles({ outlineColor: e.target.value })}
                        />
                      </div>
                    </Field>
                    <Field label={t('settings.subtitle.marginVertical')}>
                      <NumberInput
                        min={0}
                        max={400}
                        value={s.marginVertical}
                        onCommit={(n) => props.onUpdateSubtitles({ marginVertical: n })}
                      />
                    </Field>
                    <Field label={t('settings.subtitle.alignment')}>
                      <NativeSelect
                        wrapperClassName="w-full"
                        value={s.alignment}
                        onChange={(e) => props.onUpdateSubtitles({ alignment: Number(e.target.value) })}
                      >
                        {(Object.keys(ALIGNMENT_KEY).map(Number) as number[]).map((value) => (
                          <NativeSelectOption key={value} value={value}>
                            {t(ALIGNMENT_KEY[value])}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                  </FieldGroup>

                  <div className="toggle-row flex flex-wrap items-center gap-6">
                    <Toggle label={t('settings.subtitle.bold')} checked={s.bold} onChange={(c) => props.onUpdateSubtitles({ bold: c })} compact />
                    <Toggle
                      label={t('settings.subtitle.italic')}
                      checked={s.italic}
                      onChange={(c) => props.onUpdateSubtitles({ italic: c })}
                      compact
                    />
                  </div>
                </>
              )}
            </>
          )}

          {s.mode === 'copy' && (
            <Alert className="border-warn/40 bg-warn/5">
              <TriangleAlert aria-hidden />
              <AlertDescription className="text-warn">{t('settings.subtitle.copyHint')}</AlertDescription>
            </Alert>
          )}
        </TabPane>

        {/* ----------------------------------------------------------- OUTPUT */}
        <TabPane value="output" locked={props.locked}>
          <Field label={t('settings.output.server')}>
            <div className="addr-row">
              <Input
                value={serverDraft ?? o.server}
                placeholder="rtmp://127.0.0.1/live/"
                onChange={(e) => setServerDraft(e.target.value)}
                onBlur={(e) => {
                  /*
                   * Protocol detection runs on LEAVE, not per keystroke: while
                   * typing, half-finished addresses would flap the dropdown
                   * (r-t-m-p already looks like RTMP). Leaving the field means
                   * the address is finished, so the dropdown jumps to the
                   * detected protocol — the user can still override it after.
                   *
                   * An emptied address is left empty: it is a state the user can
                   * ask for (nothing is pushed until one is typed), so it neither
                   * falls back to the default nor flips the protocol.
                   */
                  const trimmed = e.target.value.trim()
                  setServerDraft(null)
                  const patch: Partial<OutputSettings> = {}
                  if (trimmed !== o.server) patch.server = trimmed
                  if (trimmed !== '') {
                    const detected = detectStreamProtocol(trimmed)
                    if (detected !== o.protocol) {
                      patch.protocol = detected
                      patch.network = networkForProtocol(detected, o.network)
                    }
                  }
                  if (Object.keys(patch).length > 0) props.onUpdateOutput(patch)
                }}
                spellCheck={false}
              />
              <NativeSelect
                wrapperClassName="w-[148px] flex-none"
                value={o.protocol}
                aria-label={t('settings.output.protocol')}
                onChange={(e) => {
                  const protocol = e.target.value as StreamProtocol
                  // The transport travels with the protocol: switching to one that
                  // cannot run over the current network clamps the choice.
                  props.onUpdateOutput({ protocol, network: networkForProtocol(protocol, o.network) })
                }}
              >
                {STREAM_PROTOCOLS.map((p) => (
                  <NativeSelectOption key={p} value={p}>
                    {t(PROTOCOL_KEY[p])}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {/* Empty is a state the user can ask for, but it blocks the start
                button and nothing else on screen says why, so it is named once,
                below the control. */}
            {o.server.trim() === '' && (
              <FieldDescription className="field-hint text-xs">{t('settings.output.serverEmpty')}</FieldDescription>
            )}
          </Field>

          <Field label={t('settings.output.streamKey')} hint={t(STREAM_KEY_HINT[o.protocol])}>
            <div className="secret-row">
              <Input
                type={showKey ? 'text' : 'password'}
                className="h-7 font-mono text-xs"
                value={o.streamKey}
                placeholder={t('settings.output.nonePlaceholder')}
                onChange={(e) => props.onUpdateOutput({ streamKey: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <Button type="button" size="sm" variant="outline" className="secret-toggle" onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff data-icon="inline-start" aria-hidden /> : <Eye data-icon="inline-start" aria-hidden />}
                {showKey ? t('settings.output.hide') : t('settings.output.show')}
              </Button>
            </div>
          </Field>

          {(() => {
            const choices = PROTOCOL_NETWORKS[o.protocol] ?? PROTOCOL_NETWORKS.rtmp
            const locked = choices.length < 2
            return (
              <Field
                label={t('settings.output.network')}
                hint={locked ? t('settings.output.networkHintFixed', { net: o.network.toUpperCase() }) : t('settings.output.networkHint')}
              >
                <NativeSelect
                  wrapperClassName="w-full"
                  value={o.network}
                  disabled={locked}
                  onChange={(e) => props.onUpdateOutput({ network: e.target.value as StreamNetwork })}
                >
                  <NativeSelectOption value="tcp">TCP</NativeSelectOption>
                  <NativeSelectOption value="udp">UDP</NativeSelectOption>
                </NativeSelect>
              </Field>
            )
          })()}

          <Field label={t('settings.output.extraArgs')} hint={t('settings.output.extraArgsHint')}>
            <Input
              className="font-mono text-xs"
              value={o.extraOutputArgs}
              placeholder=""
              onChange={(e) => props.onUpdateOutput({ extraOutputArgs: e.target.value })}
              spellCheck={false}
            />
          </Field>

          <div className="row-actions flex flex-wrap items-center gap-2">
            <Button onClick={runTest} disabled={testState.running || props.busy}>
              {testState.running ? <Spinner data-icon="inline-start" /> : <PlugZap data-icon="inline-start" aria-hidden />}
              {testState.running ? t('settings.output.testing') : t('settings.output.testConnection')}
            </Button>
            <Button variant="outline" onClick={showCommand}>
              <Terminal data-icon="inline-start" aria-hidden />
              {t('settings.output.viewCommand')}
            </Button>
          </div>

          {testState.result && (
            <Alert
              variant={testState.result.ok ? 'default' : 'destructive'}
              className={cn('test-result', testState.result.ok ? 'ok border-ok/40 text-ok' : 'fail')}
            >
              {testState.result.ok ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
              {/* No title row: the verdict is the first thing in the message the
                  engine reports, and repeating it above reads as two results. The
                  frame colour and this icon carry the verdict. */}
              <AlertDescription>
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
              </AlertDescription>
            </Alert>
          )}

          {commandPreview && (
            <Card className="command-preview gap-0 p-0">
              <CardHeader className="cp-head flex items-center justify-between gap-2 px-3 py-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">{t('settings.output.commandPreviewTitle')}</CardTitle>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(commandPreview)
                    }}
                  >
                    <Copy data-icon="inline-start" aria-hidden />
                    {t('settings.output.copy')}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setCommandPreview(null)}>
                    <X data-icon="inline-start" aria-hidden />
                    {t('app.close')}
                  </Button>
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="px-3 pb-3">
                <pre>{commandPreview}</pre>
              </CardContent>
            </Card>
          )}

          <h3 className="section-title">
            <Gauge className="size-3.5" aria-hidden />
            <span>{t('settings.advanced.streamControl')}</span>
          </h3>
          {/*
            The switch and its delay share a row, switch first: the delay only means
            anything while buffering is on, and reading them side by side is what
            makes that dependency visible. The delay stays in the DOM while disabled
            rather than disappearing, so the row does not reflow when it is toggled.
          */}
          <FieldGroup className="field-grid stream-mode-grid grid gap-x-3 gap-y-2.5">
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
          </FieldGroup>
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

          <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
            <Field label={t('settings.advanced.reconnectDelay')}>
              <NumberInput
                min={1}
                max={60}
                value={o.reconnectDelaySec}
                onCommit={(n) => props.onUpdateOutput({ reconnectDelaySec: n })}
              />
            </Field>
            <Field label={t('settings.advanced.maxReconnect')} hint={t('settings.advanced.maxReconnectHint')}>
              <NumberInput
                min={0}
                max={100}
                value={o.maxReconnectAttempts}
                onCommit={(n) => props.onUpdateOutput({ maxReconnectAttempts: n })}
              />
            </Field>
          </FieldGroup>

          {/* ------------------------------------- OBS WebSocket ---------- */}
          <h3 className="section-title">
            <Webhook className="size-3.5" aria-hidden />
            <span>{t('settings.obs.title')}</span>
          </h3>
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
              <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
                <Field label={t('settings.obs.host')}>
                  <DraftInput
                    className="font-mono text-xs"
                    value={o.obsWebSocket.host}
                    placeholder="127.0.0.1"
                    spellCheck={false}
                    onCommit={(host) => {
                      updateObs({ host: host.trim() })
                      applyObs()
                    }}
                  />
                </Field>
                <Field label={t('settings.obs.port')}>
                  <NumberInput
                    min={OBS_PORT_MIN}
                    max={OBS_PORT_MAX}
                    value={o.obsWebSocket.port}
                    onCommit={(n) => {
                      updateObs({ port: clampNumber(n, OBS_PORT_MIN, OBS_PORT_MAX, 4455) })
                      applyObs()
                    }}
                  />
                </Field>
                <Field label={t('settings.obs.password')} hint={t('settings.obs.passwordHint')}>
                  <div className="secret-row">
                    <DraftInput
                      type={showKey ? 'text' : 'password'}
                      className="h-7 font-mono text-xs"
                      value={o.obsWebSocket.password}
                      placeholder={t('settings.output.nonePlaceholder')}
                      spellCheck={false}
                      autoComplete="off"
                      onCommit={(password) => {
                        updateObs({ password })
                        applyObs()
                      }}
                    />
                    <Button type="button" size="sm" variant="outline" className="secret-toggle" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? <EyeOff data-icon="inline-start" aria-hidden /> : <Eye data-icon="inline-start" aria-hidden />}
                      {showKey ? t('settings.output.hide') : t('settings.output.show')}
                    </Button>
                  </div>
                </Field>
              </FieldGroup>

              <div className="row-actions flex flex-wrap items-center gap-2">
                <Button onClick={() => void applyObsNow()} disabled={obsRestarting}>
                  {obsRestarting ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden />}
                  {obsRestarting ? t('settings.obs.applying') : t('settings.obs.apply')}
                </Button>
                {/* `h-8` matches the button beside it: the chip reports what that
                    button just did, and a shorter chip next to it reads as a
                    different kind of thing. */}
                <span className={cn('pill h-8', props.obsStatus?.running ? 'ok' : 'subtle')}>
                  <span
                    className={cn(
                      'state-dot',
                      props.obsStatus?.running ? 'state-live' : props.obsStatus?.error ? 'state-error' : undefined
                    )}
                    aria-hidden
                  />
                  {props.obsStatus?.running
                    ? t('settings.obs.running', { url: props.obsStatus.url })
                    : props.obsStatus?.error
                      ? t('settings.obs.error', { error: props.obsStatus.error })
                      : t('settings.obs.notRunning')}
                </span>
                {props.obsStatus?.running && props.obsStatus.clients > 0 && (
                  <Badge variant="secondary" className="badge">
                    {t('settings.obs.clients', { n: props.obsStatus.clients })}
                  </Badge>
                )}
              </div>

              <p className="hint small">
                {t('settings.obs.compatHint1')}
                {t('settings.obs.compatHint2')}
              </p>
            </>
          )}
        </TabPane>

        {/* --------------------------------------------------------- ADVANCED */}
        <TabPane value="advanced" locked={props.locked}>
          {/*
            Application-level settings come first: the interface language and the
            appearance are decisions about the app itself, and neither of them is part
            of a preset.
          */}
          <h3 className="section-title">
            <Settings2 className="size-3.5" aria-hidden />
            <span>{t('settings.ui.title')}</span>
          </h3>
          <FieldGroup className="field-grid grid gap-x-3 gap-y-2.5">
            <Field label={t('app.language')}>
              <NativeSelect
                wrapperClassName="w-full"
                value={props.settings.language}
                onChange={(e) => props.onChangeLanguage(e.target.value as Language)}
              >
                {LANGUAGES.map((code) => (
                  <NativeSelectOption key={code} value={code}>
                    {LANGUAGE_NATIVE_NAME[code]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('settings.ui.theme')}>
              <NativeSelect
                wrapperClassName="w-full"
                value={props.settings.theme}
                onChange={(e) => void props.onSaveSettings({ theme: e.target.value as ThemePreference })}
              >
                {(Object.keys(THEME_KEY) as ThemePreference[]).map((preference) => (
                  <NativeSelectOption key={preference} value={preference}>
                    {t(THEME_KEY[preference])}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </FieldGroup>

          <h3 className="section-title">
            <ScrollText className="size-3.5" aria-hidden />
            <span>{t('settings.advanced.logRetention')}</span>
          </h3>
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
          <div className="row-actions flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={props.onOpenLogsDir}>
              <FolderOpen data-icon="inline-start" aria-hidden />
              {t('settings.advanced.openLogsDir')}
            </Button>
          </div>

          <h3 className="section-title">
            <SlidersHorizontal className="size-3.5" aria-hidden />
            <span>{t('settings.advanced.ffmpegSection')}</span>
          </h3>
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

          <div className="row-actions flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={props.onChooseFfmpeg}>
              <FolderOpen data-icon="inline-start" aria-hidden />
              {t('settings.advanced.chooseFfmpeg')}
            </Button>
            <Button variant="ghost" onClick={() => props.onRefreshCapabilities(true)} disabled={props.capsLoading}>
              {props.capsLoading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden />}
              {props.capsLoading ? t('settings.advanced.detecting') : t('settings.advanced.redetect')}
            </Button>
          </div>

          {caps && caps.warnings.length > 0 && (
            <div className="warnings flex flex-col gap-2">
              {caps.warnings.map((w, i) => (
                <Alert key={i} className="border-warn/40 bg-warn/5">
                  <TriangleAlert aria-hidden />
                  <AlertDescription className="text-xs text-warn">{w}</AlertDescription>
                </Alert>
              ))}
            </div>
          )}

          <h3 className="section-title">
            <Cpu className="size-3.5" aria-hidden />
            <span>{t('settings.advanced.availableEncoders')}</span>
          </h3>
          <Card className="gap-0 py-0">
            <CardContent className="encoder-table py-3">
              {caps?.encoders.map((e) => (
                <div key={e.value} className={cn('enc-row', !e.available && 'off')}>
                  <span className={cn('dot', e.available ? (e.kind === 'software' ? 'sw' : 'hw') : 'na')} aria-hidden />
                  <span className="enc-name">{e.label}</span>
                  <span className="enc-kind">{e.kind === 'software' ? t('settings.advanced.software') : e.kind.toUpperCase()}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <h3 className="section-title">
            <Info className="size-3.5" aria-hidden />
            <span>{t('settings.about.title')}</span>
          </h3>
          <div className="kv-list">
            <div className="kv">
              <span>{t('settings.about.version')}</span>
              <code>{formatAppVersion(props.info)}</code>
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
        </TabPane>
      </Tabs>
    </section>
  )
}

/**
 * One tab panel.
 *
 * The panel is mounted only while its tab is selected (Base UI unmounts the
 * others), and `.settings-body` inside it is the scroll container of that tab:
 * `flex-1 min-h-0` is what lets it shrink and scroll instead of growing the
 * fixed-height page, which the layout suite measures.
 *
 * The lock goes on `.settings-fields`, not on `.settings-body`: an inert element
 * cannot be scrolled by the wheel, and reading the settings while a session runs is
 * exactly when the operator wants to scroll them. Everything inside the wrapper is
 * still frozen — no control, no focus, no text selection.
 */
function TabPane({ value, locked, children }: { value: TabKey; locked: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <TabsContent value={value} className="flex min-h-0 flex-1 flex-col">
      <div className="settings-body flex-1 min-h-0">
        <div className="settings-fields" inert={locked}>
          {children}
        </div>
      </div>
    </TabsContent>
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
      <NativeSelectOptGroup label={t('settings.preset.builtinGroup')}>
        {all
          .filter((p) => p.builtin)
          .map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.name}
            </NativeSelectOption>
          ))}
      </NativeSelectOptGroup>
      {userPresets.length > 0 && (
        <NativeSelectOptGroup label={t('settings.preset.userGroup')}>
          {userPresets.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.name}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      )}
    </>
  )

  return (
    <div className="preset-bar">
      <span className="preset-label">
        <Bookmark className="size-3.5" aria-hidden />
        {t('settings.preset.label')}
      </span>

      <NativeSelect
        className="preset-select"
        wrapperClassName="min-w-[180px] max-w-[460px] flex-1"
        size="sm"
        value={active?.id ?? ''}
        disabled={locked}
        onChange={(e) => {
          const preset = all.find((p) => p.id === e.target.value)
          if (preset) onSelectPreset(preset)
        }}
        title={t('settings.preset.selectTitle')}
      >
        <NativeSelectOption value="">{t('settings.preset.custom')}</NativeSelectOption>
        {presetOptions}
      </NativeSelect>

      {active?.builtin && (
        <Badge variant="secondary" className="badge">
          {t('settings.preset.builtinBadge')}
        </Badge>
      )}

      <Button size="xs" variant="outline" onClick={() => toggleMenu('save')} disabled={locked} title={t('settings.preset.saveTitle')}>
        <Save data-icon="inline-start" aria-hidden />
        {t('settings.preset.saveAs')}
      </Button>

      {active && !active.builtin && (
        <>
          <Button
            size="xs"
            variant="outline"
            onClick={() => toggleMenu('rename')}
            disabled={locked}
            title={t('settings.preset.renameTitle', { name: active.name })}
          >
            <PenLine data-icon="inline-start" aria-hidden />
            {t('settings.preset.rename')}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            onClick={() => {
              closeMenu()
              onDeletePreset(active.id)
            }}
            disabled={locked}
            title={t('settings.preset.deleteTitle', { name: active.name })}
          >
            <Trash2 data-icon="inline-start" aria-hidden />
            {t('settings.preset.delete')}
          </Button>
        </>
      )}

      <Button size="xs" variant="ghost" onClick={onOpenDataDir} title={presets?.location.dir ?? t('settings.preset.dataDirTitle')}>
        <FolderOpen data-icon="inline-start" aria-hidden />
        {t('settings.preset.dataDir')}
      </Button>

      {menu !== 'none' && (
        <div className="preset-menu" data-mode={menu}>
          <div className="preset-menu-title">
            {menu === 'save' ? t('settings.preset.menuTitle') : t('settings.preset.renameMenuTitle')}
          </div>
          <div className="preset-menu-row">
            <Input
              autoFocus
              className="h-8 min-w-0 flex-1"
              value={name}
              placeholder={t('settings.preset.namePlaceholder')}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (menu === 'save' ? save : rename)()
                if (e.key === 'Escape') closeMenu()
              }}
            />
            <Button size="sm" onClick={menu === 'save' ? save : rename} disabled={!name.trim()}>
              {menu === 'save' ? t('settings.preset.saveButton') : t('settings.preset.renameButton')}
            </Button>
            <Button size="sm" variant="ghost" onClick={closeMenu}>
              {t('settings.preset.cancel')}
            </Button>
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
 * `Field`/`FieldLabel`/`FieldDescription` from the registry supply the semantics;
 * the `field` / `field-label` / `field-hint` classes are the layout hooks
 * `styles.css` and the e2e alignment audit read, so every control in a grid row
 * lines up on the control rather than on its label.
 *
 * The hint is rendered *below* the control, not inside the label row: labels stay
 * single-line, so every control in a `field-grid` row starts at the same offset no
 * matter how long its explanation is.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <FieldShell className="field gap-1.5">
      <FieldLabel className="field-label text-xs">{label}</FieldLabel>
      {children}
      {hint && <FieldDescription className="field-hint text-xs">{hint}</FieldDescription>}
    </FieldShell>
  )
}

/**
 * The version line in the About panel.
 *
 * The version always shows; the prefix tells release from nightly (the built
 * commit carries no tag): `v1.0.1 (dda0f8d24d)` vs `nightly v1.0.1 (dda0f8d24d)`.
 * Without build info (a dev run without a prior build) the plain package.json
 * version shows.
 */
function formatAppVersion(info: AppInfo | null): string {
  if (!info) return '—'
  if (!info.commit) return info.version
  return info.nightly ? `nightly v${info.version} (${info.commit})` : `v${info.version} (${info.commit})`
}

/**
 * Text input that commits on blur (or Enter) instead of per keystroke.
 *
 * For fields whose committed value has side effects — editing the control
 * endpoint's host or password restarts the listener — every keystroke must not
 * fire them. The draft follows the external value while not being edited, so a
 * settings change from elsewhere still shows up. (Numbers use `NumberInput`,
 * which is the same idea plus parsing and a clamp.)
 */
function DraftInput({
  value,
  onCommit,
  ...rest
}: {
  value: string
  onCommit: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'>): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const commit = (): void => {
    setEditing(false)
    if (draft !== value) onCommit(draft)
  }

  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => {
        setEditing(true)
        setDraft(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        // Escape abandons the edit rather than committing a half-typed value.
        if (e.key === 'Escape') {
          setEditing(false)
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/* ------------------------------------------------------------------ *
 * Stream delay (buffered playout)
 * ------------------------------------------------------------------ */

/**
 * Numeric field that lets the value be typed freely and clamps it when committed.
 *
 * Clamping on every keystroke fights the user: the intermediate states of a number
 * are not valid numbers (clearing the box reads as 0, and "1" on the way to "12"
 * trips a floor that is only meant for the committed value), so a floor applied per
 * keystroke makes the field awkward for anything but a single digit. `NumberInput`
 * holds the draft; what reaches this component is the finished number, and that is
 * what gets clamped and stored — the box then shows the stored value, so what is on
 * screen is always what the engine will use.
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
  return (
    <Field label={label} hint={hint}>
      <NumberInput
        min={min}
        max={max}
        step={0.1}
        disabled={disabled}
        value={value}
        onCommit={(n) => {
          // Only the committed value is clamped, never the keystrokes that lead to
          // it. An emptied box commits nothing at all, so the delay in force stays
          // rather than dropping to the floor — clearing the field is not a request
          // for a tenth of a second.
          const next = clampNumber(n, min, max, value)
          if (next !== value) onCommit(next)
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

  // The displayed number is derived from the unit, so switching units re-expresses
  // the same rate; what is being typed is the field's own business (NumberInput).
  const display = unit === 'kbps' ? Math.round(valueKbps) : trimZeros(valueKbps / 1000)

  /**
   * Converts a committed field value to kbps and refuses the ones the encoder
   * cannot take. Refusing means "keep the value in force": the field then snaps
   * back to it, so what is on screen is always what the engine will use.
   */
  const commit = (parsed: number): void => {
    if (!Number.isFinite(parsed)) return
    const kbps = unit === 'kbps' ? Math.round(parsed) : Math.round(parsed * 1000)
    if (kbps < minKbps) return
    if (!allowZero && kbps <= 0) return
    onChange(kbps)
  }

  return (
    <Field label={label} hint={hint}>
      {/* Typing 6000 and picking kbps is one decision, so it is one control. */}
      <div className="unit-input">
        <NumberInput
          className="h-7 text-xs"
          min={unit === 'kbps' ? minKbps : trimZeros(minKbps / 1000)}
          step={unit === 'kbps' ? 100 : 0.1}
          value={display}
          onCommit={commit}
        />
        <NativeSelect
          size="sm"
          className="text-xs"
          wrapperClassName="w-[82px] flex-none"
          value={unit}
          onChange={(e) => setUnit(e.target.value as BitrateUnit)}
          aria-label={t('settings.video.bitrateUnitAria', { label })}
        >
          <NativeSelectOption value="kbps">kbps</NativeSelectOption>
          <NativeSelectOption value="mbps">Mbps</NativeSelectOption>
        </NativeSelect>
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
    <FieldShell className="field res-field gap-2">
      {/*
        No "Resolution" heading of its own: the enable switch is the heading. The
        preset picker sits on the same line because it is the same decision (what
        size), and the two number boxes below only matter once it is on.
      */}
      <div className="res-inputs">
        <label className="toggle compact res-enable field-label">
          <input type="checkbox" className="size-3.5 accent-primary" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="toggle-text">{t('settings.video.scaleOutput')}</span>
        </label>

        <NativeSelect
          size="sm"
          className="text-xs"
          wrapperClassName="w-[152px] flex-none"
          value={activePreset?.label ?? ''}
          disabled={!enabled}
          onChange={(e) => applyPreset(e.target.value)}
          aria-label={t('settings.video.resolutionPresetAria')}
        >
          <NativeSelectOption value="">{t('settings.video.resolutionCustom')}</NativeSelectOption>
          {SCALE_PRESETS.map((p) => (
            <NativeSelectOption key={p.label} value={p.label}>
              {p.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      <div className="res-inputs">
        <div className="res-pair">
          <NumberInput
            className="h-8 w-[84px] font-mono text-xs"
            min={2}
            step={2}
            value={value.scaleWidth || ''}
            disabled={!enabled}
            onCommit={(n) => setWidth(n)}
            aria-label={t('settings.video.widthAria')}
            placeholder={t('settings.video.widthPlaceholder')}
          />
          <span className="res-x">×</span>
          <NumberInput
            className="h-8 w-[84px] font-mono text-xs"
            min={2}
            step={2}
            value={value.scaleAuto ? '' : value.scaleHeight || ''}
            disabled={!enabled || value.scaleAuto}
            onCommit={(n) => setHeight(n)}
            aria-label={t('settings.video.heightAria')}
            placeholder={value.scaleAuto ? t('settings.video.rc.auto') : t('settings.video.heightPlaceholder')}
            title={value.scaleAuto ? t('settings.video.heightAutoTitle') : ''}
          />
        </div>

        <Tooltip>
          <TooltipTrigger render={<label className={cn('auto-check', !enabled && 'disabled')} />}>
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={value.scaleAuto}
              disabled={!enabled}
              onChange={(e) => setAuto(e.target.checked)}
            />
            {t('settings.video.scaleAutoLabel')}
          </TooltipTrigger>
          <TooltipContent>{t('settings.video.scaleAutoTitle')}</TooltipContent>
        </Tooltip>
      </div>
      <FieldDescription className="field-hint text-xs">{t('settings.video.scaleHint')}</FieldDescription>
    </FieldShell>
  )
}

/**
 * A boolean setting row: label and hint on the left, the switch on the right.
 *
 * The wrapper stays a `<label>` and keeps the `toggle` / `toggle-text` classes the
 * e2e suite looks rows up by; the control itself is the registry `Switch` (a
 * `role="switch"` element, not a checkbox input), which Base UI backs with a
 * visually hidden checkbox so clicking the label text still flips it.
 */
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
    <label className={cn('toggle', compact && 'compact')}>
      <span className="toggle-text">
        {label}
        {hint && <em className="field-hint">{hint}</em>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}
