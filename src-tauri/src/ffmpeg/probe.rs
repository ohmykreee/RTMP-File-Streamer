//! ffprobe wrapper and subtitle classification. Port of `src/main/ffmpeg/probe.ts`.

use crate::ffmpeg::capabilities::run_process;
use crate::shared::i18n;
use crate::shared::types::{
    base_name, MediaInfo, MediaStreamInfo, SubtitleCodecFamily, SubtitleTrackRef,
};
use serde_json::Value;

pub const DEFAULT_PROBE_LANGUAGE: &str = "en";

const TEXT_SUBTITLE_CODECS: [&str; 22] = [
    "subrip", "srt", "ass", "ssa", "mov_text", "text", "webvtt", "vtt", "sami", "smi", "realtext",
    "subviewer", "subviewer1", "mpl2", "jacosub", "microdvd", "pjs", "stl", "eia_608", "eia_708",
    "ttml", "dvb_teletext",
];

const BITMAP_SUBTITLE_CODECS: [&str; 7] = [
    "hdmv_pgs_subtitle",
    "pgssub",
    "dvd_subtitle",
    "dvdsub",
    "dvb_subtitle",
    "dvbsub",
    "xsub",
];

pub fn classify_subtitle(codec: &str) -> SubtitleCodecFamily {
    let c = codec.to_ascii_lowercase();
    if TEXT_SUBTITLE_CODECS.contains(&c.as_str()) {
        return "text".into();
    }
    if BITMAP_SUBTITLE_CODECS.contains(&c.as_str()) {
        return "bitmap".into();
    }
    "unknown".into()
}

fn parse_rate(rate: Option<&str>) -> Option<f64> {
    let rate = rate?;
    let mut parts = rate.split('/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den: f64 = parts.next().unwrap_or("1").parse().ok()?;
    if num == 0.0 || den == 0.0 {
        return None;
    }
    let v = num / den;
    if v.is_finite() && v > 0.0 {
        Some(v)
    } else {
        None
    }
}

fn num(value: Option<&Value>) -> Option<f64> {
    let v = value?;
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

fn str_field<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(|v| v.as_str())
}

fn to_stream_info(s: &Value) -> MediaStreamInfo {
    let type_raw = str_field(s, "codec_type").unwrap_or("unknown").to_ascii_lowercase();
    let stream_type = match type_raw.as_str() {
        "video" | "audio" | "subtitle" | "data" | "attachment" => type_raw,
        _ => "unknown".into(),
    };
    let mut info = MediaStreamInfo {
        index: s.get("index").and_then(|v| v.as_i64()).unwrap_or(-1),
        stream_type: stream_type.clone(),
        codec: str_field(s, "codec_name").unwrap_or("unknown").to_string(),
        ..Default::default()
    };
    if let Some(long) = str_field(s, "codec_long_name") {
        info.codec_long = Some(long.to_string());
    }
    if stream_type == "subtitle" {
        info.subtitle_family = Some(classify_subtitle(&info.codec));
    }
    if let Some(w) = s.get("width").and_then(|v| v.as_i64()) {
        if w != 0 {
            info.width = Some(w);
        }
    }
    if let Some(h) = s.get("height").and_then(|v| v.as_i64()) {
        if h != 0 {
            info.height = Some(h);
        }
    }
    let fps = parse_rate(str_field(s, "avg_frame_rate")).or_else(|| parse_rate(str_field(s, "r_frame_rate")));
    if let Some(fps) = fps {
        info.fps = Some((fps * 1000.0).round() / 1000.0);
    }
    if let Some(br) = num(s.get("bit_rate")) {
        if br != 0.0 {
            info.bitrate = Some(br);
        }
    }
    if let Some(d) = num(s.get("duration")) {
        info.duration_sec = Some(d);
    }
    if let Some(sr) = num(s.get("sample_rate")) {
        if sr != 0.0 {
            info.sample_rate = Some(sr);
        }
    }
    if let Some(ch) = s.get("channels").and_then(|v| v.as_i64()) {
        info.channels = Some(ch);
    }
    if let Some(layout) = str_field(s, "channel_layout") {
        info.channel_layout = Some(layout.to_string());
    }
    if let Some(tags) = s.get("tags") {
        let lang = str_field(tags, "language").or_else(|| str_field(tags, "LANGUAGE"));
        if let Some(lang) = lang {
            info.language = Some(lang.to_string());
        }
        let title = str_field(tags, "title")
            .or_else(|| str_field(tags, "TITLE"))
            .or_else(|| str_field(tags, "handler_name"));
        if let Some(title) = title {
            info.title = Some(title.to_string());
        }
    }
    if let Some(disposition) = s.get("disposition") {
        info.is_default = Some(disposition.get("default").and_then(|v| v.as_i64()).unwrap_or(0) != 0);
        info.is_forced = Some(disposition.get("forced").and_then(|v| v.as_i64()).unwrap_or(0) != 0);
        if disposition.get("attached_pic").and_then(|v| v.as_i64()).unwrap_or(0) != 0 {
            info.attached_pic = Some(true);
        }
    }
    info
}

/// Run ffprobe and normalize the JSON into `MediaInfo`.
pub async fn probe_media(ffprobe_path: &str, file_path: &str, language: &str) -> MediaInfo {
    let mut base = MediaInfo {
        path: file_path.to_string(),
        ..Default::default()
    };
    match std::fs::metadata(file_path) {
        Ok(meta) => base.size = meta.len(),
        Err(_) => {
            base.probe_error = Some(i18n::t(language, "main.dialog.probeMissing"));
            return base;
        }
    }

    if ffprobe_path.is_empty() {
        base.probe_error = Some(i18n::t(language, "main.dialog.noFfprobe"));
        return base;
    }

    let args = vec![
        "-v".to_string(),
        "error".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        "-show_entries".to_string(),
        "stream=index,codec_type,codec_name,codec_long_name,width,height,avg_frame_rate,r_frame_rate,bit_rate,duration,sample_rate,channels,channel_layout,tags,disposition:format=format_name,format_long_name,duration,size,bit_rate".to_string(),
        file_path.to_string(),
    ];
    let res = run_process(ffprobe_path, &args, 60_000).await;

    let text = res.stdout.trim().to_string();
    if text.is_empty() {
        let err_text = if res.stderr.is_empty() { i18n::t(language, "main.dialog.probeNoData") } else { res.stderr };
        let tail: Vec<&str> = err_text.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = tail.len().saturating_sub(3);
        base.probe_error = Some(tail[start..].join(" "));
        return base;
    }

    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(err) => {
            base.probe_error = Some(i18n::t_params(language, "main.dialog.probeJsonFailed", &[("error", err.to_string())]));
            return base;
        }
    };

    let streams: Vec<MediaStreamInfo> = parsed
        .get("streams")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(to_stream_info).collect())
        .unwrap_or_default();
    base.video_streams = streams.iter().filter(|s| s.stream_type == "video").cloned().collect();
    base.audio_streams = streams.iter().filter(|s| s.stream_type == "audio").cloned().collect();
    base.subtitle_streams = streams.iter().filter(|s| s.stream_type == "subtitle").cloned().collect();
    base.streams = streams;

    if let Some(fmt) = parsed.get("format") {
        base.format_name = str_field(fmt, "format_name").unwrap_or("").to_string();
        if let Some(long) = str_field(fmt, "format_long_name") {
            base.format_long_name = Some(long.to_string());
        }
        if let Some(br) = num(fmt.get("bit_rate")) {
            if br != 0.0 {
                base.bitrate = Some(br);
            }
        }
        let mut duration = num(fmt.get("duration")).unwrap_or(0.0);
        if duration == 0.0 {
            for s in &base.streams {
                if let Some(d) = s.duration_sec {
                    if d > duration {
                        duration = d;
                    }
                }
            }
        }
        base.duration_sec = (duration * 1000.0).round() / 1000.0;
    }
    base.probe_error = None;
    base
}

/// Internal subtitle tracks of a probed file, as selectable references.
pub fn embedded_subtitle_refs(info: &MediaInfo) -> Vec<SubtitleTrackRef> {
    info.subtitle_streams
        .iter()
        .map(|s| SubtitleTrackRef {
            id: format!("emb:{}", s.index),
            source: "embedded".into(),
            path: None,
            stream_index: Some(s.index),
            codec: s.codec.clone(),
            family: s.subtitle_family.clone().unwrap_or_else(|| classify_subtitle(&s.codec)),
            language: s.language.clone(),
            title: s.title.clone(),
            is_default: s.is_default,
            is_forced: s.is_forced,
        })
        .collect()
}

/// Numbers-first sniff for a `.sub` sidecar (MicroDVD `{n}{n}` / SubViewer `[INFORMATION]`).
fn sniff_text_subtitle(file_path: &str) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(file_path) else {
        return false;
    };
    let mut buf = [0u8; 4096];
    let read = file.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..read]);
    head.starts_with_whitespace_braces() || head.to_ascii_lowercase().contains("[information]")
}

trait SubSniff {
    fn starts_with_whitespace_braces(&self) -> bool;
}

impl SubSniff for str {
    fn starts_with_whitespace_braces(&self) -> bool {
        let re = regex::Regex::new(r"^\s*\{\d+\}\{\d+\}").expect("static regex");
        re.is_match(self)
    }
}

fn pair_subtitle_exists(idx_path: &str) -> bool {
    let sub_path = regex::Regex::new(r"(?i)\.idx$").expect("static regex");
    let sub_path = sub_path.replace(idx_path, ".sub").into_owned();
    std::fs::metadata(&sub_path).map(|m| m.len() > 0).unwrap_or(false)
}

/// Probe a sidecar subtitle file (srt/ass/vtt/sup/idx+sub) into a track reference.
pub async fn probe_subtitle_file(ffprobe_path: &str, file_path: &str, language: &str) -> Option<SubtitleTrackRef> {
    let ext = crate::shared::types::ext_name(file_path);
    let fallback_family: SubtitleCodecFamily = match ext.as_str() {
        ".sup" => "bitmap".into(),
        ".idx" => {
            if pair_subtitle_exists(file_path) {
                "bitmap".into()
            } else {
                "unknown".into()
            }
        }
        ".sub" => {
            if sniff_text_subtitle(file_path) {
                "text".into()
            } else {
                "bitmap".into()
            }
        }
        ".srt" | ".ass" | ".ssa" | ".vtt" => "text".into(),
        _ => "unknown".into(),
    };

    let size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return None;
    }

    let info = probe_media(ffprobe_path, file_path, language).await;
    let sub = info.subtitle_streams.first().cloned();
    let Some(sub) = sub else {
        // ffprobe cannot always describe idx/sub pairs; fall back to the extension.
        if fallback_family == "unknown" {
            return None;
        }
        return Some(SubtitleTrackRef {
            id: format!("ext:{file_path}"),
            source: "external".into(),
            path: Some(file_path.to_string()),
            stream_index: None,
            codec: ext.trim_start_matches('.').to_string(),
            family: fallback_family,
            language: None,
            title: None,
            is_default: None,
            is_forced: None,
        });
    };
    let title = sub.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| base_name(file_path));
    let reference = SubtitleTrackRef {
        id: format!("ext:{file_path}"),
        source: "external".into(),
        path: Some(file_path.to_string()),
        stream_index: None,
        codec: sub.codec.clone(),
        family: sub.subtitle_family.clone().unwrap_or(fallback_family),
        language: sub.language.clone(),
        title: Some(title),
        is_default: None,
        is_forced: None,
    };
    Some(reference)
}
