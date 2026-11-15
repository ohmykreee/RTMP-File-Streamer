//! Process running, ffmpeg/ffprobe discovery and capability probing.
//! Port of `src/main/ffmpeg/capabilities.ts`.

use crate::shared::defaults::CONTAINER_MUXER;
use crate::shared::i18n;
use crate::shared::types::{
    AudioEncoderOption, ContainerFormatOption, EncoderOption, FfmpegCapabilities,
};
use rand::RngCore;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/* ------------------------------------------------------------------ *
 * runProcess
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

const STREAM_TAIL_BYTES: usize = 4_000_000;
const STREAM_KEEP_BYTES: usize = 2_000_000;

/// Spawns a process, captures a bounded tail of stdout/stderr, kills it on
/// timeout. Codes: `-1` spawn failure, `-2` timeout — the sentinel values the
/// TS version uses and the callers match on.
pub async fn run_process(bin: &str, args: &[String], timeout_ms: u64) -> RunResult {
    let mut cmd = Command::new(bin);
    cmd.args(args).kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: a console must not flash when probing from the GUI app.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            return RunResult {
                code: -1,
                stdout: String::new(),
                stderr: err.to_string(),
            }
        }
    };

    // Each stream is drained by its own task into a shared bounded buffer, so a
    // timeout can still report the output captured up to that point.
    fn drain(mut stream: impl tokio::io::AsyncRead + Unpin + Send + 'static) -> tokio::task::JoinHandle<Vec<u8>> {
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 65_536];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > STREAM_TAIL_BYTES {
                            // Keep the tail without decoding anything; a truncated
                            // tail still yields a useful error.
                            let overflow = buf.len() - STREAM_KEEP_BYTES;
                            buf.drain(..overflow);
                        }
                    }
                    Err(_) => break,
                }
            }
            buf
        })
    }

    let out_task = drain(child.stdout.take().expect("stdout piped"));
    let err_task = drain(child.stderr.take().expect("stderr piped"));
    let wait = child.wait();

    let outcome = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), wait).await;
    let code = match outcome {
        Ok(Ok(status)) => status.code().unwrap_or(-1),
        Ok(Err(err)) => {
            let stdout = out_task.await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            let stderr = err_task.await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            return RunResult {
                code: -1,
                stdout,
                stderr: format!("{stderr}\n{err}"),
            };
        }
        // Timeout: kill_on_drop fires when the child handle is dropped here.
        Err(_) => -2,
    };
    let stdout = out_task.await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let mut stderr = err_task.await.map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    if code == -2 {
        stderr.push_str("\n[timeout]");
    }
    RunResult { code, stdout, stderr }
}

/* ------------------------------------------------------------------ *
 * Binary discovery
 * ------------------------------------------------------------------ */

/// Extensions the PATH search may add. `.cmd`/`.bat` are deliberately absent:
/// spawning an npm shim used to look like "ffmpeg is installed" while every
/// probe failed at start-up.
#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Search every directory on PATH for `name`.
fn search_path(name: &str) -> Option<String> {
    let path_var = std::env::var("PATH").unwrap_or_default();
    let candidate_name = format!("{name}{EXE_SUFFIX}");
    // The PATH list separator (`;` on Windows, `:` elsewhere) — not the path
    // component separator, which is what made the search find nothing.
    let separator: char = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.split(separator) {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(&candidate_name);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn common_locations(name: &str) -> Vec<String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let mut roots: Vec<String> = vec![
        "C:\\ffmpeg\\bin".into(),
        "C:\\Program Files\\ffmpeg\\bin".into(),
        "C:\\Program Files (x86)\\ffmpeg\\bin".into(),
    ];
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
        Path::new(&home)
            .join("AppData")
            .join("Local")
            .to_string_lossy()
            .into_owned()
    });
    roots.push(
        Path::new(&local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .to_string_lossy()
            .into_owned(),
    );
    let program_data = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    roots.push(
        Path::new(&program_data)
            .join("chocolatey")
            .join("bin")
            .to_string_lossy()
            .into_owned(),
    );
    roots.push(
        Path::new(&home)
            .join("scoop")
            .join("shims")
            .to_string_lossy()
            .into_owned(),
    );
    roots.push("/usr/local/bin".into());
    roots.push("/usr/bin".into());
    roots.push("/opt/homebrew/bin".into());
    roots
        .iter()
        .flat_map(|root| {
            let joined = Path::new(root).join(format!("{name}{EXE_SUFFIX}"));
            [joined.to_string_lossy().into_owned()]
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinaryResolution {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub source: String, // 'settings' | 'bundled' | 'path' | 'common-location' | 'missing'
}

/// Where the bundled `bin/` folder lives. In dev the app root's own `bin`;
/// packaged, the resource dir shipped next to the executable.
pub fn bundled_bin_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(res) = crate::store::paths::resources_dir() {
        roots.push(Path::new(&res).join("bin"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("bin"));
    }
    // A portable layout keeps `bin/` next to the executable as well.
    if let Some(exe) = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        roots.push(exe.join("bin"));
        roots.push(exe.parent().map(|p| p.join("resources/bin")).unwrap_or_else(|| exe.join("resources/bin")));
    }
    roots
}

/// Resolve the ffmpeg/ffprobe pair. Priority:
///   1. explicit path saved in settings
///   2. binaries shipped next to the app (`resources/bin` or `bin` in dev)
///   3. first hit on PATH
///   4. well-known install locations
pub fn resolve_binaries(configured_ffmpeg: &str, configured_ffprobe: &str) -> BinaryResolution {
    let exe = EXE_SUFFIX;
    let explicit_probe = if !configured_ffprobe.is_empty() && is_executable(Path::new(configured_ffprobe)) {
        configured_ffprobe.to_string()
    } else {
        String::new()
    };
    let bundled_roots = bundled_bin_roots();

    if !configured_ffmpeg.is_empty() && is_executable(Path::new(configured_ffmpeg)) {
        let probe_guess = if !explicit_probe.is_empty() {
            explicit_probe
        } else {
            Path::new(configured_ffmpeg)
                .parent()
                .map(|d| d.join(format!("ffprobe{exe}")))
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        let probe = if is_executable(Path::new(&probe_guess)) { probe_guess } else { String::new() };
        return BinaryResolution {
            ffmpeg: configured_ffmpeg.to_string(),
            ffprobe: probe,
            source: "settings".into(),
        };
    }

    for root in &bundled_roots {
        let ff = root.join(format!("ffmpeg{exe}")).to_string_lossy().into_owned();
        if is_executable(Path::new(&ff)) {
            // An explicitly configured ffprobe wins over whatever sits next to the
            // bundled ffmpeg; ignoring it made the setting silently ineffective.
            let mut fp = if !explicit_probe.is_empty() {
                explicit_probe.clone()
            } else {
                root.join(format!("ffprobe{exe}")).to_string_lossy().into_owned()
            };
            if !is_executable(Path::new(&fp)) {
                fp = search_path("ffprobe").unwrap_or_default();
            }
            return BinaryResolution { ffmpeg: ff, ffprobe: fp, source: "bundled".into() };
        }
    }

    if let Some(on_path) = search_path("ffmpeg") {
        let probe = if !explicit_probe.is_empty() {
            explicit_probe
        } else {
            search_path("ffprobe").unwrap_or_default()
        };
        return BinaryResolution { ffmpeg: on_path, ffprobe: probe, source: "path".into() };
    }

    for candidate in common_locations("ffmpeg") {
        if is_executable(Path::new(&candidate)) {
            let probe = if !explicit_probe.is_empty() {
                explicit_probe
            } else {
                common_locations("ffprobe").into_iter().find(|c| is_executable(Path::new(c))).unwrap_or_default()
            };
            return BinaryResolution {
                ffmpeg: candidate,
                ffprobe: probe,
                source: "common-location".into(),
            };
        }
    }

    BinaryResolution { ffmpeg: String::new(), ffprobe: String::new(), source: "missing".into() }
}

/* ------------------------------------------------------------------ *
 * Encoder catalogue
 * ------------------------------------------------------------------ */

/// How one encoder is named on screen. `suffix` is the ordinary tail, `suffix_full`
/// the bracketed one Chinese and Japanese use.
pub struct EncoderDef {
    pub value: &'static str,
    pub prefix: &'static str,
    pub suffix: &'static str,
    pub suffix_full: &'static str,
    pub codec: &'static str,
    pub kind: &'static str,
    pub ffmpeg_name: &'static str,
    pub presets: &'static [&'static str],
    pub note_key: Option<&'static str>,
}

pub static ENCODER_CATALOGUE: LazyLock<Vec<EncoderDef>> = LazyLock::new(|| {
    vec![
        // --- AMD AMF ---
        EncoderDef { value: "h264_amf", prefix: "H.264 · AMD AMF", suffix: " (hardware)", suffix_full: " (硬件)", codec: "h264", kind: "amf", ffmpeg_name: "h264_amf", presets: &["speed", "balanced", "quality"], note_key: None },
        EncoderDef { value: "hevc_amf", prefix: "HEVC · AMD AMF", suffix: " (hardware)", suffix_full: " (硬件)", codec: "hevc", kind: "amf", ffmpeg_name: "hevc_amf", presets: &["speed", "balanced", "quality"], note_key: None },
        EncoderDef { value: "av1_amf", prefix: "AV1 · AMD AMF", suffix: " (hardware)", suffix_full: " (硬件)", codec: "av1", kind: "amf", ffmpeg_name: "av1_amf", presets: &["speed", "balanced", "quality"], note_key: None },
        // --- NVIDIA NVENC ---
        EncoderDef { value: "h264_nvenc", prefix: "H.264 · NVIDIA NVENC", suffix: " (hardware)", suffix_full: " (硬件)", codec: "h264", kind: "nvenc", ffmpeg_name: "h264_nvenc", presets: &["p1", "p2", "p3", "p4", "p5", "p6", "p7"], note_key: None },
        EncoderDef { value: "hevc_nvenc", prefix: "HEVC · NVIDIA NVENC", suffix: " (hardware)", suffix_full: " (硬件)", codec: "hevc", kind: "nvenc", ffmpeg_name: "hevc_nvenc", presets: &["p1", "p2", "p3", "p4", "p5", "p6", "p7"], note_key: None },
        EncoderDef { value: "av1_nvenc", prefix: "AV1 · NVIDIA NVENC", suffix: " (hardware)", suffix_full: " (硬件)", codec: "av1", kind: "nvenc", ffmpeg_name: "av1_nvenc", presets: &["p1", "p2", "p3", "p4", "p5", "p6", "p7"], note_key: None },
        // --- Intel QSV ---
        EncoderDef { value: "h264_qsv", prefix: "H.264 · Intel QSV", suffix: " (hardware)", suffix_full: " (硬件)", codec: "h264", kind: "qsv", ffmpeg_name: "h264_qsv", presets: &["veryfast", "faster", "fast", "medium", "slow"], note_key: None },
        EncoderDef { value: "hevc_qsv", prefix: "HEVC · Intel QSV", suffix: " (hardware)", suffix_full: " (硬件)", codec: "hevc", kind: "qsv", ffmpeg_name: "hevc_qsv", presets: &["veryfast", "faster", "fast", "medium", "slow"], note_key: None },
        EncoderDef { value: "av1_qsv", prefix: "AV1 · Intel QSV", suffix: " (hardware)", suffix_full: " (硬件)", codec: "av1", kind: "qsv", ffmpeg_name: "av1_qsv", presets: &["veryfast", "faster", "fast", "medium", "slow"], note_key: None },
        // --- Software ---
        EncoderDef { value: "x264", prefix: "H.264 · libx264", suffix: " (software / best compatibility)", suffix_full: " (软件/兼容性最好)", codec: "h264", kind: "software", ffmpeg_name: "libx264", presets: &["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"], note_key: None },
        EncoderDef { value: "x265", prefix: "HEVC · libx265", suffix: " (software)", suffix_full: " (软件)", codec: "hevc", kind: "software", ffmpeg_name: "libx265", presets: &["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"], note_key: None },
        EncoderDef { value: "svt-av1", prefix: "AV1 · SVT-AV1", suffix: " (software)", suffix_full: " (软件)", codec: "av1", kind: "software", ffmpeg_name: "libsvtav1", presets: &["4", "6", "8", "10", "12"], note_key: None },
        EncoderDef { value: "aom-av1", prefix: "AV1 · libaom", suffix: " (software / slow)", suffix_full: " (软件/慢)", codec: "av1", kind: "software", ffmpeg_name: "libaom-av1", presets: &["8", "10", "12"], note_key: Some("main.caps.noteSlowAom") },
    ]
});

/// Audio catalogue entry: either a composed label or a table key for entries
/// that are a sentence.
pub struct AudioDef {
    pub value: &'static str,
    pub prefix: &'static str,
    pub suffix: &'static str,
    pub suffix_full: &'static str,
    pub label_key: Option<&'static str>,
    pub ffmpeg_name: &'static str,
}

pub static AUDIO_CATALOGUE: LazyLock<Vec<AudioDef>> = LazyLock::new(|| {
    vec![
        AudioDef { value: "aac", prefix: "AAC", suffix: " (native ffmpeg encoder · recommended)", suffix_full: " (原生 ffmpeg 编码器 · 推荐)", label_key: None, ffmpeg_name: "aac" },
        AudioDef { value: "libmp3lame", prefix: "MP3 · libmp3lame", suffix: "", suffix_full: "", label_key: None, ffmpeg_name: "libmp3lame" },
        AudioDef { value: "libopus", prefix: "Opus · libopus", suffix: " (poor FLV compatibility)", suffix_full: " (FLV 兼容性差)", label_key: None, ffmpeg_name: "libopus" },
        AudioDef { value: "copy", prefix: "", suffix: "", suffix_full: "", label_key: Some("main.enc.audioCopy"), ffmpeg_name: "" },
        AudioDef { value: "none", prefix: "", suffix: "", suffix_full: "", label_key: Some("main.enc.audioNone"), ffmpeg_name: "" },
    ]
});

/// Renders a catalogue label in one language.
pub fn encoder_label(prefix: &str, suffix: &str, suffix_full: &str, language: &str) -> String {
    let chosen = if language == "en" { suffix } else if suffix_full.is_empty() { suffix } else { suffix_full };
    format!("{prefix}{chosen}")
}

/// Codec preference order for `auto`: hardware first, best supported codec first.
const AUTO_PREFERENCE: [&str; 13] = [
    "h264_nvenc", "h264_amf", "h264_qsv", "x264", "hevc_nvenc", "hevc_amf", "hevc_qsv", "x265",
    "av1_nvenc", "av1_amf", "av1_qsv", "svt-av1", "aom-av1",
];

pub fn encoder_arg_for(choice: &str, codec: &str, available: &HashSet<String>) -> (String, String) {
    if codec == "copy" {
        return ("copy".into(), "copy".into());
    }
    if choice != "auto" {
        if let Some(def) = ENCODER_CATALOGUE.iter().find(|e| e.value == choice) {
            if available.contains(def.ffmpeg_name) {
                return (def.ffmpeg_name.into(), def.kind.into());
            }
        }
        // Requested encoder missing: fall through to auto selection.
    }
    for candidate in AUTO_PREFERENCE {
        let Some(def) = ENCODER_CATALOGUE.iter().find(|e| e.value == candidate) else { continue };
        if def.codec != codec {
            continue;
        }
        if available.contains(def.ffmpeg_name) {
            return (def.ffmpeg_name.into(), def.kind.into());
        }
    }
    // Last resort: software encoder for the requested codec even if unlisted.
    ENCODER_CATALOGUE
        .iter()
        .find(|e| e.codec == codec && e.kind == "software")
        .map(|e| (e.ffmpeg_name.to_string(), e.kind.to_string()))
        .unwrap_or_else(|| ("libx264".into(), "software".into()))
}

/* ------------------------------------------------------------------ *
 * Capability probing
 * ------------------------------------------------------------------ */

fn hw_test_args(encoder: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=30:d=0.1",
        "-frames:v",
        "3",
        "-c:v",
        encoder,
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Actually exercises a hardware encoder: presence in `-encoders` does not
/// guarantee a working driver. `-2` is this module's timeout, not a driver
/// verdict; one retry distinguishes "slow" from "absent".
async fn verify_hardware_encoder(ffmpeg: &str, encoder: &str) -> bool {
    let res = run_process(ffmpeg, &hw_test_args(encoder), 25_000).await;
    if res.code == -2 {
        let retry = run_process(ffmpeg, &hw_test_args(encoder), 15_000).await;
        return retry.code == 0;
    }
    res.code == 0
}

struct CacheValue {
    key: String,
    value: FfmpegCapabilities,
}

static CAPABILITY_CACHE: RwLock<Option<CacheValue>> = RwLock::new(None);

/// ffmpeg encoder names confirmed usable for this ffmpeg build/driver
/// combination. Populated by `get_capabilities`.
static ENCODER_NAME_SET: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::from(["libx264".to_string()])));

pub fn get_available_encoder_names() -> HashSet<String> {
    ENCODER_NAME_SET.read().expect("encoder set lock").clone()
}

pub fn set_available_encoder_names(names: HashSet<String>) {
    *ENCODER_NAME_SET.write().expect("encoder set lock") = names;
}

pub async fn get_capabilities(
    ffmpeg_path: &str,
    ffprobe_path: &str,
    source: &str,
    force: bool,
    language: &str,
) -> FfmpegCapabilities {
    // The language is part of the cache key: the result carries translated labels,
    // so a hit from before a language switch would hand the UI a mixed panel.
    let key = format!("{ffmpeg_path}|{ffprobe_path}|{language}");
    if !force {
        if let Some(cached) = CAPABILITY_CACHE.read().expect("caps cache lock").as_ref() {
            if cached.key == key {
                return cached.value.clone();
            }
        }
    }

    if ffmpeg_path.is_empty() {
        let empty = FfmpegCapabilities {
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            ffmpeg_version: String::new(),
            build_configuration: String::new(),
            source: "missing".into(),
            encoders: ENCODER_CATALOGUE
                .iter()
                .map(|e| EncoderOption {
                    value: e.value.into(),
                    label: encoder_label(e.prefix, e.suffix, e.suffix_full, language),
                    codec: e.codec.into(),
                    kind: e.kind.into(),
                    available: false,
                    verified: None,
                    note: e.note_key.map(|k| i18n::t(language, k)),
                    presets: e.presets.iter().map(|s| s.to_string()).collect(),
                })
                .collect(),
            audio_encoders: AUDIO_CATALOGUE
                .iter()
                .map(|a| AudioEncoderOption {
                    value: a.value.into(),
                    label: match a.label_key {
                        Some(k) => i18n::t(language, k),
                        None => encoder_label(a.prefix, a.suffix, a.suffix_full, language),
                    },
                    available: false,
                })
                .collect(),
            container_formats: CONTAINER_MUXER
                .iter()
                .map(|(name, muxer)| ContainerFormatOption {
                    value: name.to_string(),
                    label: name.to_uppercase(),
                    muxer: muxer.to_string(),
                    available: false,
                })
                .collect(),
            has_subtitle_filter: false,
            has_overlay_filter: false,
            warnings: vec![i18n::t(language, "main.caps.noFfmpeg")],
        };
        return empty;
    }

    let s = |arr: &[&str]| -> Vec<String> { arr.iter().map(|x| x.to_string()).collect() };
    let args_version = s(&["-hide_banner", "-version"]);
    let args_encoders = s(&["-hide_banner", "-encoders"]);
    let args_filters = s(&["-hide_banner", "-filters"]);
    let args_muxers = s(&["-hide_banner", "-muxers"]);
    let (version_res, enc_res, filter_res, muxer_res) = tokio::join!(
        run_process(ffmpeg_path, &args_version, 15_000),
        run_process(ffmpeg_path, &args_encoders, 20_000),
        run_process(ffmpeg_path, &args_filters, 20_000),
        run_process(ffmpeg_path, &args_muxers, 20_000),
    );

    let version_text = format!("{}{}", version_res.stdout, version_res.stderr);
    let ffmpeg_version = version_text.lines().next().unwrap_or("").trim().to_string();
    let build_configuration = version_text
        .lines()
        .find(|l| l.trim().starts_with("configuration:"))
        .map(|l| l.trim().to_string())
        .unwrap_or_default();

    let encoder_text = format!("{}{}", enc_res.stdout, enc_res.stderr);
    let filter_text = format!("{}{}", filter_res.stdout, filter_res.stderr);
    let muxer_text = format!("{}{}", muxer_res.stdout, muxer_res.stderr);

    let mut listed_encoders: HashSet<String> = HashSet::new();
    let re_encoder_line = regex::Regex::new(r"^\s*[A-Z.]{6}\s+(\S+)").expect("static regex");
    for line in encoder_text.lines() {
        if let Some(m) = re_encoder_line.captures(line) {
            listed_encoders.insert(m[1].to_string());
        }
    }
    let mut listed_filters: HashSet<String> = HashSet::new();
    let re_filter_line = regex::Regex::new(r"^\s*[TSC.]{2,3}\s+(\S+)\s+\S*->\S+").expect("static regex");
    for line in filter_text.lines() {
        if let Some(m) = re_filter_line.captures(line) {
            listed_filters.insert(m[1].to_string());
        }
    }
    let mut listed_muxers: HashSet<String> = HashSet::new();
    let re_muxer_line = regex::Regex::new(r"^\s*[E.]\s+(\S+)").expect("static regex");
    for line in muxer_text.lines() {
        if let Some(m) = re_muxer_line.captures(line) {
            listed_muxers.insert(m[1].to_string());
        }
    }

    let mut warnings: Vec<String> = Vec::new();
    if listed_encoders.is_empty() {
        warnings.push(i18n::t(language, "main.caps.encodersUnparsed"));
    }

    // Verify hardware encoders that ffmpeg claims to have.
    let hw_candidates: Vec<&EncoderDef> = ENCODER_CATALOGUE
        .iter()
        .filter(|e| e.kind != "software" && listed_encoders.contains(e.ffmpeg_name))
        .collect();
    let mut verified: HashSet<String> = HashSet::new();
    {
        let results = futures_util::future::join_all(
            hw_candidates.iter().map(|e| verify_hardware_encoder(ffmpeg_path, e.ffmpeg_name)),
        )
        .await;
        for (e, ok) in hw_candidates.iter().zip(results) {
            if ok {
                verified.insert(e.ffmpeg_name.to_string());
            }
        }
    }

    let working_software: HashSet<String> = listed_encoders
        .iter()
        .filter(|n| ENCODER_CATALOGUE.iter().any(|e| e.ffmpeg_name == **n && e.kind == "software"))
        .cloned()
        .collect();

    let encoders: Vec<EncoderOption> = ENCODER_CATALOGUE
        .iter()
        .map(|def| {
            let listed = listed_encoders.contains(def.ffmpeg_name);
            let is_hw = def.kind != "software";
            let available = if is_hw { verified.contains(def.ffmpeg_name) } else { listed };
            let mut note = def.note_key.map(|k| i18n::t(language, k));
            if is_hw && listed && !available {
                note = Some(i18n::t(language, "main.caps.noteDriver"));
            }
            if !listed && !is_hw {
                note = Some(i18n::t(language, "main.caps.noteNotBuilt"));
            }
            EncoderOption {
                value: def.value.into(),
                label: encoder_label(def.prefix, def.suffix, def.suffix_full, language),
                codec: def.codec.into(),
                kind: def.kind.into(),
                available,
                verified: if is_hw { Some(verified.contains(def.ffmpeg_name)) } else { None },
                note,
                presets: def.presets.iter().map(|s| s.to_string()).collect(),
            }
        })
        .collect();

    let mut available_encoders: HashSet<String> = encoders
        .iter()
        .filter(|e| e.available)
        .map(|e| ENCODER_CATALOGUE.iter().find(|d| d.value == e.value).expect("catalogue").ffmpeg_name.to_string())
        .collect();
    // Ensure at least one software encoder per codec is usable even if the
    // listing parse failed.
    if available_encoders.is_empty() {
        for name in &working_software {
            available_encoders.insert(name.clone());
        }
        if available_encoders.is_empty() && !ffmpeg_version.is_empty() {
            available_encoders.insert("libx264".into());
            warnings.push(i18n::t(language, "main.caps.noVerifiedEncoder"));
        }
    }

    let audio_encoders: Vec<AudioEncoderOption> = AUDIO_CATALOGUE
        .iter()
        .map(|a| AudioEncoderOption {
            value: a.value.into(),
            label: match a.label_key {
                Some(k) => i18n::t(language, k),
                None => encoder_label(a.prefix, a.suffix, a.suffix_full, language),
            },
            available: a.ffmpeg_name.is_empty() || listed_encoders.contains(a.ffmpeg_name),
        })
        .collect();

    let container_formats: Vec<ContainerFormatOption> = CONTAINER_MUXER
        .iter()
        .map(|(name, muxer)| ContainerFormatOption {
            value: name.to_string(),
            label: name.to_uppercase(),
            muxer: muxer.to_string(),
            available: listed_muxers.contains(*muxer),
        })
        .collect();

    let has_subtitle_filter = listed_filters.contains("subtitles");
    let has_overlay_filter = listed_filters.contains("overlay");
    if !has_subtitle_filter {
        warnings.push(i18n::t(language, "main.caps.noSubtitleFilter"));
    }
    if !listed_encoders.contains("aac") {
        warnings.push(i18n::t(language, "main.caps.noAac"));
    }
    let any_hw = encoders.iter().any(|e| e.kind != "software" && e.available);
    if !any_hw {
        warnings.push(i18n::t(language, "main.caps.noHardware"));
    }

    let value = FfmpegCapabilities {
        ffmpeg_path: ffmpeg_path.to_string(),
        ffprobe_path: ffprobe_path.to_string(),
        ffmpeg_version,
        build_configuration,
        source: source.to_string(),
        encoders,
        audio_encoders,
        container_formats,
        has_subtitle_filter,
        has_overlay_filter,
        warnings,
    };

    // Stash the resolved encoder name set for the command builder.
    *ENCODER_NAME_SET.write().expect("encoder set lock") = available_encoders;
    *CAPABILITY_CACHE.write().expect("caps cache lock") = Some(CacheValue { key, value: value.clone() });
    value
}

/// `crypto.randomBytes(16).toString('base64')` equivalent for the obs handshake.
pub fn random_base64_16() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
