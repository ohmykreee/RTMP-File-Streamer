//! Shared helpers for the Rust port of `test/harness.mjs`.
//!
//! The fixture generation is a faithful port of `test/make-fixtures.mjs` (same
//! ffmpeg invocations, same durations, mutually distinct resolutions) and
//! `probe_fixture` mirrors the harness's `makeItem` (embedded refs plus sidecar
//! `.srt` discovery, preferred track = first text track). Generation and probing
//! run once per test binary and are cached in process globals.
//!
//! Fixture generation uses a blocking `std::process::Command` because it runs
//! inside a `OnceLock` that is reached from both sync and async tests; every
//! other ffmpeg/ffprobe execution goes through the crate's own `run_process`.

#![allow(dead_code)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rtmp_file_streamer::ffmpeg::capabilities::{
    get_available_encoder_names, run_process, set_available_encoder_names, RunResult,
};
use rtmp_file_streamer::ffmpeg::command::BuildRequest;
use rtmp_file_streamer::ffmpeg::probe::{embedded_subtitle_refs, probe_media, probe_subtitle_file};
use rtmp_file_streamer::shared::types::{
    base_name, MediaInfo, ObsWebSocketSettings, OutputSettings, PlaylistItem, SessionSettings,
    SubtitleRenderSettings, SubtitleTrackRef, AudioSettings, VideoSettings,
};

/* ------------------------------------------------------------------ *
 * Binaries
 * ------------------------------------------------------------------ */

pub fn ffmpeg_bin() -> String {
    std::env::var("FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".into())
}

pub fn ffprobe_bin() -> String {
    std::env::var("FFPROBE_BIN").unwrap_or_else(|_| "ffprobe".into())
}

/// The command builder reads a process-wide available-encoder set. The tests
/// that swap it must not race the tests that only read it, so every test that
/// builds a command takes this lock first.
pub static BUILDER_LOCK: Mutex<()> = Mutex::new(());

/// Lock acquisition that survives a poisoned mutex: one test's panic must not
/// cascade into `PoisonError` failures across the whole suite.
pub fn builder_lock() -> std::sync::MutexGuard<'static, ()> {
    BUILDER_LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

/// RAII override of the builder's available-encoder set; restores the previous
/// set on drop, including on assertion failure.
pub struct EncoderOverride(HashSet<String>);

impl EncoderOverride {
    pub fn set(names: &[&str]) -> Self {
        let previous = get_available_encoder_names();
        set_available_encoder_names(names.iter().map(|s| s.to_string()).collect());
        Self(previous)
    }
}

impl Drop for EncoderOverride {
    fn drop(&mut self) {
        set_available_encoder_names(std::mem::take(&mut self.0));
    }
}

/* ------------------------------------------------------------------ *
 * Process helpers
 * ------------------------------------------------------------------ */

#[cfg(windows)]
fn hide_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW, matching what the app's own run_process does.
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut std::process::Command) {}

/// Blocking run used only for fixture generation (see module doc).
fn run_sync(bin: &str, args: &[String]) -> (i32, String, String) {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args);
    hide_window(&mut cmd);
    match cmd.output() {
        Ok(out) => (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ),
        Err(err) => (-1, String::new(), err.to_string()),
    }
}

/// Spawn `bin args` and fail loudly when the binary itself is missing.
pub async fn run(bin: &str, args: &[String], timeout_ms: u64) -> RunResult {
    let res = run_process(bin, args, timeout_ms).await;
    if res.code == -1 {
        panic!(
            "failed to spawn {bin} (args: {}): {} — is ffmpeg on PATH, or set FFMPEG_BIN/FFPROBE_BIN?",
            args.join(" "),
            res.stderr.trim()
        );
    }
    res
}

pub fn str_args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// stderr tail for failure messages, like the harness prints.
pub fn stderr_tail(stderr: &str, lines: usize) -> String {
    let collected: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = collected.len().saturating_sub(lines);
    collected[start..].join(" / ")
}

/* ------------------------------------------------------------------ *
 * Fixtures (port of test/make-fixtures.mjs)
 * ------------------------------------------------------------------ */

pub struct Fixtures {
    pub dir: PathBuf,
    pub clip_a: String,
    pub clip_a_srt: String,
    pub clip_b: String,
    pub clip_c: String,
    pub clip_d: String,
    pub clip_e: String,
    pub clip_emb: String,
}

static FIXTURES: OnceLock<Fixtures> = OnceLock::new();

/// Output path for a generated test artifact, inside the fixture directory
/// (which lives under `target/`, so .gitignore covers it).
pub fn out_file(name: &str) -> String {
    fixtures()
        .dir
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn fixtures_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("STREAMER_TEST_FIXTURES") {
        return PathBuf::from(dir);
    }
    // Per-process directory: two test binaries can run one after the other
    // without racing each other's files.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("test-fixtures-{}", std::process::id()))
}

fn run_sync_or_panic(bin: &str, args: &[String], label: &str) {
    let (code, _stdout, stderr) = run_sync(bin, args);
    if code != 0 {
        panic!("ffmpeg failed for {label} (exit {code}): {}", stderr_tail(&stderr, 6));
    }
}

/// One synthetic clip, arguments transcribed from `make-fixtures.mjs`.
fn clip(out: &Path, size: &str, fps: i64, seconds: i64, freq: i64, color: Option<&str>, video_only: bool) {
    if out.exists() {
        return;
    }
    let video = match color {
        Some(c) => format!("color=c={c}:size={size}:rate={fps}:duration={seconds}"),
        None => format!("testsrc2=size={size}:rate={fps}:duration={seconds}"),
    };
    let mut args = str_args(&["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"]);
    args.push(video);
    if !video_only {
        args.extend(str_args(&["-f", "lavfi", "-i"]));
        args.push(format!("sine=frequency={freq}:sample_rate=44100:duration={seconds}"));
    }
    args.extend(str_args(&["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]));
    if !video_only {
        args.extend(str_args(&["-c:a", "aac", "-b:a", "128k", "-shortest"]));
    }
    args.push(out.to_string_lossy().into_owned());
    let name = out.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let only = if video_only { ", video only" } else { "" };
    let label = format!("{name} ({seconds}s {size}@{fps}{only})");
    run_sync_or_panic(&ffmpeg_bin(), &args, &label);
}

fn generate_fixtures() -> Fixtures {
    let dir = fixtures_dir();
    std::fs::create_dir_all(&dir).expect("create fixture dir");

    // Fail with a clear message instead of one panic per probe later on.
    let (code, _, stderr) = run_sync(&ffmpeg_bin(), &str_args(&["-version"]));
    if code == -1 {
        panic!(
            "ffmpeg is not runnable (tried `{}`): {stderr} — install ffmpeg or set FFMPEG_BIN",
            ffmpeg_bin()
        );
    }

    let p = |name: &str| dir.join(name);
    // The resolutions are mutually distinct on purpose: fixtures are told apart
    // by their picture, and a shared size makes "which file is this" unanswerable.
    clip(&p("clip_a.mp4"), "1280x720", 30, 20, 440, None, false);
    clip(&p("clip_b.mp4"), "854x480", 25, 15, 660, None, false);
    clip(&p("clip_c.mp4"), "1280x720", 30, 12, 880, Some("navy"), false);
    // clip_d is video only and deliberately 640x360 (no other fixture has it).
    clip(&p("clip_d.mp4"), "640x360", 60, 45, 550, None, true);

    // clip_a.srt: cues at 2s-8s and 9s-16s (the burn-in checks sample inside them).
    let srt = p("clip_a.srt");
    if !srt.exists() {
        std::fs::write(
            &srt,
            "1\n00:00:02,000 --> 00:00:08,000\nHELLO 字幕测试 中文渲染检查\n\n2\n00:00:09,000 --> 00:00:16,000\nSECOND CUE LINE 第二条\n",
        )
        .expect("write clip_a.srt");
    }

    // clip_emb.mkv carries those subtitles INSIDE the container as stream #2.
    let emb = p("clip_emb.mkv");
    if !emb.exists() {
        let args: Vec<String> = str_args(&["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .into_iter()
            .chain([p("clip_a.mp4").to_string_lossy().into_owned()])
            .chain(str_args(&["-i"]))
            .chain([srt.to_string_lossy().into_owned()])
            .chain(str_args(&[
                "-map",
                "0:v",
                "-map",
                "0:a",
                "-map",
                "1:0",
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                "-c:s",
                "srt",
                "-metadata:s:s:0",
                "language=chi",
                "-metadata:s:s:0",
                "title=简体",
            ]))
            .chain([emb.to_string_lossy().into_owned()])
            .collect();
        run_sync_or_panic(&ffmpeg_bin(), &args, "clip_emb.mkv (clip_a.mp4 with the sidecar muxed in as stream #2)");
    }

    // clip_e.mp4 has NO video stream (deliberately mono).
    let e = p("clip_e.mp4");
    if !e.exists() {
        let args: Vec<String> = str_args(&["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=990:sample_rate=44100:duration=12", "-ac", "1", "-c:a", "aac", "-b:a", "96k"])
            .into_iter()
            .chain([e.to_string_lossy().into_owned()])
            .collect();
        run_sync_or_panic(&ffmpeg_bin(), &args, "clip_e.mp4 (12s audio only — no video stream)");
    }

    Fixtures {
        clip_a: p("clip_a.mp4").to_string_lossy().into_owned(),
        clip_a_srt: srt.to_string_lossy().into_owned(),
        clip_b: p("clip_b.mp4").to_string_lossy().into_owned(),
        clip_c: p("clip_c.mp4").to_string_lossy().into_owned(),
        clip_d: p("clip_d.mp4").to_string_lossy().into_owned(),
        clip_e: p("clip_e.mp4").to_string_lossy().into_owned(),
        clip_emb: emb.to_string_lossy().into_owned(),
        dir,
    }
}

pub fn fixtures() -> &'static Fixtures {
    FIXTURES.get_or_init(generate_fixtures)
}

/* ------------------------------------------------------------------ *
 * Probing (port of the harness's makeItem)
 * ------------------------------------------------------------------ */

/// Probe one fixture the way the harness builds playlist items: embedded refs
/// plus a sidecar `.srt` next to the file, preferred track = first text track.
pub async fn make_item(ffprobe: &str, file_path: &str) -> (MediaInfo, PlaylistItem) {
    let info = probe_media(ffprobe, file_path, "en").await;
    if let Some(err) = &info.probe_error {
        panic!("probe failed for {file_path}: {err}");
    }
    let mut tracks: Vec<SubtitleTrackRef> = embedded_subtitle_refs(&info);
    let srt_path = Path::new(file_path).with_extension("srt");
    let srt = srt_path.to_string_lossy().into_owned();
    if srt_path.exists() && !tracks.iter().any(|t| t.path.as_deref() == Some(srt.as_str())) {
        if let Some(r) = probe_subtitle_file(ffprobe, &srt, "en").await {
            tracks.push(r);
        }
    }
    let preferred = tracks.iter().find(|t| t.family == "text").or_else(|| tracks.first());
    let item = PlaylistItem {
        id: "test".into(),
        path: file_path.into(),
        name: base_name(file_path),
        size: info.size,
        duration_sec: info.duration_sec,
        subtitle_tracks: tracks.clone(),
        selected_subtitle_id: preferred.map(|t| t.id.clone()),
        mode: if tracks.is_empty() { "off".into() } else { "burn".into() },
        sync_offset_sec: 0.0,
        subtitle_delay_sec: 0.0,
        status: "pending".into(),
        error: None,
        broken: None,
    };
    (info, item)
}

pub async fn probe_fixture(ffprobe: &str, path: &str) -> (MediaInfo, PlaylistItem) {
    make_item(ffprobe, path).await
}

/// All probed fixtures, produced once per test binary.
pub struct Probed {
    pub info_a: MediaInfo,
    pub item_a: PlaylistItem,
    pub info_b: MediaInfo,
    pub item_b: PlaylistItem,
    pub info_emb: MediaInfo,
    pub item_emb: PlaylistItem,
    pub info_d: MediaInfo,
    pub item_d: PlaylistItem,
    pub info_e: MediaInfo,
    pub item_e: PlaylistItem,
}

static PROBED: OnceLock<Probed> = OnceLock::new();

pub fn probed() -> &'static Probed {
    PROBED.get_or_init(|| {
        let fx = fixtures();
        let ffprobe = ffprobe_bin();
        // Probing goes through the crate's async run_process; a dedicated thread
        // with its own runtime keeps this callable from sync tests without
        // nesting runtimes.
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("probe runtime");
            rt.block_on(async move {
                let (info_a, item_a) = make_item(&ffprobe, &fx.clip_a).await;
                let (info_b, item_b) = make_item(&ffprobe, &fx.clip_b).await;
                let (info_emb, item_emb) = make_item(&ffprobe, &fx.clip_emb).await;
                let (info_d, item_d) = make_item(&ffprobe, &fx.clip_d).await;
                let (info_e, item_e) = make_item(&ffprobe, &fx.clip_e).await;
                Probed { info_a, item_a, info_b, item_b, info_emb, item_emb, info_d, item_d, info_e, item_e }
            })
        })
        .join()
        .expect("fixture probing panicked")
    })
}

/* ------------------------------------------------------------------ *
 * baseSession (port of the harness's baseSession)
 * ------------------------------------------------------------------ */

pub fn base_session() -> SessionSettings {
    SessionSettings {
        video: VideoSettings {
            codec: "h264".into(),
            encoder: "auto".into(),
            rate_control: "cbr".into(),
            bitrate_kbps: 2500.0,
            max_bitrate_kbps: 2500.0,
            buffer_size_kbps: 5000.0,
            crf: 23.0,
            preset: "ultrafast".into(),
            tune: "zerolatency".into(),
            profile: "".into(),
            keyframe_interval_sec: 2.0,
            b_frames: 0.0,
            scale: "".into(),
            scale_width: 1920.0,
            scale_height: 1080.0,
            scale_auto: true,
            fps: 0.0,
            pixel_format: "yuv420p".into(),
            repeat_headers: true,
        },
        audio: AudioSettings {
            codec: "aac".into(),
            rate_control: "cbr".into(),
            bitrate_kbps: 128.0,
            sample_rate: 44100.0,
            channels: 2.0,
            loudnorm: false,
        },
        subtitles: SubtitleRenderSettings {
            mode: "burn".into(),
            style_mode: "force".into(),
            font_name: "Microsoft YaHei".into(),
            font_size: 28.0,
            primary_color: "#FFFFFF".into(),
            outline_color: "#000000".into(),
            outline_width: 2.0,
            shadow: 0.0,
            margin_vertical: 28.0,
            alignment: 2.0,
            bold: false,
            italic: false,
        },
        output: OutputSettings {
            server: "rtmp://127.0.0.1:1935/live".into(),
            stream_key: "test".into(),
            // The harness session carries no protocol (older schema): empty
            // resolves to rtmp exactly like the omitted field does in TS.
            protocol: "".into(),
            network: "tcp".into(),
            container: "flv".into(),
            extra_output_args: "".into(),
            realtime_pacing: false,
            obs_web_socket: ObsWebSocketSettings {
                enabled: false,
                host: "127.0.0.1".into(),
                port: 4455.0,
                password: "".into(),
            },
            buffered: false,
            buffer_sec: 12.0,
            loop_playlist: false,
            reconnect_delay_sec: 3.0,
            max_reconnect_attempts: 3.0,
            drop_late_frames: false,
        },
    }
}

/* ------------------------------------------------------------------ *
 * Assertion helpers
 * ------------------------------------------------------------------ */

/// The value following the first occurrence of `flag`.
pub fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

/// The value following the LAST occurrence of `flag` (`-f` names an input
/// format first and the output muxer last).
pub fn last_arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .rposition(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

/// The `-vf` chain of a built command ('' when absent).
pub fn vf_of(args: &[String]) -> String {
    arg_after(args, "-vf").unwrap_or("").to_string()
}

/// The `subtitles=` term of a `-vf` chain, if present.
pub fn sub_filter_of(vf: &str) -> Option<String> {
    vf.split(',').find(|f| f.starts_with("subtitles=")).map(|s| s.to_string())
}

/// True when `args` contains `-map` followed by `mapping`.
pub fn has_map(args: &[String], mapping: &str) -> bool {
    args.windows(2).any(|w| w[0] == "-map" && w[1] == mapping)
}

/* ------------------------------------------------------------------ *
 * BuildRequest helpers
 * ------------------------------------------------------------------ */

pub fn build_request(
    media: &MediaInfo,
    item: &PlaylistItem,
    settings: &SessionSettings,
    start_position_sec: f64,
    output_override: Option<String>,
) -> BuildRequest {
    BuildRequest {
        ffmpeg_path: ffmpeg_bin(),
        media: media.clone(),
        item: item.clone(),
        settings: settings.clone(),
        start_position_sec,
        output_override,
        language: None,
    }
}

/// The harness's burn session: baseSession with 1280x720 auto scaling at 30 fps.
pub fn burn_session() -> SessionSettings {
    let mut s = base_session();
    s.video.scale = "1280:-2".into();
    s.video.scale_width = 1280.0;
    s.video.scale_height = 720.0;
    s.video.scale_auto = true;
    s.video.fps = 30.0;
    s
}

/// A copy of the item with subtitle handling switched off.
pub fn mode_off(item: &PlaylistItem) -> PlaylistItem {
    let mut i = item.clone();
    i.mode = "off".into();
    i
}

/// An OutputSettings triple the way the redaction tests build it.
pub fn output_settings(server: &str, key: &str, protocol: &str) -> OutputSettings {
    let mut out = base_session().output;
    out.server = server.into();
    out.stream_key = key.into();
    out.protocol = protocol.into();
    out
}
