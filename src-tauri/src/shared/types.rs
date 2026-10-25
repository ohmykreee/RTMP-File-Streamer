//! Shared type contracts between the Rust backend (FFmpeg engine) and the
//! renderer UI. Port of `src/shared/types.ts`.
//!
//! The serde representations must stay byte-compatible with what the renderer's
//! TypeScript definitions describe and what a settings file written by an older
//! (Electron) build contains: field names are camelCase, and a field that is
//! `optional` in TS is `Option<T>` that is skipped when absent.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type Language = String; // 'zh' | 'ja' | 'en', narrowed by shared::i18n::is_language

/* ------------------------------------------------------------------ *
 * Media probing
 * ------------------------------------------------------------------ */

pub type VideoCodecName = String; // 'h264' | 'hevc' | 'av1' | 'copy'
pub type AudioCodecName = String; // 'aac' | 'libmp3lame' | 'libopus' | 'copy' | 'none'
pub type ContainerName = String; // 'flv' | 'mpegts' | 'mkv'
pub type StreamProtocol = String; // 'rtmp' | 'srt' | 'rtsp' | 'whip'
pub type StreamNetwork = String; // 'tcp' | 'udp'
pub type SubtitleCodecFamily = String; // 'text' | 'bitmap' | 'unknown'
pub type SubtitleSource = String; // 'embedded' | 'external'
pub type SubtitleMode = String; // 'off' | 'burn' | 'copy'
pub type VideoRateControl = String; // 'cbr' | 'vbr' | 'crf' | 'abr' | 'auto'
pub type AudioRateControl = String; // 'cbr' | 'vbr'
pub type VideoEncoderChoice = String; // 'auto' | catalogue slugs
pub type EngineState = String; // 'idle' | 'preparing' | ... — stringly to match the wire format
pub type LogLevel = String; // 'debug' | 'info' | 'warn' | 'error' | 'ffmpeg'
pub type NetworkState = String; // 'ok' | 'warn' | 'bad'
pub type PlaylistItemStatus = String; // 'pending' | 'preparing' | 'live' | 'done' | 'skipped' | 'error'
pub type ThemePreference = String; // 'light' | 'dark' | 'system'

pub const THEME_PREFERENCES: [&str; 3] = ["light", "dark", "system"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaStreamInfo {
    pub index: i64,
    #[serde(rename = "type")]
    pub stream_type: String,
    pub codec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_long: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle_family: Option<SubtitleCodecFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_layout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_forced: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_pic: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub size: u64,
    pub duration_sec: f64,
    pub format_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_long_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<f64>,
    pub streams: Vec<MediaStreamInfo>,
    pub video_streams: Vec<MediaStreamInfo>,
    pub audio_streams: Vec<MediaStreamInfo>,
    pub subtitle_streams: Vec<MediaStreamInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrackRef {
    pub id: String,
    pub source: SubtitleSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_index: Option<i64>,
    pub codec: String,
    pub family: SubtitleCodecFamily,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_forced: Option<bool>,
}

/* ------------------------------------------------------------------ *
 * Playlist
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItem {
    pub id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub duration_sec: f64,
    pub subtitle_tracks: Vec<SubtitleTrackRef>,
    pub selected_subtitle_id: Option<String>,
    pub mode: SubtitleMode,
    pub sync_offset_sec: f64,
    pub subtitle_delay_sec: f64,
    pub status: PlaylistItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken: Option<bool>,
}

/* ------------------------------------------------------------------ *
 * Encoding settings
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub codec: VideoCodecName,
    pub encoder: VideoEncoderChoice,
    pub rate_control: VideoRateControl,
    pub bitrate_kbps: f64,
    pub max_bitrate_kbps: f64,
    pub buffer_size_kbps: f64,
    pub crf: f64,
    pub preset: String,
    pub tune: String,
    pub profile: String,
    pub keyframe_interval_sec: f64,
    pub b_frames: f64,
    pub scale: String,
    pub scale_width: f64,
    pub scale_height: f64,
    pub scale_auto: bool,
    pub fps: f64,
    pub pixel_format: String,
    pub repeat_headers: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub codec: AudioCodecName,
    pub rate_control: AudioRateControl,
    pub bitrate_kbps: f64,
    pub sample_rate: f64,
    pub channels: f64,
    pub loudnorm: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleRenderSettings {
    pub mode: SubtitleMode,
    pub style_mode: String, // 'preserve' | 'force' | 'plain'
    pub font_name: String,
    pub font_size: f64,
    pub primary_color: String,
    pub outline_color: String,
    pub outline_width: f64,
    pub shadow: f64,
    pub margin_vertical: f64,
    pub alignment: f64,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsWebSocketSettings {
    pub enabled: bool,
    pub host: String,
    pub port: f64,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsWebSocketStatus {
    pub running: bool,
    pub host: String,
    pub port: f64,
    pub url: String,
    pub clients: u32,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub server: String,
    pub stream_key: String,
    pub protocol: StreamProtocol,
    pub network: StreamNetwork,
    pub container: ContainerName,
    pub extra_output_args: String,
    pub realtime_pacing: bool,
    pub obs_web_socket: ObsWebSocketSettings,
    pub buffered: bool,
    pub buffer_sec: f64,
    pub loop_playlist: bool,
    pub reconnect_delay_sec: f64,
    pub max_reconnect_attempts: f64,
    pub drop_late_frames: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub video: VideoSettings,
    pub audio: AudioSettings,
    pub subtitles: SubtitleRenderSettings,
    pub output: OutputSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub settings: SessionSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetLocation {
    pub dir: String,
    pub file: String,
    pub app_root: String,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetsPayload {
    pub location: PresetLocation,
    pub presets: Vec<Preset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub debug_logging: bool,
    pub language: Language,
    pub language_set: bool,
    pub theme: ThemePreference,
    pub playlist_width_percent: f64,
    pub session: SessionSettings,
}

/* ------------------------------------------------------------------ *
 * Encoder capabilities
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderOption {
    pub value: VideoEncoderChoice,
    pub label: String,
    pub codec: VideoCodecName,
    pub kind: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub presets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEncoderOption {
    pub value: AudioCodecName,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerFormatOption {
    pub value: ContainerName,
    pub label: String,
    pub muxer: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegCapabilities {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub ffmpeg_version: String,
    pub build_configuration: String,
    pub source: String, // 'settings' | 'bundled' | 'path' | 'common-location' | 'missing'
    pub encoders: Vec<EncoderOption>,
    pub audio_encoders: Vec<AudioEncoderOption>,
    pub container_formats: Vec<ContainerFormatOption>,
    pub has_subtitle_filter: bool,
    pub has_overlay_filter: bool,
    pub warnings: Vec<String>,
}

/* ------------------------------------------------------------------ *
 * Engine status & events
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u64,
    pub ts: f64,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderLiveStats {
    pub speed: f64,
    pub fps: f64,
    pub bitrate_kbps: f64,
    pub lead_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    pub current_index: i64,
    pub position_sec: f64,
    pub current_duration_sec: f64,
    pub completed_sec: f64,
    pub total_duration_sec: f64,
    pub speed: f64,
    pub fps: f64,
    pub bitrate_kbps: f64,
    pub network_kbps: f64,
    pub network_state: NetworkState,
    pub dropped_frames: f64,
    pub frame: f64,
    pub order: Vec<String>,
    pub item_status: HashMap<String, PlaylistItemStatus>,
    pub item_error: HashMap<String, String>,
    pub reconnect_count: u32,
    pub connected: bool,
    pub started_at: Option<f64>,
    pub elapsed_sec: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder: Option<EncoderLiveStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded_sec: Option<f64>,
}

/* ------------------------------------------------------------------ *
 * IPC payloads
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub info: MediaInfo,
    pub subtitles: Vec<SubtitleTrackRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtmpTestRequest {
    pub url: String,
    pub stream_key: String,
    pub timeout_sec: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtmpTestResult {
    pub ok: bool,
    pub message: String,
    pub detail: String,
    pub elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nightly: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    pub electron: String,
    pub chrome: String,
    pub node: String,
    pub platform: String,
    pub arch: String,
    pub user_data_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedLogInfo {
    pub dir: String,
    pub current_file: String,
    pub total_bytes: u64,
    pub file_count: u32,
    pub budget_bytes: u64,
}

/* ------------------------------------------------------------------ *
 * Channel names (identical strings to the Electron IPC map)
 * ------------------------------------------------------------------ */

pub mod ipc_channels {
    pub const EVT_STATUS: &str = "evt:status";
    pub const EVT_LOG: &str = "evt:log";
    pub const EVT_PLAYLIST: &str = "evt:playlist";
    pub const EVT_SETTINGS: &str = "evt:settings";
}

pub const SUPPORTED_VIDEO_EXT: [&str; 15] = [
    ".mp4", ".mkv", ".mov", ".avi", ".flv", ".ts", ".m2ts", ".webm", ".wmv", ".mpg", ".mpeg",
    ".m4v", ".vob", ".ogv", ".mxf",
];
pub const SUPPORTED_SUBTITLE_EXT: [&str; 7] = [".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx", ".sup"];

/// `path.extname` equivalent: the portion of the last `.` of the file name,
/// including the dot; empty when there is none (or the name is only a dot).
pub fn ext_name(p: &str) -> String {
    let name = std::path::Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    match name.rfind('.') {
        Some(idx) if idx > 0 => name[idx..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// `path.basename` equivalent.
pub fn base_name(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string())
}
