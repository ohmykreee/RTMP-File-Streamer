//! ffmpeg argument construction. Port of `src/main/ffmpeg/command.ts`.
//!
//! The builders are transcribed line-for-line from the TypeScript original: the
//! order of arguments, the exact filter strings and the warning texts are part
//! of the app's observable behaviour and are asserted by the cargo test vectors.

use crate::ffmpeg::capabilities::{encoder_arg_for, get_available_encoder_names, ENCODER_CATALOGUE};
use crate::shared::i18n;
use crate::shared::protocol::{
    build_push_target, container_for_protocol, muxer_for_protocol, network_for_protocol,
    protocol_key_args, DEFAULT_STREAM_PROTOCOL,
};
use crate::shared::types::{
    AudioSettings, MediaInfo, MediaStreamInfo, PlaylistItem, SessionSettings, StreamProtocol,
    SubtitleRenderSettings, SubtitleTrackRef, VideoSettings,
};

/// Language used when a caller does not name one — a compatibility default. The
/// strings this module produces are the summary/warnings/notes diagnostics, and
/// the original tests asserted on their wording; leaving it out yields the
/// original Chinese.
pub const DEFAULT_COMMAND_LANGUAGE: &str = "zh";

#[derive(Debug, Clone)]
pub struct BuildRequest {
    pub ffmpeg_path: String,
    pub media: MediaInfo,
    pub item: PlaylistItem,
    pub settings: SessionSettings,
    /// Where to begin inside the file, in seconds.
    pub start_position_sec: f64,
    /// Optional override: write to a local file instead of the configured target.
    pub output_override: Option<String>,
    /// Language for the summary and warning text.
    pub language: Option<String>,
}

pub type SubtitleApplication = String; // 'burn-text' | 'copy' | 'none'

#[derive(Debug, Clone, Default)]
pub struct MappedStreams {
    pub video_stream_index: i64,
    pub audio_stream_index: i64,
}

#[derive(Debug, Clone, Default)]
pub struct GeneratedTracks {
    /// True when silence is generated because the file has no audio track.
    pub silent_audio: bool,
    /// True when black frames are generated because the file has no video track.
    pub black_video: bool,
}

#[derive(Debug, Clone, Default)]
pub struct BuiltCommand {
    pub args: Vec<String>,
    pub command_line: String,
    pub summary: Vec<String>,
    pub warnings: Vec<String>,
    pub venc_name: String,
    pub aenc_name: String,
    pub subtitle_applied: SubtitleApplication,
    pub remaining_duration_sec: f64,
    pub video_stream_index: i64,
    pub audio_stream_index: i64,
    pub silent_audio: bool,
    pub black_video: bool,
}

#[derive(Debug, Clone, Default)]
pub struct BuiltEncoderArgs {
    pub args: Vec<String>,
    /// Input argument groups the caller must add after the source file's own `-i`.
    pub inputs: Vec<String>,
    /// A/V offset the caller must apply to the source input (`-itsoffset`).
    pub input_offset_sec: f64,
    pub summary: Vec<String>,
    pub warnings: Vec<String>,
    pub venc_name: String,
    pub video_stream_index: i64,
    pub audio_stream_index: i64,
    pub silent_audio: bool,
    pub black_video: bool,
}

fn mapped_stream_indexes(
    video_in: Option<&MediaStreamInfo>,
    audio_in: Option<&MediaStreamInfo>,
    audio_codec: &str,
) -> MappedStreams {
    MappedStreams {
        video_stream_index: video_in.map(|s| s.index).unwrap_or(-1),
        audio_stream_index: if audio_in.is_some() && audio_codec != "none" {
            audio_in.map(|s| s.index).unwrap_or(-1)
        } else {
            -1
        },
    }
}

/* ------------------------------------------------------------------ *
 * Escaping / formatting helpers
 * ------------------------------------------------------------------ */

/// Escape a filesystem path for use inside an ffmpeg filter argument.
pub fn escape_filter_path(p: &str) -> String {
    let resolved = crate::store::paths::resolve_path(p);
    let s = resolved.replace('\\', "/");
    s.replace(':', "\\:")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace(';', "\\;")
        .replace('\'', "\\'")
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

fn fmt_num(n: f64) -> String {
    // JS `String(number)` for the values this app produces: integers without a
    // decimal tail, everything else in its shortest round-trip form.
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// `fmt_num` for ffprobe's integer-typed fields.
fn fmt_int(n: i64) -> String {
    n.to_string()
}

/// `#RRGGBB` -> libass `&HAABBGGRR`.
fn color_to_ass(hex: &str, alpha: u32) -> String {
    let trimmed = hex.trim();
    let body = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let aa = format!("{alpha:02X}");
    if body.len() != 6 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return format!("&H{aa}FFFFFF");
    }
    let r = body[0..2].to_ascii_uppercase();
    let g = body[2..4].to_ascii_uppercase();
    let b = body[4..6].to_ascii_uppercase();
    format!("&H{aa}{b}{g}{r}")
}

fn build_force_style(s: &SubtitleRenderSettings) -> String {
    [
        format!("FontName={}", if s.font_name.trim().is_empty() { "Arial" } else { s.font_name.trim() }),
        format!("FontSize={}", (s.font_size.round() as i64).max(8)),
        format!("PrimaryColour={}", color_to_ass(&s.primary_color, 0)),
        format!("OutlineColour={}", color_to_ass(&s.outline_color, 0)),
        "BorderStyle=1".to_string(),
        format!("Outline={}", s.outline_width.max(0.0).round() as i64),
        format!("Shadow={}", s.shadow.max(0.0).round() as i64),
        format!("Alignment={}", (s.alignment.round() as i64).clamp(1, 9)),
        format!("MarginV={}", s.margin_vertical.round().max(0.0) as i64),
        format!("Bold={}", if s.bold { -1 } else { 0 }),
        format!("Italic={}", if s.italic { -1 } else { 0 }),
    ]
    .join(",")
}

/// Build the `subtitles=` filter argument.
fn subtitles_filter_arg(source: &str, stream_index: i64, s: &SubtitleRenderSettings) -> String {
    let mut parts: Vec<String> = vec![format!("filename='{source}'")];
    if stream_index >= 0 {
        parts.push(format!("si={stream_index}"));
    }
    if s.style_mode == "force" || s.style_mode == "plain" {
        // The second escaping level: a backslash or quote inside a font name would
        // otherwise end the quoted force_style value early.
        let style = build_force_style(s)
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace(',', "\\,")
            .replace(':', "\\:");
        parts.push(format!("force_style='{style}'"));
    }
    format!("subtitles={}", parts.join(":"))
}

/// A file libass should read for a text burn-in, plus which of its tracks to use.
struct TextBurnSource {
    filename: String,
    stream_index: i64,
}

/// Decide what a text burn-in reads from, and which subtitle stream inside it.
fn resolve_text_burn_source(media: &MediaInfo, file_path: &str, track: &SubtitleTrackRef) -> Option<TextBurnSource> {
    if track.source == "external" {
        return track.path.as_ref().map(|p| TextBurnSource {
            filename: escape_filter_path(p),
            stream_index: -1,
        });
    }
    let idx = track.stream_index?;
    let relative = media.subtitle_streams.iter().position(|s| s.index == idx)? as i64;
    Some(TextBurnSource {
        filename: escape_filter_path(file_path),
        stream_index: relative,
    })
}

fn burn_source_missing_warning(track: &SubtitleTrackRef, language: &str) -> String {
    if track.source == "embedded" {
        let n = track.stream_index.map(fmt_int).unwrap_or_else(|| "?".to_string());
        i18n::t_params(language, "main.cmd.burnSourceMissingEmbedded", &[("n", n)])
    } else {
        i18n::t(language, "main.cmd.burnSourceMissingExternal")
    }
}

/// Rounds a dimension to the smallest legal even value.
pub fn even_dimension(value: f64, fallback: f64) -> f64 {
    if !value.is_finite() || value < 2.0 {
        return fallback;
    }
    (value / 2.0).round().max(1.0) * 2.0
}

pub fn resolve_scale_filter(v: &VideoSettings) -> String {
    if v.scale.trim().is_empty() {
        return String::new();
    }
    let width = even_dimension(v.scale_width.round(), 1920.0);
    if v.scale_auto {
        return format!("{}:-2", fmt_num(width));
    }
    let height = even_dimension(v.scale_height.round(), 0.0);
    if height >= 2.0 {
        format!("{}:{}", fmt_num(width), fmt_num(height))
    } else {
        format!("{}:-2", fmt_num(width))
    }
}

/// Timing compensation for the `subtitles` filter.
fn subtitle_timing_filters(offset_sec: f64, sub_delay_sec: f64) -> Option<(String, String)> {
    let shift = offset_sec + sub_delay_sec;
    if shift.abs() <= 0.0005 {
        return None;
    }
    let value = fmt_num(round2(shift));
    Some((format!("setpts=PTS-{value}/TB"), format!("setpts=PTS+{value}/TB")))
}

/* ------------------------------------------------------------------ *
 * Stream selection
 * ------------------------------------------------------------------ */

/// Picks the stream to encode: cover art and undescribable streams are never
/// chosen; the rest are scored (default track, stereo layout, bitrate/size).
fn pick_best(streams: &[MediaStreamInfo]) -> Option<MediaStreamInfo> {
    let usable: Vec<MediaStreamInfo> = streams
        .iter()
        .filter(|s| !s.codec.is_empty() && s.codec != "unknown" && !s.attached_pic.unwrap_or(false))
        .cloned()
        .collect();
    if usable.is_empty() {
        return None;
    }
    let score = |s: &MediaStreamInfo| -> f64 {
        let mut v = 0.0;
        if s.is_default.unwrap_or(false) {
            v += 1000.0;
        }
        let layout = s.channel_layout.as_deref().unwrap_or("").to_ascii_lowercase();
        if s.channels == Some(2) || layout.contains("stereo") {
            v += 200.0;
        }
        if let Some(ch) = s.channels {
            if ch > 2 && ch <= 6 {
                v += 40.0;
            }
        }
        if s.stream_type == "audio" {
            v += s.bitrate.unwrap_or(0.0) / 200_000.0;
        }
        if s.stream_type == "video" {
            v += (s.width.unwrap_or(0).min(3840)) as f64 / 50.0;
        }
        v
    };
    let mut sorted: Vec<MediaStreamInfo> = usable;
    sorted.sort_by(|a, b| score(b).partial_cmp(&score(a)).unwrap_or(std::cmp::Ordering::Equal));
    sorted.into_iter().next()
}

/// One-line stream inventory, used in the log so "no video" cases are diagnosable.
pub fn describe_streams(media: &MediaInfo, language: &str) -> String {
    if media.streams.is_empty() {
        return i18n::t(language, "main.cmd.streamsEmpty");
    }
    let parts: Vec<String> = media
        .streams
        .iter()
        .map(|s| {
            let mut bits = vec![
                format!("#{}", s.index),
                s.stream_type.clone(),
                s.codec.clone(),
            ];
            if s.stream_type == "video" {
                bits.push(format!("{}x{}", s.width.map(fmt_int).unwrap_or_else(|| "?".into()), s.height.map(fmt_int).unwrap_or_else(|| "?".into())));
                bits.push(format!("{}fps", s.fps.map(fmt_num).unwrap_or_else(|| "?".into())));
            }
            if s.stream_type == "audio" {
                bits.push(format!("{}ch", s.channels.map(fmt_int).unwrap_or_else(|| "?".into())));
                bits.push(format!("{}Hz", s.sample_rate.map(fmt_num).unwrap_or_else(|| "?".into())));
            }
            if s.attached_pic.unwrap_or(false) {
                bits.push(i18n::t(language, "main.cmd.attachedPic"));
            }
            if s.is_default.unwrap_or(false) {
                bits.push(i18n::t(language, "main.cmd.streamDefault"));
            }
            bits.join(" ")
        })
        .collect();
    i18n::t_params(language, "main.cmd.streams", &[("list", parts.join(" | "))])
}

/* ------------------------------------------------------------------ *
 * Stand-in tracks for files that do not carry them
 * ------------------------------------------------------------------ */

fn needs_silent_audio(a: &AudioSettings, audio_in: Option<&MediaStreamInfo>) -> bool {
    audio_in.is_none() && a.codec != "none" && a.codec != "copy"
}

fn needs_black_video(v: &VideoSettings, video_in: Option<&MediaStreamInfo>) -> bool {
    video_in.is_none() && v.codec != "copy"
}

fn audio_encoder_name(a: &AudioSettings) -> &'static str {
    if a.codec == "libopus" {
        "libopus"
    } else if a.codec == "libmp3lame" {
        "libmp3lame"
    } else {
        "aac"
    }
}

/// Channel count the audio settings ask for, clamped to what the muxers carry.
fn target_audio_channels(a: &AudioSettings) -> i64 {
    (a.channels as i64).clamp(1, 2).max(1)
}

/// Sample rate the target encoder works at (Opus is fixed at 48 kHz).
fn target_audio_rate(a: &AudioSettings) -> f64 {
    if audio_encoder_name(a) == "libopus" {
        48000.0
    } else if a.sample_rate != 0.0 {
        a.sample_rate
    } else {
        44100.0
    }
}

fn silent_audio_source(a: &AudioSettings) -> String {
    let layout = if target_audio_channels(a) == 1 { "mono" } else { "stereo" };
    format!("anullsrc=channel_layout={layout}:sample_rate={}", fmt_num(target_audio_rate(a)))
}

const BLACK_VIDEO_DEFAULT_SIZE: &str = "1280x720";
const BLACK_VIDEO_DEFAULT_FPS: f64 = 30.0;

/// Size and rate of the generated picture.
fn black_video_source(v: &VideoSettings) -> (String, f64) {
    let filter = resolve_scale_filter(v);
    let re = regex::Regex::new(r"^(\d+):(\d+|-2)$").expect("static regex");
    let mut size = BLACK_VIDEO_DEFAULT_SIZE.to_string();
    if let Some(m) = re.captures(&filter) {
        let width: f64 = m[1].parse().unwrap_or(0.0);
        let height: f64 = if &m[2] == "-2" { ((width * 9.0) / 32.0).round() * 2.0 } else { m[2].parse().unwrap_or(0.0) };
        if width >= 2.0 && height >= 2.0 {
            size = format!("{}x{}", fmt_num(width), fmt_num(height));
        }
    }
    let fps = if v.fps > 0.0 { v.fps } else { BLACK_VIDEO_DEFAULT_FPS };
    (format!("color=c=black:s={size}:r={}", fmt_num(fps)), fps)
}

/// How far past the file's own duration a generated track is allowed to run.
const GENERATED_TRACK_MARGIN_SEC: f64 = 10.0;

/// The input group for a generated track: `-f lavfi -i <source>` on the file's clock.
fn generated_input_args(source: &str, seconds: f64, realtime_pacing: bool, offset_sec: f64) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if realtime_pacing {
        args.push("-re".into());
    }
    if offset_sec.abs() > 0.0005 {
        args.push("-itsoffset".into());
        args.push(fmt_num(round2(offset_sec)));
    }
    // No duration when the file's own is unknown: an unbounded stand-in is the
    // safe direction (it can be cut, but it cannot cut the real material short).
    args.push("-f".into());
    args.push("lavfi".into());
    args.push("-i".into());
    args.push(if seconds > 0.0 { format!("{}:d={}", source, fmt_num(round2(seconds))) } else { source.to_string() });
    args
}

/// Length of a generated track: the file's remaining material plus the margin.
fn generated_track_seconds(remaining_sec: f64) -> f64 {
    if remaining_sec > 0.0 {
        remaining_sec + GENERATED_TRACK_MARGIN_SEC
    } else {
        0.0
    }
}

/* ------------------------------------------------------------------ *
 * Encoder specific argument groups
 * ------------------------------------------------------------------ */

const H264_PROFILES: [&str; 3] = ["baseline", "main", "high"];
const HEVC_PROFILES: [&str; 3] = ["main", "main10", "mainstillpicture"];

/// Profile name the selected encoder will accept.
fn profile_for_codec(v: &VideoSettings, spec_name: &str) -> String {
    if v.profile.is_empty() {
        return String::new();
    }
    if spec_name == "libx264" {
        return if H264_PROFILES.contains(&v.profile.as_str()) { v.profile.clone() } else { String::new() };
    }
    if spec_name == "libx265" {
        if HEVC_PROFILES.contains(&v.profile.as_str()) {
            return v.profile.clone();
        }
        if v.profile == "high" || v.profile == "baseline" {
            return "main".into();
        }
        return String::new();
    }
    v.profile.clone()
}

/// Preset name a software encoder will accept.
fn software_preset(preset: &str, encoder: &str) -> String {
    if encoder == "libx264" {
        let x264 = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"];
        if x264.contains(&preset) {
            return preset.into();
        }
        if let Some(n) = parse_p_1_7(preset) {
            return x264[(n - 1).min(x264.len() - 1)].to_string();
        }
        return "veryfast".into();
    }
    if encoder == "libx265" {
        let x265 = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"];
        if x265.contains(&preset) {
            return preset.into();
        }
        if let Some(n) = parse_p_1_7(preset) {
            return x265[(n - 1).min(x265.len() - 1)].to_string();
        }
        return "medium".into();
    }
    preset.into()
}

fn parse_p_1_7(preset: &str) -> Option<usize> {
    let re = regex::Regex::new(r"^p([1-7])$").expect("static regex");
    re.captures(preset).and_then(|m| m[1].parse().ok())
}

fn pixel_format_for(v: &VideoSettings, spec_kind: &str, spec_name: &str) -> String {
    let requested = if v.pixel_format.is_empty() { "yuv420p".to_string() } else { v.pixel_format.clone() };
    let _ = spec_name;
    // Hardware encoders need their own 8-bit surface formats: AMF and QSV take NV12.
    if spec_kind == "amf" || spec_kind == "qsv" {
        return if requested == "yuv420p" { "nv12".into() } else { requested };
    }
    requested
}

/// Builds the complete encoder-specific argument group.
fn apply_video_encoder_args(
    args: &mut Vec<String>,
    v: &VideoSettings,
    spec_name: &str,
    spec_kind: &str,
    fps: f64,
    container: Option<&str>,
) {
    let gop_frames = if v.keyframe_interval_sec > 0.0 {
        (fps * v.keyframe_interval_sec).round().max(1.0) as i64
    } else {
        0
    };
    let bf = (v.b_frames as i64).clamp(0, 4);
    let mut x264: Vec<String> = Vec::new();
    let mut x265: Vec<String> = Vec::new();

    if container == Some("flv") && spec_name == "libaom-av1" {
        // The FLV muxer treats AV1 as experimental; opt in explicitly.
        args.push("-strict".into());
        args.push("experimental".into());
    }

    /* ---- codec / preset / profile ---- */
    if spec_kind == "software" {
        if spec_name == "libsvtav1" {
            let preset = if v.preset.chars().all(|c| c.is_ascii_digit()) && !v.preset.is_empty() {
                v.preset.clone()
            } else {
                "8".into()
            };
            args.push("-preset".into());
            args.push(preset);
        } else if spec_name == "libaom-av1" {
            let numeric: i64 = if v.preset.chars().all(|c| c.is_ascii_digit()) && !v.preset.is_empty() {
                v.preset.parse().unwrap_or(8)
            } else {
                8
            };
            args.push("-cpu-used".into());
            args.push(fmt_num(numeric.clamp(0, 8) as f64));
            args.push("-usage".into());
            args.push("realtime".into());
            args.push("-lag-in-frames".into());
            args.push("0".into());
        } else if !v.preset.is_empty() {
            args.push("-preset".into());
            args.push(software_preset(&v.preset, spec_name));
        }
        if !v.tune.is_empty() && spec_name != "libsvtav1" && spec_name != "libaom-av1" {
            args.push("-tune".into());
            args.push(v.tune.clone());
        }
        let profile = profile_for_codec(v, spec_name);
        if !profile.is_empty() && (spec_name == "libx264" || spec_name == "libx265") {
            args.push("-profile:v".into());
            args.push(profile);
        }
    } else if spec_kind == "nvenc" {
        args.push("-preset".into());
        args.push(if is_p1_7(&v.preset) { v.preset.clone() } else { "p4".into() });
        if !v.profile.is_empty() && spec_name.contains("h264") {
            args.push("-profile:v".into());
            args.push(v.profile.clone());
        }
        if v.tune == "zerolatency" {
            args.push("-tune".into());
            args.push("ull".into());
        }
        args.push("-bf".into());
        args.push(fmt_num(bf as f64));
        if gop_frames > 0 {
            args.push("-forced-idr".into());
            args.push("1".into());
        }
    } else if spec_kind == "amf" {
        let quality_map: &[(&str, &str)] = &[
            ("speed", "speed"),
            ("ultrafast", "speed"),
            ("balanced", "balanced"),
            ("fast", "balanced"),
            ("quality", "quality"),
            ("medium", "quality"),
            ("slow", "quality"),
        ];
        let q = quality_map
            .iter()
            .find(|(k, _)| *k == v.preset)
            .map(|(_, val)| val.to_string())
            .unwrap_or_else(|| "balanced".into());
        args.push("-quality".into());
        args.push(q);
        if v.tune == "zerolatency" {
            // AMF's low-latency usage makes some streaming servers drop the whole
            // video track; opt in only when the user asked for it.
            args.push("-usage".into());
            args.push("lowlatency".into());
        }
        args.push("-bf".into());
        args.push(fmt_num(bf as f64));
        if !v.profile.is_empty() && spec_name.starts_with("h264") {
            args.push("-profile:v".into());
            args.push(v.profile.clone());
        }
    } else if spec_kind == "qsv" {
        args.push("-preset".into());
        args.push(if matches!(v.preset.as_str(), "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower") {
            v.preset.clone()
        } else {
            "medium".into()
        });
        args.push("-bf".into());
        args.push(fmt_num(bf as f64));
    }

    /* ---- rate control ---- */
    let bitrate = v.bitrate_kbps.round().max(100.0) as i64;
    let buf = |fallback: i64| -> i64 {
        if v.buffer_size_kbps > 0.0 {
            v.buffer_size_kbps.round() as i64
        } else {
            fallback
        }
    };

    if v.rate_control == "crf" {
        if spec_kind == "nvenc" {
            args.push("-rc".into());
            args.push("constqp".into());
            args.push("-qp".into());
            args.push(fmt_num(v.crf.round().clamp(0.0, 51.0)));
        } else if spec_kind == "amf" {
            args.push("-rc".into());
            args.push("cqp".into());
            args.push("-qp_i".into());
            args.push(fmt_num(v.crf));
            args.push("-qp_p".into());
            args.push(fmt_num(v.crf));
            args.push("-qp_b".into());
            args.push(fmt_num(v.crf));
        } else if spec_kind == "qsv" {
            args.push("-global_quality".into());
            args.push(fmt_num(v.crf));
        } else if spec_name == "libsvtav1" || spec_name == "libaom-av1" {
            args.push("-crf".into());
            args.push(fmt_num(v.crf));
            args.push("-b:v".into());
            args.push("0".into());
        } else {
            let max = if v.max_bitrate_kbps > 0.0 {
                v.max_bitrate_kbps.round() as i64
            } else {
                (bitrate as f64 * 1.5).round() as i64
            };
            args.push("-crf".into());
            args.push(fmt_num(v.crf));
            args.push("-maxrate".into());
            args.push(format!("{max}k"));
            args.push("-bufsize".into());
            args.push(format!("{}k", buf(max * 2)));
        }
    } else if v.rate_control == "cbr" {
        args.push("-b:v".into());
        args.push(format!("{bitrate}k"));
        args.push("-maxrate".into());
        args.push(format!("{bitrate}k"));
        args.push("-minrate".into());
        args.push(format!("{bitrate}k"));
        args.push("-bufsize".into());
        args.push(format!("{}k", buf(bitrate)));
        if spec_kind == "nvenc" {
            args.push("-rc".into());
            args.push("cbr".into());
            args.push("-rc-lookahead".into());
            args.push("0".into());
            if spec_name.contains("h264") {
                args.push("-nal-hrd".into());
                args.push("cbr".into());
            }
        } else if spec_kind == "amf" {
            args.push("-rc".into());
            args.push("cbr".into());
        } else if spec_kind == "qsv" {
            args.push("-look_ahead".into());
            args.push("0".into());
        } else if spec_name == "libx264" || spec_name == "libx265" {
            // Full CBR emulation so strict ingest servers stay happy.
            if spec_name == "libx264" {
                x264.push("nal-hrd=cbr".into());
                x264.push("force-cfr=1".into());
            }
            if spec_name == "libx265" {
                x265.push("strict-cbr=1".into());
            }
            args.push("-sc_threshold".into());
            args.push("0".into());
        }
    } else {
        // abr / vbr / auto
        let max = (bitrate as f64).max(if v.max_bitrate_kbps != 0.0 { v.max_bitrate_kbps } else { bitrate as f64 * 1.3 }).round() as i64;
        args.push("-b:v".into());
        args.push(format!("{bitrate}k"));
        args.push("-maxrate".into());
        args.push(format!("{max}k"));
        args.push("-bufsize".into());
        args.push(format!("{}k", buf(max * 2)));
        if spec_kind == "nvenc" {
            args.push("-rc".into());
            args.push("vbr".into());
        } else if spec_kind == "amf" {
            args.push("-rc".into());
            args.push("vbr_peak".into());
        }
    }

    /* ---- keyframes (kept in one place so nothing overrides the GOP) ---- */
    if gop_frames > 0 {
        args.push("-g".into());
        args.push(fmt_num(gop_frames as f64));
        args.push("-keyint_min".into());
        args.push(fmt_num(gop_frames as f64));
        if spec_name == "libx264" {
            x264.push(format!("keyint={gop_frames}"));
            x264.push(format!("min-keyint={gop_frames}"));
            x264.push("scenecut=0".into());
            args.push("-sc_threshold".into());
            args.push("0".into());
        } else if spec_name == "libx265" {
            x265.push(format!("keyint={gop_frames}"));
            x265.push(format!("min-keyint={gop_frames}"));
            x265.push("scenecut=0".into());
            args.push("-sc_threshold".into());
            args.push("0".into());
        }
    }

    if spec_name == "libx264" || spec_name == "libx265" {
        // Each encoder has its own private-option namespace; sending x264's flags
        // to x265 is accepted but silently ignored.
        let lookahead = format!("rc-lookahead={}", (fps / 2.0).round().clamp(0.0, 60.0) as i64);
        if spec_name == "libx264" {
            x264.push(format!("bframes={bf}"));
            x264.push(lookahead);
        } else {
            x265.push(format!("bframes={bf}"));
            x265.push(lookahead);
        }
    }

    /* ---- private option dictionaries, emitted once ---- */
    if !x264.is_empty() && spec_name == "libx264" {
        args.push("-x264-params".into());
        args.push(dedupe_preserve_order(x264).join(":"));
    }
    if !x265.is_empty() && spec_name == "libx265" {
        args.push("-x265-params".into());
        args.push(dedupe_preserve_order(x265).join(":"));
    }
}

fn dedupe_preserve_order(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

fn is_p1_7(preset: &str) -> bool {
    let re = regex::Regex::new(r"^p[1-7]$").expect("static regex");
    re.is_match(preset)
}

/// Appends audio encoder args, returns the ffmpeg encoder name used.
fn apply_audio_args(args: &mut Vec<String>, a: &AudioSettings, filters: &mut Vec<String>) -> String {
    let enc = audio_encoder_name(a);
    let target_rate = target_audio_rate(a);
    let target_ch = target_audio_channels(a);

    // Channel layout conversion is left to aresample/aformat plus the `-ac`
    // below. A hand-written pan downmix discarded the centre channel; ffmpeg's
    // default downmix includes it.
    if enc == "libopus" {
        filters.push("aresample=48000".into());
    } else {
        filters.push(format!("aresample={}", fmt_num(target_rate)));
    }
    if enc == "aac" || enc == "libmp3lame" {
        filters.push(format!(
            "aformat=sample_fmts=fltp:channel_layouts={}",
            if target_ch == 1 { "mono" } else { "stereo" }
        ));
    }

    args.push("-c:a".into());
    args.push(enc.into());
    if a.rate_control == "vbr" && enc != "libopus" {
        args.push("-q:a".into());
        args.push(if enc == "aac" { "1.2".into() } else { "2".into() });
    } else {
        args.push("-b:a".into());
        args.push(format!("{}k", a.bitrate_kbps.round().max(16.0) as i64));
    }
    args.push("-ac".into());
    args.push(fmt_num(target_ch as f64));
    args.push("-ar".into());
    args.push(fmt_num(target_rate));
    enc.to_string()
}

/// Enhanced-RTMP notice for FLV targets using a non-H.264 video codec.
fn flv_codec_warning(codec: &str, container: Option<&str>, language: &str) -> Option<String> {
    if container != Some("flv") || codec.is_empty() {
        return None;
    }
    if codec == "hevc" {
        return Some(i18n::t(language, "main.cmd.hevcEnhancedRtmp"));
    }
    if codec == "av1" {
        return Some(i18n::t(language, "main.cmd.av1EnhancedRtmp"));
    }
    None
}

/// The codec that will actually be written, following a `copy` back to its source.
fn effective_video_codec(v: &VideoSettings, video_in: Option<&MediaStreamInfo>) -> String {
    if v.codec == "copy" {
        video_in.map(|s| s.codec.clone()).unwrap_or_else(|| "copy".into())
    } else {
        v.codec.clone()
    }
}

fn effective_audio_codec(a: &AudioSettings, audio_in: Option<&MediaStreamInfo>) -> String {
    if a.codec == "copy" {
        audio_in.map(|s| s.codec.clone()).unwrap_or_else(|| "copy".into())
    } else {
        a.codec.clone()
    }
}

/// Codec combinations that fail (or lose a track) at the muxer, reported before
/// the stream starts.
fn copy_codec_warnings(
    v: &VideoSettings,
    a: &AudioSettings,
    video_in: Option<&MediaStreamInfo>,
    audio_in: Option<&MediaStreamInfo>,
    container: Option<&str>,
    language: &str,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if v.codec == "copy" {
        if let Some(video) = video_in {
            let codec = video.codec.to_ascii_lowercase();
            if container == Some("flv") && codec != "h264" && codec != "hevc" && codec != "av1" {
                warnings.push(i18n::t_params(
                    language,
                    "main.cmd.copyVideoUnsupported",
                    &[("codec", video.codec.clone()), ("container", "FLV".into())],
                ));
            }
            if container == Some("mpegts") && codec == "av1" {
                warnings.push(i18n::t(language, "main.cmd.av1NotTs"));
            }
        }
    }
    if a.codec == "copy" {
        if let Some(audio) = audio_in {
            let codec = audio.codec.to_ascii_lowercase();
            if container == Some("flv") && codec != "aac" && codec != "mp3" && codec != "opus" {
                warnings.push(i18n::t_params(
                    language,
                    "main.cmd.copyAudioUnsupported",
                    &[("codec", audio.codec.clone()), ("container", "FLV".into())],
                ));
            }
        }
    }
    warnings
}

/// Codec warning for WHIP targets.
fn whip_codec_warning(protocol: Option<&str>, video_codec: &str, audio_codec: &str, language: &str) -> Option<String> {
    if protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL) != "whip" {
        return None;
    }
    if video_codec != "h264" {
        return Some(i18n::t(language, "main.cmd.whipNeedsH264"));
    }
    if audio_codec != "libopus" && audio_codec != "opus" && audio_codec != "none" {
        return Some(i18n::t(language, "main.cmd.whipNeedsOpus"));
    }
    None
}

/// Renders the encoder description used by every summary line.
fn video_summary(language: &str, encoder: &str, hw: &str, v: &VideoSettings) -> String {
    let mode = if v.rate_control == "crf" {
        i18n::t_params(language, "main.cmd.summaryVideoModeCrf", &[("crf", fmt_num(v.crf))])
    } else {
        i18n::t_params(language, "main.cmd.summaryVideoModeBitrate", &[("kbps", fmt_num(v.bitrate_kbps))])
    };
    i18n::t_params(
        language,
        "main.cmd.summaryVideo",
        &[("encoder", encoder.into()), ("hw", hw.into()), ("mode", format!("{} {}", v.rate_control.to_uppercase(), mode))],
    )
}

/// Subtitle track selection shared by both builders.
struct SubtitleSelection {
    track: Option<SubtitleTrackRef>,
    is_text_track: bool,
}

fn select_subtitle_track(
    item: &PlaylistItem,
    settings: &SessionSettings,
    media: &MediaInfo,
) -> SubtitleSelection {
    let sub = &settings.subtitles;
    let mode = if item.mode.is_empty() { sub.mode.clone() } else { item.mode.clone() };
    let mut track: Option<SubtitleTrackRef> = None;
    if mode != "off" {
        if let Some(id) = &item.selected_subtitle_id {
            track = item.subtitle_tracks.iter().find(|t| &t.id == id).cloned();
        }
        if track.is_none() && !item.subtitle_tracks.is_empty() {
            track = item
                .subtitle_tracks
                .iter()
                .find(|t| t.family == "text")
                .or_else(|| item.subtitle_tracks.first())
                .cloned();
        }
        if track.is_none() && !media.subtitle_streams.is_empty() {
            let s0 = &media.subtitle_streams[0];
            track = Some(SubtitleTrackRef {
                id: format!("emb:{}", s0.index),
                source: "embedded".into(),
                path: None,
                stream_index: Some(s0.index),
                codec: s0.codec.clone(),
                family: s0.subtitle_family.clone().unwrap_or_else(|| "unknown".into()),
                language: None,
                title: None,
                is_default: None,
                is_forced: None,
            });
        }
    }
    let is_text_track = match &track {
        Some(t) => t.family == "text" || (t.family == "unknown" && !regex_ish_bitmap(&t.codec)),
        None => false,
    };
    SubtitleSelection { track, is_text_track }
}

fn regex_ish_bitmap(codec: &str) -> bool {
    let re = regex::Regex::new(r"(pgs|dvd|dvb|xsub|hdmv)").expect("static regex");
    re.is_match(&codec.to_ascii_lowercase())
}

/* ------------------------------------------------------------------ *
 * Main builder
 * ------------------------------------------------------------------ */

pub fn build_stream_command(req: &BuildRequest) -> Result<BuiltCommand, String> {
    let item = &req.item;
    let settings = &req.settings;
    let media = &req.media;
    let v = &settings.video;
    let a = &settings.audio;
    let sub = &settings.subtitles;
    let out = &settings.output;
    let language = req.language.clone().unwrap_or_else(|| DEFAULT_COMMAND_LANGUAGE.into());
    // The protocol decides the muxer and the container-specific behaviour.
    let protocol: StreamProtocol = if out.protocol.is_empty() {
        DEFAULT_STREAM_PROTOCOL.into()
    } else {
        out.protocol.clone()
    };
    let eff_container = container_for_protocol(Some(&protocol));

    let mut warnings: Vec<String> = Vec::new();
    let mut summary: Vec<String> = Vec::new();
    let available = get_available_encoder_names();

    let total_duration = if media.duration_sec > 0.0 { media.duration_sec } else { item.duration_sec };
    let start_pos = req.start_position_sec.max(0.0).min((total_duration - 0.2).max(0.0));
    let remaining = if total_duration > 0.0 { (total_duration - start_pos).max(0.0) } else { 0.0 };
    let copy_video = v.codec == "copy";

    let video_in = pick_best(&media.video_streams);
    let audio_in = pick_best(&media.audio_streams);
    let silent_audio = needs_silent_audio(a, audio_in.as_ref());
    let black_source = if needs_black_video(v, video_in.as_ref()) { Some(black_video_source(v)) } else { None };

    /* ---------------- subtitle selection ---------------- */
    let sel = select_subtitle_track(item, settings, media);
    let mode = if item.mode.is_empty() { sub.mode.clone() } else { item.mode.clone() };
    let track = sel.track;
    let is_text_track = sel.is_text_track;
    let has_external_sub = track.as_ref().map(|t| t.source == "external" && t.path.is_some()).unwrap_or(false);

    /* ---------------- timestamp offsets ---------------- */
    let av_offset = item.sync_offset_sec;
    let sub_delay = item.subtitle_delay_sec;
    let has_av_offset = av_offset.abs() > 0.0005;
    let has_sub_delay = sub_delay.abs() > 0.0005;

    /* ---------------- inputs ---------------- */
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "info"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if out.realtime_pacing {
        args.push("-re".into());
    }
    if start_pos > 0.05 {
        args.push("-ss".into());
        args.push(fmt_num(round2(start_pos)));
        summary.push(i18n::t_params(&language, "main.cmd.summaryStart", &[("time", fmt_num(round2(start_pos)))]));
    }
    if has_av_offset {
        args.push("-itsoffset".into());
        args.push(fmt_num(round2(av_offset)));
        summary.push(i18n::t_params(&language, "main.cmd.summaryOffset", &[("time", fmt_num(round2(av_offset)))]));
        if av_offset > 0.0 {
            warnings.push(i18n::t_params(&language, "main.cmd.offsetPositive", &[("sec", fmt_num(round2(av_offset)))]));
        }
    }
    if has_sub_delay {
        summary.push(i18n::t_params(&language, "main.cmd.summarySubtitleOffset", &[("time", fmt_num(round2(sub_delay)))]));
    }
    args.push("-fflags".into());
    args.push("+genpts".into());
    args.push("-i".into());
    args.push(item.path.clone());

    if mode == "burn" && track.is_some() && has_external_sub && is_text_track {
        let t = track.as_ref().expect("checked");
        summary.push(i18n::t_params(
            &language,
            "main.cmd.summaryExternalSub",
            &[("mode", i18n::t(&language, "main.cmd.subModeBurn")), ("name", crate::shared::types::base_name(t.path.as_deref().unwrap_or_default()))],
        ));
    }

    /* Generated tracks go after the file: every `-map` names it input 0. */
    let mut black_video_input: i64 = -1;
    let mut silent_audio_input: i64 = -1;
    let mut next_input: i64 = 1;
    let generated_sec = generated_track_seconds(remaining);
    if let Some((source, _fps)) = &black_source {
        black_video_input = next_input;
        next_input += 1;
        args.extend(generated_input_args(source, generated_sec, out.realtime_pacing, av_offset));
        summary.push(i18n::t(&language, "main.cmd.summaryBlackVideo"));
    }
    if silent_audio {
        silent_audio_input = next_input;
        args.extend(generated_input_args(&silent_audio_source(a), generated_sec, out.realtime_pacing, av_offset));
        summary.push(i18n::t(&language, "main.cmd.summarySilentAudio"));
    }

    /* ---------------- video filters ---------------- */
    let mut filters: Vec<String> = Vec::new();
    let scale_filter = resolve_scale_filter(v);
    let source_fps = video_in
        .as_ref()
        .and_then(|s| s.fps)
        .or_else(|| black_source.as_ref().map(|(_, fps)| *fps))
        .unwrap_or(0.0);
    let wants_fps = !copy_video && v.fps > 0.0 && (source_fps - v.fps).abs() > 0.05;

    if !copy_video {
        if !scale_filter.is_empty() {
            filters.push(format!("scale={scale_filter}:flags=bicubic"));
            summary.push(i18n::t_params(&language, "main.cmd.summaryScale", &[("value", scale_filter.clone())]));
        }
        if wants_fps {
            filters.push(format!("fps={}", fmt_num(v.fps)));
            summary.push(i18n::t_params(&language, "main.cmd.summaryFps", &[("fps", fmt_num(v.fps))]));
        }
    } else if !scale_filter.is_empty() || wants_fps || v.rate_control == "crf" {
        warnings.push(i18n::t(&language, "main.cmd.copyIgnoresVideo"));
    }

    /* Burn-in runs last so font sizes match the output resolution. */
    let mut burn_text = false;
    if mode == "burn" && track.is_some() {
        let track = track.as_ref().expect("checked");
        if copy_video {
            warnings.push(i18n::t(&language, "main.cmd.copyCannotBurn"));
        } else if is_text_track {
            let burn = resolve_text_burn_source(media, &item.path, track);
            if let Some(burn) = burn {
                let timing = subtitle_timing_filters(av_offset, sub_delay);
                if let Some((pre, post)) = &timing {
                    filters.push(pre.clone());
                    filters.push(subtitles_filter_arg(&burn.filename, burn.stream_index, sub));
                    filters.push(post.clone());
                } else {
                    filters.push(subtitles_filter_arg(&burn.filename, burn.stream_index, sub));
                }
                burn_text = true;
                let embedded_suffix = if track.source == "embedded" {
                    i18n::t_params(
                        &language,
                        "main.cmd.summaryBurnEmbedded",
                        &[("n", track.stream_index.map(fmt_int).unwrap_or_else(|| "?".into()))],
                    )
                } else {
                    String::new()
                };
                summary.push(format!("{}{}", i18n::t(&language, "main.cmd.summaryBurn"), embedded_suffix));
            } else {
                warnings.push(burn_source_missing_warning(track, &language));
            }
        } else if track.source == "embedded" {
            warnings.push(i18n::t(&language, "main.cmd.embeddedBitmapNoBurn"));
        } else {
            warnings.push(i18n::t(&language, "main.cmd.externalBitmapNoBurn"));
        }
    }
    if has_sub_delay && mode != "off" && track.is_some() && (mode == "copy" || !is_text_track || copy_video) {
        warnings.push(i18n::t(&language, "main.cmd.subDelayIgnored"));
    }

    let video_filter_chain = filters.join(",");
    let mut audio_filters: Vec<String> = Vec::new();

    /* ---------------- stream mapping ---------------- */
    if let Some(video) = &video_in {
        args.push("-map".into());
        args.push(format!("0:{}", video.index));
        if !video_filter_chain.is_empty() {
            args.push("-vf".into());
            args.push(video_filter_chain.clone());
        }
    } else if black_video_input >= 0 {
        args.push("-map".into());
        args.push(format!("{black_video_input}:v:0"));
        if !video_filter_chain.is_empty() {
            args.push("-vf".into());
            args.push(video_filter_chain.clone());
        }
    }
    if audio_in.is_some() && a.codec != "none" {
        args.push("-map".into());
        args.push(format!("0:{}", audio_in.as_ref().expect("checked").index));
    } else if silent_audio_input >= 0 {
        args.push("-map".into());
        args.push(format!("{silent_audio_input}:a:0"));
    }

    /* ---------------- video encoder ---------------- */
    let spec: (String, String) = if copy_video {
        ("copy".into(), "copy".into())
    } else {
        encoder_arg_for(&v.encoder, &v.codec, &available)
    };
    let mut venc_name = "copy".to_string();
    let effective_video = effective_video_codec(v, video_in.as_ref());
    let effective_audio = effective_audio_codec(a, audio_in.as_ref());
    if let Some(flv_warn) = flv_codec_warning(&effective_video, eff_container.as_deref(), &language) {
        warnings.push(flv_warn);
    }
    warnings.extend(copy_codec_warnings(v, a, video_in.as_ref(), audio_in.as_ref(), eff_container.as_deref(), &language));
    if let Some(whip_warn) = whip_codec_warning(Some(&protocol), &effective_video, &effective_audio, &language) {
        warnings.push(whip_warn);
    }

    if copy_video {
        if video_in.is_some() {
            args.push("-c:v".into());
            args.push("copy".into());
            summary.insert(0, i18n::t(&language, "main.cmd.summaryVideoCopy"));
        } else {
            warnings.push(i18n::t(&language, "main.cmd.noVideoTrackCopy"));
        }
    } else {
        if black_source.is_some() {
            warnings.push(i18n::t(&language, "main.cmd.noVideoTrack"));
        }
        venc_name = spec.0.clone();
        args.push("-c:v".into());
        args.push(spec.0.clone());
        args.push("-pix_fmt".into());
        args.push(pixel_format_for(v, &spec.1, &spec.0));
        let fps_base = if source_fps != 0.0 { source_fps } else { 30.0 };
        let fps_for_gop = if v.fps > 0.0 { v.fps } else { (fps_base.round() as i64).clamp(10, 120) as f64 };
        apply_video_encoder_args(&mut args, v, &spec.0, &spec.1, fps_for_gop, eff_container.as_deref());
        if v.repeat_headers && eff_container.as_deref() == Some("flv") {
            args.push("-flags".into());
            args.push("+cgop".into());
        }
        let hw = if spec.1 == "software" { String::new() } else { i18n::t(&language, "main.cmd.hardwareTag") };
        summary.insert(0, video_summary(&language, &spec.0, &hw, v));
        if spec.1 == "software" && v.bitrate_kbps > 12000.0 {
            warnings.push(i18n::t_params(&language, "main.cmd.softwareHighBitrate", &[("encoder", spec.0.clone())]));
        }
        if spec.1 == "amf" && v.tune == "zerolatency" {
            warnings.push(i18n::t(&language, "main.cmd.amfLowLatency"));
        }
    }

    /* ---------------- audio encoder ---------------- */
    let mut aenc_name = "none".to_string();
    if a.codec == "none" {
        summary.push(i18n::t(&language, "main.cmd.summaryAudioNone"));
    } else if a.codec == "copy" {
        if let Some(audio) = &audio_in {
            aenc_name = "copy".into();
            args.push("-c:a".into());
            args.push("copy".into());
            summary.push(i18n::t(&language, "main.cmd.summaryAudioCopy"));
            let _ = audio;
        } else {
            warnings.push(i18n::t(&language, "main.cmd.noAudioTrackCopy"));
        }
    } else {
        if silent_audio {
            warnings.push(i18n::t(&language, "main.cmd.noAudioTrack"));
        }
        if a.loudnorm && !silent_audio {
            audio_filters.push("loudnorm=I=-16:TP=-1.5:LRA=11".into());
            summary.push(i18n::t(&language, "main.cmd.summaryLoudnorm"));
        }
        let source_channels = audio_in
            .as_ref()
            .and_then(|s| s.channels)
            .unwrap_or_else(|| target_audio_channels(a));
        aenc_name = apply_audio_args(&mut args, a, &mut audio_filters);
        let av_layout = if source_channels == 1 {
            i18n::t(&language, "main.cmd.testMono")
        } else {
            i18n::t(&language, "main.cmd.testStereo")
        };
        summary.push(i18n::t_params(
            &language,
            "main.cmd.summaryAudio",
            &[
                ("encoder", aenc_name.clone()),
                ("bitrate", format!("{}kbps", fmt_num(a.bitrate_kbps))),
                ("rate", fmt_num(if a.codec == "libopus" { 48000.0 } else { a.sample_rate })),
                ("layout", av_layout),
            ],
        ));
    }
    if !audio_filters.is_empty() {
        args.push("-af".into());
        args.push(audio_filters.join(","));
    }

    if eff_container.as_deref() == Some("flv") && (effective_audio == "libopus" || effective_audio == "opus") {
        warnings.push(i18n::t(&language, "main.cmd.opusInFlv"));
    }

    /* ---------------- subtitle handling result ---------------- */
    let mut subtitle_applied: SubtitleApplication = "none".into();
    if mode == "burn" && track.is_some() && !copy_video {
        if burn_text {
            subtitle_applied = "burn-text".into();
        }
    } else if mode == "copy" && track.is_some() {
        let track = track.as_ref().expect("checked");
        let supports_subtitle_track = eff_container.as_deref() == Some("mpegts") || eff_container.as_deref() == Some("mkv");
        if !is_text_track {
            warnings.push(i18n::t(&language, "main.cmd.bitmapNoCopy"));
        } else if track.source == "embedded" && track.stream_index.is_some() {
            if supports_subtitle_track {
                args.push("-map".into());
                args.push(format!("0:{}", track.stream_index.expect("checked")));
                args.push("-c:s".into());
                args.push("copy".into());
                subtitle_applied = "copy".into();
                summary.push(i18n::t(&language, "main.cmd.summarySubCopy"));
            } else {
                warnings.push(i18n::t(&language, "main.cmd.flvNoSubtitleTrack"));
            }
        } else {
            warnings.push(i18n::t(&language, "main.cmd.externalSubNoTrack"));
        }
    }

    /* ---------------- muxing / output ---------------- */
    if silent_audio || black_source.is_some() {
        args.push("-shortest".into());
    }
    if out.drop_late_frames {
        args.push("-fflags".into());
        args.push("+genpts+igndts".into());
        args.push("-max_delay".into());
        args.push("0".into());
    }
    args.push("-max_interleave_delta".into());
    args.push("0".into());
    if eff_container.as_deref() == Some("flv") {
        args.push("-flvflags".into());
        args.push("no_duration_filesize".into());
    }
    if !out.extra_output_args.trim().is_empty() {
        args.extend(split_output_args(&out.extra_output_args));
    }
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());

    let target = req.output_override.clone().unwrap_or_else(|| build_push_target(&out.server, &out.stream_key, Some(&protocol)));
    if req.output_override.is_none() {
        if protocol == "rtmp" {
            args.push("-reconnect".into());
            args.push("1".into());
            args.push("-reconnect_streamed".into());
            args.push("1".into());
            args.push("-reconnect_delay_max".into());
            args.push(fmt_num(out.reconnect_delay_sec.max(1.0)));
        } else if protocol == "rtsp" {
            args.push("-rtsp_transport".into());
            args.push(network_for_protocol(Some(&protocol), Some(&out.network)));
        }
        args.extend(protocol_key_args(Some(&protocol), &out.stream_key));
    }
    args.push("-f".into());
    args.push(muxer_for_protocol(Some(&protocol)));
    args.push(target);

    let mapped = mapped_stream_indexes(video_in.as_ref(), audio_in.as_ref(), &a.codec);
    let command_line = build_command_line(&req.ffmpeg_path, &args);
    Ok(BuiltCommand {
        args,
        command_line,
        summary,
        warnings,
        venc_name,
        aenc_name,
        subtitle_applied,
        remaining_duration_sec: remaining,
        silent_audio,
        black_video: black_source.is_some(),
        video_stream_index: mapped.video_stream_index,
        audio_stream_index: mapped.audio_stream_index,
    })
}

/// Builds just the *codec* side of the pipeline: filters, stream mapping and
/// encoder options, with no input, muxer or destination arguments.
pub fn build_encoder_args(req: &BuildRequest) -> Result<BuiltEncoderArgs, String> {
    let item = &req.item;
    let settings = &req.settings;
    let media = &req.media;
    let v = &settings.video;
    let a = &settings.audio;
    let sub = &settings.subtitles;
    let out = &settings.output;
    let available = get_available_encoder_names();
    let language = req.language.clone().unwrap_or_else(|| DEFAULT_COMMAND_LANGUAGE.into());
    let mut warnings: Vec<String> = Vec::new();
    let mut summary: Vec<String> = Vec::new();
    let mut args: Vec<String> = Vec::new();

    let copy_video = v.codec == "copy";
    let video_in = pick_best(&media.video_streams);
    let audio_in = pick_best(&media.audio_streams);
    let silent_audio = needs_silent_audio(a, audio_in.as_ref());
    let black_source = if needs_black_video(v, video_in.as_ref()) { Some(black_video_source(v)) } else { None };

    /* ---- timestamp offsets ---- */
    let av_offset = item.sync_offset_sec;
    let sub_delay = item.subtitle_delay_sec;
    let has_av_offset = av_offset.abs() > 0.0005;
    let has_sub_delay = sub_delay.abs() > 0.0005;

    let mut inputs: Vec<String> = Vec::new();
    let mut next_input: i64 = 1;
    let mut black_video_input: i64 = -1;
    let mut silent_audio_input: i64 = -1;
    let total_duration = if media.duration_sec > 0.0 { media.duration_sec } else { item.duration_sec };
    let start_pos = req.start_position_sec.max(0.0).min((total_duration - 0.2).max(0.0));
    let generated_sec = generated_track_seconds(if total_duration > 0.0 { (total_duration - start_pos).max(0.0) } else { 0.0 });
    if let Some((source, _)) = &black_source {
        black_video_input = next_input;
        next_input += 1;
        inputs.extend(generated_input_args(source, generated_sec, false, av_offset));
        summary.push(i18n::t(&language, "main.cmd.summaryBlackVideo"));
    }
    if silent_audio {
        silent_audio_input = next_input;
        inputs.extend(generated_input_args(&silent_audio_source(a), generated_sec, false, av_offset));
        summary.push(i18n::t(&language, "main.cmd.summarySilentAudio"));
    }

    /* ---- subtitle selection ---- */
    let sel = select_subtitle_track(item, settings, media);
    let mode = if item.mode.is_empty() { sub.mode.clone() } else { item.mode.clone() };
    let track = sel.track;
    let is_text_track = sel.is_text_track;

    let mut filters: Vec<String> = Vec::new();
    let scale_filter = resolve_scale_filter(v);
    let source_fps = video_in
        .as_ref()
        .and_then(|s| s.fps)
        .or_else(|| black_source.as_ref().map(|(_, fps)| *fps))
        .unwrap_or(0.0);
    let wants_fps = !copy_video && v.fps > 0.0 && (source_fps - v.fps).abs() > 0.05;
    if !copy_video {
        if !scale_filter.is_empty() {
            filters.push(format!("scale={scale_filter}:flags=bicubic"));
            summary.push(i18n::t_params(&language, "main.cmd.summaryScale", &[("value", scale_filter.clone())]));
        }
        if wants_fps {
            filters.push(format!("fps={}", fmt_num(v.fps)));
            summary.push(i18n::t_params(&language, "main.cmd.summaryFps", &[("fps", fmt_num(v.fps))]));
        }
    }

    if mode == "burn" && track.is_some() {
        let track = track.as_ref().expect("checked");
        if copy_video {
            warnings.push(i18n::t(&language, "main.cmd.copyCannotBurn"));
        } else if is_text_track {
            let burn = resolve_text_burn_source(media, &item.path, track);
            if let Some(burn) = burn {
                let timing = subtitle_timing_filters(av_offset, sub_delay);
                if let Some((pre, post)) = &timing {
                    filters.push(pre.clone());
                    filters.push(subtitles_filter_arg(&burn.filename, burn.stream_index, sub));
                    filters.push(post.clone());
                } else {
                    filters.push(subtitles_filter_arg(&burn.filename, burn.stream_index, sub));
                }
                let embedded_suffix = if track.source == "embedded" {
                    i18n::t_params(
                        &language,
                        "main.cmd.summaryBurnEmbedded",
                        &[("n", track.stream_index.map(fmt_int).unwrap_or_else(|| "?".into()))],
                    )
                } else {
                    String::new()
                };
                summary.push(format!("{}{}", i18n::t(&language, "main.cmd.summaryBurn"), embedded_suffix));
            } else {
                warnings.push(burn_source_missing_warning(track, &language));
            }
        } else {
            warnings.push(i18n::t(
                &language,
                if track.source == "embedded" { "main.cmd.embeddedBitmapNoBurn" } else { "main.cmd.externalBitmapNoBurn" },
            ));
        }
    }
    if mode == "copy" && track.is_some() {
        warnings.push(i18n::t(
            &language,
            if track.as_ref().expect("checked").source == "embedded" && is_text_track {
                "main.cmd.subCopyBuffered"
            } else if is_text_track {
                "main.cmd.externalSubNoTrack"
            } else {
                "main.cmd.bitmapNoCopy"
            },
        ));
    }
    if has_sub_delay && mode != "off" && track.is_some() && (mode == "copy" || !is_text_track || copy_video) {
        warnings.push(i18n::t(&language, "main.cmd.subDelayIgnored"));
    }
    if has_av_offset && av_offset > 0.0 {
        warnings.push(i18n::t_params(&language, "main.cmd.offsetPositive", &[("sec", fmt_num(round2(av_offset)))]));
    }
    if has_av_offset {
        summary.push(i18n::t_params(&language, "main.cmd.summaryOffset", &[("time", fmt_num(round2(av_offset)))]));
    }
    if has_sub_delay {
        summary.push(i18n::t_params(&language, "main.cmd.summarySubtitleOffset", &[("time", fmt_num(round2(sub_delay)))]));
    }

    /* ---- mapping ---- */
    if let Some(video) = &video_in {
        args.push("-map".into());
        args.push(format!("0:{}", video.index));
        if !filters.is_empty() {
            args.push("-vf".into());
            args.push(filters.join(","));
        }
    } else if black_video_input >= 0 {
        args.push("-map".into());
        args.push(format!("{black_video_input}:v:0"));
        if !filters.is_empty() {
            args.push("-vf".into());
            args.push(filters.join(","));
        }
    }
    if audio_in.is_some() && a.codec != "none" {
        args.push("-map".into());
        args.push(format!("0:{}", audio_in.as_ref().expect("checked").index));
    } else if silent_audio_input >= 0 {
        args.push("-map".into());
        args.push(format!("{silent_audio_input}:a:0"));
    }

    /* ---- video encoder ---- */
    let spec: (String, String) = if copy_video {
        ("copy".into(), "copy".into())
    } else {
        encoder_arg_for(&v.encoder, &v.codec, &available)
    };
    let eff_container = container_for_protocol(Some(out.protocol.as_str()));
    let effective_video = effective_video_codec(v, video_in.as_ref());
    let effective_audio = effective_audio_codec(a, audio_in.as_ref());
    if let Some(flv_warn) = flv_codec_warning(&effective_video, eff_container.as_deref(), &language) {
        warnings.push(flv_warn);
    }
    warnings.extend(copy_codec_warnings(v, a, video_in.as_ref(), audio_in.as_ref(), eff_container.as_deref(), &language));
    if let Some(whip_warn) = whip_codec_warning(Some(out.protocol.as_str()), &effective_video, &effective_audio, &language) {
        warnings.push(whip_warn);
    }
    if copy_video {
        if video_in.is_some() {
            args.push("-c:v".into());
            args.push("copy".into());
            summary.insert(0, i18n::t(&language, "main.cmd.summaryVideoCopy"));
        } else {
            warnings.push(i18n::t(&language, "main.cmd.noVideoTrackCopy"));
        }
    } else {
        if black_source.is_some() {
            warnings.push(i18n::t(&language, "main.cmd.noVideoTrack"));
        }
        args.push("-c:v".into());
        args.push(spec.0.clone());
        args.push("-pix_fmt".into());
        args.push(pixel_format_for(v, &spec.1, &spec.0));
        let fps_base = if source_fps != 0.0 { source_fps } else { 30.0 };
        let fps_for_gop = if v.fps > 0.0 { v.fps } else { (fps_base.round() as i64).clamp(10, 120) as f64 };
        apply_video_encoder_args(&mut args, v, &spec.0, &spec.1, fps_for_gop, eff_container.as_deref());
        if v.repeat_headers {
            args.push("-flags".into());
            args.push("+cgop".into());
        }
        let hw = if spec.1 == "software" { String::new() } else { i18n::t(&language, "main.cmd.hardwareTag") };
        summary.insert(0, video_summary(&language, &spec.0, &hw, v));
    }

    /* ---- audio encoder ---- */
    let mut audio_filters: Vec<String> = Vec::new();
    if a.codec == "none" {
        summary.push(i18n::t(&language, "main.cmd.summaryAudioNone"));
    } else if a.codec == "copy" {
        if audio_in.is_some() {
            args.push("-c:a".into());
            args.push("copy".into());
            summary.push(i18n::t(&language, "main.cmd.summaryAudioCopy"));
        } else {
            warnings.push(i18n::t(&language, "main.cmd.noAudioTrackCopy"));
        }
    } else {
        if silent_audio {
            warnings.push(i18n::t(&language, "main.cmd.noAudioTrack"));
        }
        if a.loudnorm && !silent_audio {
            audio_filters.push("loudnorm=I=-16:TP=-1.5:LRA=11".into());
            summary.push(i18n::t(&language, "main.cmd.summaryLoudnorm"));
        }
        let source_channels = audio_in
            .as_ref()
            .and_then(|s| s.channels)
            .unwrap_or_else(|| target_audio_channels(a));
        let enc = apply_audio_args(&mut args, a, &mut audio_filters);
        let copy_layout = if source_channels == 1 {
            i18n::t(&language, "main.cmd.testMono")
        } else {
            i18n::t(&language, "main.cmd.testStereo")
        };
        summary.push(i18n::t_params(
            &language,
            "main.cmd.summaryAudio",
            &[
                ("encoder", enc),
                ("bitrate", format!("{}kbps", fmt_num(a.bitrate_kbps))),
                ("rate", fmt_num(if a.codec == "libopus" { 48000.0 } else { a.sample_rate })),
                ("layout", copy_layout),
            ],
        ));
    }
    if !audio_filters.is_empty() {
        args.push("-af".into());
        args.push(audio_filters.join(","));
    }

    if silent_audio || black_source.is_some() {
        args.push("-shortest".into());
    }

    let mapped = mapped_stream_indexes(video_in.as_ref(), audio_in.as_ref(), &a.codec);
    Ok(BuiltEncoderArgs {
        args,
        inputs,
        input_offset_sec: av_offset,
        summary,
        warnings,
        venc_name: if copy_video { "copy".into() } else { spec.0.clone() },
        video_stream_index: mapped.video_stream_index,
        audio_stream_index: mapped.audio_stream_index,
        silent_audio,
        black_video: black_source.is_some(),
    })
}

/// Splits the "extra output arguments" field into an argv vector.
pub fn split_output_args(input: &str) -> Vec<String> {
    let text = input.trim();
    if text.is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut token = false;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
                token = true;
                i += 1;
                continue;
            }
            if ch == '\\' && q == '"' && i + 1 < chars.len() && (chars[i + 1] == '"' || chars[i + 1] == '\\') {
                i += 1;
                current.push(chars[i]);
                token = true;
                i += 1;
                continue;
            }
            current.push(ch);
            token = true;
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            token = true;
            i += 1;
            continue;
        }
        if ch.is_whitespace() {
            if token {
                out.push(std::mem::take(&mut current));
                token = false;
            }
            i += 1;
            continue;
        }
        if ch == '\\' && i + 1 < chars.len() && (chars[i + 1].is_whitespace() || matches!(chars[i + 1], '"' | '\'' | '\\')) {
            i += 1;
            current.push(chars[i]);
            token = true;
            i += 1;
            continue;
        }
        current.push(ch);
        token = true;
        i += 1;
    }
    if token {
        out.push(current);
    }
    out
}

/// Quote an argument vector for display / copy-paste.
pub fn build_command_line(bin: &str, args: &[String]) -> String {
    fn quote(s: &str) -> String {
        if s.is_empty() {
            return "\"\"".into();
        }
        if !s.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | '$' | '`' | '|' | '&' | '<' | '>' | '^')) {
            return s.to_string();
        }
        format!("\"{}\"", s.replace('"', "\\\""))
    }
    let mut parts = vec![quote(bin)];
    parts.extend(args.iter().map(|a| quote(a)));
    parts.join(" ")
}

/* ------------------------------------------------------------------ *
 * Connection test command
 * ------------------------------------------------------------------ */

const TEST_PATTERN_MAX_WIDTH: f64 = 1280.0;
const TEST_PATTERN_MAX_HEIGHT: f64 = 720.0;
const TEST_PATTERN_DEFAULT: &str = "640x360";
const TEST_DEFAULT_FPS: f64 = 30.0;

fn test_pattern_size(v: &VideoSettings) -> String {
    let filter = resolve_scale_filter(v);
    let re = regex::Regex::new(r"^(\d+):(\d+|-2)$").expect("static regex");
    let Some(m) = re.captures(&filter) else {
        return TEST_PATTERN_DEFAULT.into();
    };
    let mut width: f64 = m[1].parse().unwrap_or(0.0);
    let mut height: f64 = if &m[2] == "-2" {
        ((width * 9.0) / 16.0 / 2.0).round() * 2.0
    } else {
        m[2].parse().unwrap_or(0.0)
    };
    if !(width >= 2.0) || !(height >= 2.0) {
        return TEST_PATTERN_DEFAULT.into();
    }
    let shrink = 1.0f64.min(TEST_PATTERN_MAX_WIDTH / width).min(TEST_PATTERN_MAX_HEIGHT / height);
    if shrink < 1.0 {
        width = (width * shrink / 2.0).round().max(1.0) * 2.0;
        height = (height * shrink / 2.0).round().max(1.0) * 2.0;
    }
    format!("{}x{}", fmt_num(width), fmt_num(height))
}

/// Synthetic ffmpeg command for the "test connection" action.
pub struct TestCommand {
    pub args: Vec<String>,
    pub summary: Vec<String>,
    pub notes: Vec<String>,
}

pub fn build_test_command(settings: &SessionSettings, url: &str, stream_key: &str, language: &str) -> TestCommand {
    let v = &settings.video;
    let a = &settings.audio;
    let out = &settings.output;
    let available = get_available_encoder_names();
    let mut summary: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let protocol: StreamProtocol = if out.protocol.is_empty() {
        DEFAULT_STREAM_PROTOCOL.into()
    } else {
        out.protocol.clone()
    };
    let eff_container = container_for_protocol(Some(&protocol));
    let target = build_push_target(url, stream_key, Some(&protocol));
    let pattern = test_pattern_size(v);
    let fps = if v.fps > 0.0 { v.fps } else { TEST_DEFAULT_FPS };

    /* ---------------- inputs ---------------- */
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-f",
        "lavfi",
        "-i",
        &format!("testsrc2=size={pattern}:rate={}:duration=5", fmt_num(fps)),
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=5",
        "-map",
        "0:v:0",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if a.codec != "none" {
        args.push("-map".into());
        args.push("1:a:0".into());
    }

    /* ---------------- video encoder ---------------- */
    let flv = eff_container.as_deref() == Some("flv");
    let wants_copy = v.codec == "copy";
    let spec = if wants_copy {
        encoder_arg_for("x264", "h264", &available)
    } else {
        encoder_arg_for(&v.encoder, &v.codec, &available)
    };
    args.push("-c:v".into());
    args.push(spec.0.clone());
    args.push("-pix_fmt".into());
    args.push(pixel_format_for(v, &spec.1, &spec.0));
    apply_video_encoder_args(&mut args, v, &spec.0, &spec.1, fps, eff_container.as_deref());
    if v.repeat_headers && flv {
        args.push("-flags".into());
        args.push("+cgop".into());
    }
    if wants_copy {
        notes.push(i18n::t(language, "main.cmd.testCopyVideoNote"));
    }
    let hw = if spec.1 == "software" { String::new() } else { i18n::t(language, "main.cmd.hardwareTag") };
    let mode = if v.rate_control == "crf" {
        i18n::t_params(language, "main.cmd.summaryVideoModeCrf", &[("crf", fmt_num(v.crf))])
    } else {
        i18n::t_params(language, "main.cmd.summaryVideoModeBitrate", &[("kbps", fmt_num(v.bitrate_kbps))])
    };
    summary.push(i18n::t_params(
        language,
        "main.cmd.testSummaryVideo",
        &[
            ("encoder", spec.0.clone()),
            ("hw", hw),
            ("mode", format!("{} {}", v.rate_control.to_uppercase(), mode)),
            ("size", pattern),
            ("fps", fmt_num(fps)),
        ],
    ));

    /* ---------------- audio encoder ---------------- */
    let mut audio_filters: Vec<String> = Vec::new();
    if a.codec == "none" {
        summary.push(i18n::t(language, "main.cmd.testNoAudio"));
    } else {
        if a.loudnorm {
            audio_filters.push("loudnorm=I=-16:TP=-1.5:LRA=11".into());
            summary.push(i18n::t(language, "main.cmd.summaryLoudnorm"));
        }
        let enc = apply_audio_args(&mut args, a, &mut audio_filters);
        if a.codec == "copy" {
            notes.push(i18n::t(language, "main.cmd.testCopyAudioNote"));
        }
        let rate = if enc == "libopus" { 48000.0 } else if a.sample_rate != 0.0 { a.sample_rate } else { 44100.0 };
        let layout = if (a.channels as i64).clamp(1, 2) == 1 {
            i18n::t(language, "main.cmd.testMono")
        } else {
            i18n::t(language, "main.cmd.testStereo")
        };
        let bitrate = if a.rate_control == "vbr" && enc != "libopus" {
            "VBR".to_string()
        } else {
            format!("{}kbps", fmt_num(a.bitrate_kbps))
        };
        summary.push(i18n::t_params(
            language,
            "main.cmd.summaryAudio",
            &[("encoder", enc), ("bitrate", bitrate), ("rate", fmt_num(rate)), ("layout", layout)],
        ));
    }
    if !audio_filters.is_empty() {
        args.push("-af".into());
        args.push(audio_filters.join(","));
    }

    let codec_warning = flv_codec_warning(if wants_copy { "h264" } else { v.codec.as_str() }, eff_container.as_deref(), language);
    if let Some(w) = codec_warning {
        notes.push(w);
    }
    if let Some(w) = whip_codec_warning(
        Some(&protocol),
        if wants_copy { "h264" } else { v.codec.as_str() },
        if a.codec == "copy" { "aac" } else { a.codec.as_str() },
        language,
    ) {
        notes.push(w);
    }
    if flv && a.codec == "libopus" {
        notes.push(i18n::t(language, "main.cmd.opusInFlv"));
    }
    if settings.subtitles.mode != "off" {
        notes.push(i18n::t(language, "main.cmd.testNoSubtitlesNote"));
    }

    /* ---------------- muxing / destination ---------------- */
    let extra = split_output_args(&out.extra_output_args);
    let mentions = |flag: &str| extra.iter().any(|e| e == flag);
    if !mentions("-max_interleave_delta") {
        args.push("-max_interleave_delta".into());
        args.push("0".into());
    }
    if flv && !mentions("-flvflags") {
        args.push("-flvflags".into());
        args.push("no_duration_filesize".into());
    }
    if out.drop_late_frames && !mentions("-fflags") {
        args.push("-fflags".into());
        args.push("+genpts+igndts".into());
        args.push("-max_delay".into());
        args.push("0".into());
    }
    args.extend(extra);
    if protocol == "rtsp" {
        args.push("-rtsp_transport".into());
        args.push(network_for_protocol(Some(&protocol), Some(&out.network)));
    }
    args.extend(protocol_key_args(Some(&protocol), stream_key));
    args.push("-f".into());
    args.push(muxer_for_protocol(Some(&protocol)));
    args.push(target);

    TestCommand { args, summary, notes }
}

/// Catalogue accessor kept for the IPC layer's capability naming.
pub fn encoder_ffmpeg_name(value: &str) -> Option<&'static str> {
    ENCODER_CATALOGUE.iter().find(|e| e.value == value).map(|e| e.ffmpeg_name)
}
