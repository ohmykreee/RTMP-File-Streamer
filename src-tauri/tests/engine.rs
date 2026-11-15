//! Engine integration test: drives `stream::engine::StreamEngine` through real
//! ffmpeg processes the way the Electron-era driver `test/engine-run.cjs` did —
//! a local `ffmpeg -listen 1` process plays the RTMP ingest server, the engine
//! pushes real re-encoded video at it, and the assertions watch the session
//! lifecycle and the viewer-facing timeline.
//!
//! Scenarios (one `#[tokio::test]` each; run with `--test-threads=1`, the
//! suites bind ports and spawn many processes):
//!
//! 1. `plain_pipeline_full_run` — the single-process pipeline plays a 2-item
//!    playlist to the end. Sampled while live, the blue-bar regressions are
//!    asserted: the viewer's position/current index may only move with the
//!    published stream (`completed == sumBefore + position` at every sample,
//!    entries only earned by the published total), and a finished run leaves
//!    the timeline zeroed (`resetViewerTimeline`).
//! 2. `buffered_pipeline_full_run` — the two-process playout (buffer lead 12 s)
//!    plays the same playlist over ONE publish session; the encoder must lead
//!    the publisher and the same timeline regressions must hold.
//! 3. `stop_mid_run` — a manual stop returns to idle with the viewer timeline
//!    zeroed and no entry left "live".
//! 4. `skip_while_live` — `skip_next` mid-file discards the buffer, restarts
//!    the publish session at the next entry and finishes it (skipped + done).
//!
//! Fixtures are generated once with real ffmpeg into
//! `target/test-fixtures-engine/` and reused when present. Resolutions are
//! deliberately distinct — from each other and from the Node suites' fixtures —
//! and audio is 44.1 kHz mono sine, so received sessions are identifiable by
//! their content.
//!
//! Run with:
//!
//! ```text
//! cargo test --test engine -- --test-threads=1 --nocapture
//! ```

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rtmp_file_streamer::ffmpeg::capabilities::resolve_binaries;
use rtmp_file_streamer::ffmpeg::probe::probe_media;
use rtmp_file_streamer::shared::types::{
    AudioSettings, EngineStatus, LogEntry, MediaInfo, ObsWebSocketSettings, OutputSettings,
    PlaylistItem, SessionSettings, SubtitleRenderSettings, VideoSettings,
};
use rtmp_file_streamer::stream::engine::{EngineDeps, EngineSink, StreamEngine};

const POLL: Duration = Duration::from_millis(250);
/// How long a scenario waits for the local ingest to be listening again.
const LISTEN_WAIT: Duration = Duration::from_secs(20);
/// Hard cap on one full playlist run; exceeding it fails with a log dump.
const RUN_TIMEOUT: Duration = Duration::from_secs(150);
/// Hard cap on shorter in-run waits (first seconds, post-skip entry change).
const PHASE_WAIT: Duration = Duration::from_secs(40);
/// Hard cap on one engine control call (start / skip / stop).
const CONTROL_WAIT: Duration = Duration::from_secs(60);
/// Force-exit deadline for a scenario that wedged outright.
const WATCHDOG_SECS: u64 = 300;
/// A received session below this many bytes carried no real content.
const DATA_FLOOR_BYTES: u64 = 50_000;
/// Slack for received-airtime comparisons (muxing delay, kill grace).
const AIRTIME_TOLERANCE_SEC: f64 = 3.0;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

struct FixtureSpec {
    file: &'static str,
    size: &'static str,
    fps: u32,
    seconds: u32,
    freq: u32,
}

/// Distinct sizes: each other suite in this repo uses 320x180 / 640x360 /
/// 1280x720 / 854x480, and the two fixtures here must also differ from each
/// other, because received sessions are told apart by their picture.
const CLIP_A: FixtureSpec = FixtureSpec { file: "eng_a.mp4", size: "480x270", fps: 25, seconds: 15, freq: 440 };
const CLIP_B: FixtureSpec = FixtureSpec { file: "eng_b.mp4", size: "512x288", fps: 30, seconds: 12, freq: 660 };

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-fixtures-engine")
}

/// Generates one fixture with real ffmpeg if it is not on disk yet (the
/// minimal port of `test/make-fixtures.mjs`: testsrc2 video + mono sine).
fn ensure_fixture(ffmpeg: &str, dir: &Path, spec: &FixtureSpec) -> PathBuf {
    let out = dir.join(spec.file);
    if out.is_file() && out.metadata().map(|m| m.len() > 10_000).unwrap_or(false) {
        return out;
    }
    std::fs::create_dir_all(dir).expect("create fixture dir");
    let status = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={}:rate={}:duration={}", spec.size, spec.fps, spec.seconds),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={}:sample_rate=44100:duration={}", spec.freq, spec.seconds),
            "-ac",
            "1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-shortest",
        ])
        .arg(&out)
        .status()
        .expect("spawn ffmpeg for fixture");
    assert!(status.success(), "fixture generation failed for {}", spec.file);
    out
}

/// Picks a free TCP port the way the driver does: bind an ephemeral listener,
/// read the port, drop the listener.
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("bind ephemeral port")
        .local_addr()
        .expect("local addr")
        .port()
}

/* ------------------------------------------------------------------ *
 * Local RTMP ingest: one `ffmpeg -listen 1` process at a time, each
 * accepting exactly one publish connection and recording it to FLV —
 * the same stand-in for a streaming server the Node harnesses use.
 * ------------------------------------------------------------------ */

#[derive(Clone)]
struct ReceivedFile {
    path: PathBuf,
    size: u64,
}

struct Ingest {
    ffmpeg: String,
    port: u16,
    dir: PathBuf,
    stopping: AtomicBool,
    /// True only once a listener has been alive for a moment, so a process
    /// that died on spawn is never mistaken for a ready server.
    listener_ready: AtomicBool,
    children: Mutex<Vec<Arc<Mutex<tokio::process::Child>>>>,
    received: Mutex<Vec<ReceivedFile>>,
    stderr_tail: Mutex<Vec<String>>,
}

impl Ingest {
    fn new(ffmpeg: &str, port: u16, dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            ffmpeg: ffmpeg.to_string(),
            port,
            dir: dir.to_path_buf(),
            stopping: AtomicBool::new(false),
            listener_ready: AtomicBool::new(false),
            children: Mutex::new(vec![]),
            received: Mutex::new(vec![]),
            stderr_tail: Mutex::new(vec![]),
        })
    }

    /// The respawn loop: a real server accepts one publish session at a time
    /// and can be re-connected to, so every connection gets its own listener
    /// process and its own output file.
    fn start(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut idx = 0usize;
            while !this.stopping.load(Ordering::SeqCst) {
                let file = this.dir.join(format!("session_recv_{idx}.flv"));
                let _ = std::fs::remove_file(&file);
                let mut cmd = tokio::process::Command::new(&this.ffmpeg);
                cmd.args([
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-listen",
                    "1",
                    "-f",
                    "flv",
                    "-i",
                    &format!("rtmp://127.0.0.1:{}/live/test", this.port),
                    "-c",
                    "copy",
                    "-f",
                    "flv",
                    "-y",
                ])
                .arg(&file)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
                #[cfg(windows)]
                {
                    cmd.creation_flags(0x0800_0000);
                }
                let mut child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(err) => {
                        eprintln!("[ingest #{idx}] spawn failed: {err}");
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        continue;
                    }
                };
                let reader_ingest = Arc::clone(&this);
                if let Some(stderr) = child.stderr.take() {
                    tokio::spawn(async move {
                        use tokio::io::{AsyncBufReadExt, BufReader};
                        let mut lines = BufReader::new(stderr).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            let mut tail = reader_ingest.stderr_tail.lock().expect("ingest stderr lock");
                            if tail.len() >= 200 {
                                tail.remove(0);
                            }
                            tail.push(line);
                        }
                    });
                }
                let child = Arc::new(Mutex::new(child));
                if let Ok(mut children) = this.children.lock() {
                    children.push(Arc::clone(&child));
                }
                this.listener_ready.store(false, Ordering::SeqCst);
                // Waiting for a log line would eat the listener's single accept,
                // so the wait is for the process to still be alive after a moment.
                tokio::time::sleep(Duration::from_millis(700)).await;
                let alive = matches!(child.lock().expect("ingest child lock").try_wait(), Ok(None));
                if !alive {
                    eprintln!("[ingest #{idx}] listener exited early");
                    continue;
                }
                this.listener_ready.store(true, Ordering::SeqCst);
                loop {
                    if this.stopping.load(Ordering::SeqCst) {
                        let _ = child.lock().expect("ingest child lock").start_kill();
                    }
                    // The guard must not span the sleep below.
                    let status = child.lock().expect("ingest child lock").try_wait();
                    match status {
                        Ok(Some(_)) => break,
                        Ok(None) => tokio::time::sleep(Duration::from_millis(100)).await,
                        Err(_) => break,
                    }
                }
                this.listener_ready.store(false, Ordering::SeqCst);
                let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
                if let Ok(mut received) = this.received.lock() {
                    received.push(ReceivedFile { path: file, size });
                }
                eprintln!("[ingest #{idx}] closed, {} KB", size / 1024);
                if this.stopping.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
                idx += 1;
            }
        });
    }

    /// Resolves once a listener is up again, so a session that follows a closed
    /// one does not race the listener and report a connection failure as its own.
    async fn wait_for_listener(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if self.listener_ready.load(Ordering::SeqCst) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    fn received_count(&self) -> usize {
        self.received.lock().map(|r| r.len()).unwrap_or(0)
    }

    fn received_from(&self, from: usize) -> Vec<ReceivedFile> {
        self.received.lock().map(|r| r.iter().skip(from).cloned().collect()).unwrap_or_default()
    }

    fn stderr_tail_lines(&self) -> Vec<String> {
        self.stderr_tail.lock().map(|t| t.clone()).unwrap_or_default()
    }
}

impl Drop for Ingest {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(children) = self.children.lock() {
            for child in children.iter() {
                if let Ok(mut child) = child.lock() {
                    let _ = child.start_kill();
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * Harness: engine wiring shared by every scenario
 * ------------------------------------------------------------------ */

struct Harness {
    ffmpeg: String,
    ffprobe: String,
    settings: Arc<Mutex<SessionSettings>>,
    media: Arc<Mutex<HashMap<String, MediaInfo>>>,
    statuses: Arc<Mutex<Vec<EngineStatus>>>,
    logs: Arc<Mutex<Vec<LogEntry>>>,
    playlist: Arc<Mutex<Vec<PlaylistItem>>>,
    ingest: Arc<Ingest>,
    clip_a: PathBuf,
    clip_b: PathBuf,
    info_a: MediaInfo,
    info_b: MediaInfo,
}

impl Harness {
    async fn new() -> Arc<Self> {
        let binaries = resolve_binaries("", "");
        assert!(!binaries.ffmpeg.is_empty(), "ffmpeg binary not found on PATH");
        assert!(!binaries.ffprobe.is_empty(), "ffprobe binary not found on PATH");
        let dir = fixture_dir();
        let clip_a = ensure_fixture(&binaries.ffmpeg, &dir, &CLIP_A);
        let clip_b = ensure_fixture(&binaries.ffmpeg, &dir, &CLIP_B);
        let info_a = probe_media(&binaries.ffprobe, &clip_a.to_string_lossy(), "en").await;
        let info_b = probe_media(&binaries.ffprobe, &clip_b.to_string_lossy(), "en").await;
        assert!(
            info_a.probe_error.is_none() && !info_a.video_streams.is_empty() && info_a.duration_sec > 10.0,
            "fixture probe failed for clip_a: {:?}",
            info_a.probe_error
        );
        assert!(
            info_b.probe_error.is_none() && !info_b.video_streams.is_empty() && info_b.duration_sec > 10.0,
            "fixture probe failed for clip_b: {:?}",
            info_b.probe_error
        );

        let port = free_port();
        let settings = Arc::new(Mutex::new(session_settings(
            format!("rtmp://127.0.0.1:{port}/live/"),
            false,
            2.0,
        )));

        let media_map: HashMap<String, MediaInfo> = [
            (clip_a.to_string_lossy().into_owned(), info_a.clone()),
            (clip_b.to_string_lossy().into_owned(), info_b.clone()),
        ]
        .into_iter()
        .collect();

        let ingest = Ingest::new(&binaries.ffmpeg, port, &dir);
        ingest.start();

        Arc::new(Self {
            ffmpeg: binaries.ffmpeg,
            ffprobe: binaries.ffprobe,
            settings,
            media: Arc::new(Mutex::new(media_map)),
            statuses: Arc::new(Mutex::new(vec![])),
            logs: Arc::new(Mutex::new(vec![])),
            playlist: Arc::new(Mutex::new(vec![])),
            ingest,
            clip_a,
            clip_b,
            info_a,
            info_b,
        })
    }

    /// Switches the playout the engine runs: `buffered` selects the two-process
    /// pipeline, `buffer_sec` only decides how deep its buffer is.
    fn set_mode(&self, buffered: bool, buffer_sec: f64) {
        let mut settings = self.settings.lock().expect("settings lock");
        settings.output.buffered = buffered;
        settings.output.buffer_sec = buffer_sec;
    }

    fn new_engine(self: &Arc<Self>) -> Arc<StreamEngine> {
        let ffmpeg = self.ffmpeg.clone();
        let settings = Arc::clone(&self.settings);
        let media = Arc::clone(&self.media);
        let ffprobe = self.ffprobe.clone();
        let statuses = Arc::clone(&self.statuses);
        let logs = Arc::clone(&self.logs);
        let playlist = Arc::clone(&self.playlist);

        let deps = EngineDeps {
            get_ffmpeg_path: Arc::new(move || ffmpeg.clone()),
            get_settings: Arc::new(move || settings.lock().expect("settings lock").clone()),
            get_media: Arc::new(move |path: &str| media.lock().expect("media lock").get(path).cloned()),
            probe_media: Arc::new(move |path: String| {
                let ffprobe = ffprobe.clone();
                Box::pin(async move { probe_media(&ffprobe, &path, "en").await })
                    as Pin<Box<dyn Future<Output = MediaInfo> + Send>>
            }),
            // The driver runs without the settings store, so it names the
            // language explicitly, exactly like the TS harness does.
            get_language: Arc::new(|| "en".to_string()),
        };
        let sink = EngineSink {
            status: Arc::new(move |status: EngineStatus| {
                let mut all = statuses.lock().expect("statuses lock");
                if all.len() < 50_000 {
                    all.push(status);
                }
            }),
            log: Arc::new(move |entry: LogEntry| {
                let mut all = logs.lock().expect("logs lock");
                if all.len() < 50_000 {
                    all.push(entry);
                }
            }),
            playlist: Arc::new(move |items: Vec<PlaylistItem>| {
                *playlist.lock().expect("playlist lock") = items;
            }),
        };
        StreamEngine::new(deps, sink)
    }

    fn log_len(&self) -> usize {
        self.logs.lock().map(|l| l.len()).unwrap_or(0)
    }

    fn error_logs_since(&self, from: usize) -> Vec<String> {
        self.logs
            .lock()
            .map(|logs| {
                logs.iter()
                    .skip(from)
                    .filter(|l| l.level == "error")
                    .map(|l| l.message.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// The settings the TS driver hands its engine, mirrored field for field,
/// except: subtitle mode `off` (the burn-in path is covered by the Node unit
/// suite), and a 200 kbps video target so the fixtures stay small.
fn session_settings(server: String, buffered: bool, buffer_sec: f64) -> SessionSettings {
    SessionSettings {
        video: VideoSettings {
            codec: "h264".into(),
            encoder: "auto".into(),
            rate_control: "cbr".into(),
            bitrate_kbps: 200.0,
            max_bitrate_kbps: 200.0,
            buffer_size_kbps: 400.0,
            crf: 23.0,
            preset: "ultrafast".into(),
            tune: "zerolatency".into(),
            profile: String::new(),
            keyframe_interval_sec: 2.0,
            b_frames: 0.0,
            scale: String::new(),
            scale_width: 0.0,
            scale_height: 0.0,
            scale_auto: false,
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
            mode: "off".into(),
            style_mode: "force".into(),
            font_name: "Microsoft YaHei".into(),
            font_size: 26.0,
            primary_color: "#FFFFFF".into(),
            outline_color: "#000000".into(),
            outline_width: 2.0,
            shadow: 0.0,
            margin_vertical: 24.0,
            alignment: 2.0,
            bold: false,
            italic: false,
        },
        output: OutputSettings {
            server,
            stream_key: "test".into(),
            protocol: "rtmp".into(),
            network: "tcp".into(),
            container: "flv".into(),
            extra_output_args: String::new(),
            // `-re` on the encoder input is what makes the single-process
            // pipeline air at 1x, which is what makes the viewer-timeline
            // samples deterministic.
            realtime_pacing: true,
            obs_web_socket: ObsWebSocketSettings {
                enabled: false,
                host: "127.0.0.1".into(),
                port: 4455.0,
                password: String::new(),
            },
            buffered,
            buffer_sec,
            loop_playlist: false,
            reconnect_delay_sec: 2.0,
            max_reconnect_attempts: 2.0,
            drop_late_frames: false,
        },
    }
}

fn mk_item(id: &str, path: &Path, info: &MediaInfo) -> PlaylistItem {
    PlaylistItem {
        id: id.to_string(),
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.to_string()),
        size: info.size,
        duration_sec: info.duration_sec,
        subtitle_tracks: vec![],
        selected_subtitle_id: None,
        mode: "off".into(),
        sync_offset_sec: 0.0,
        subtitle_delay_sec: 0.0,
        status: "pending".into(),
        error: None,
        broken: None,
    }
}

/* ------------------------------------------------------------------ *
 * Checks, waits, samples
 * ------------------------------------------------------------------ */

struct Checks {
    items: Vec<(&'static str, bool, String)>,
}

impl Checks {
    fn new() -> Self {
        Self { items: vec![] }
    }

    fn check(&mut self, name: &'static str, ok: bool, detail: String) {
        println!("  [{}] {} — {}", if ok { "PASS" } else { "FAIL" }, name, detail);
        self.items.push((name, ok, detail));
    }

    fn finish(self) -> Result<(), String> {
        let failed: Vec<String> = self
            .items
            .iter()
            .filter(|(_, ok, _)| !ok)
            .map(|(name, _, detail)| format!("    {} — {}", name, detail))
            .collect();
        if failed.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "{} of {} checks failed:\n{}",
                failed.len(),
                self.items.len(),
                failed.join("\n")
            ))
        }
    }
}

#[derive(Clone, Debug)]
struct Sample {
    state: String,
    current_index: i64,
    completed_sec: f64,
    position_sec: f64,
    current_duration_sec: f64,
    encoded_sec: Option<f64>,
    buffered: Option<bool>,
    reconnect_count: u32,
}

impl Sample {
    fn of(status: &EngineStatus) -> Self {
        Self {
            state: status.state.clone(),
            current_index: status.current_index,
            completed_sec: status.completed_sec,
            position_sec: status.position_sec,
            current_duration_sec: status.current_duration_sec,
            encoded_sec: status.encoded_sec,
            buffered: status.buffered,
            reconnect_count: status.reconnect_count,
        }
    }
}

fn viewer_state(state: &str) -> bool {
    // The checks about the viewer's timeline apply to a run the user never
    // interrupted, exactly like the TS driver limits them to phase 1.
    state == "live" || state == "draining"
}

/// Polls `get_status` until `pred` holds. Every wait is hard-bounded and the
/// timeout carries a diagnostic dump so CI failures are debuggable.
async fn wait_for(
    h: &Harness,
    engine: &Arc<StreamEngine>,
    timeout: Duration,
    label: &str,
    pred: impl Fn(&EngineStatus) -> bool,
) -> Result<EngineStatus, String> {
    let start = Instant::now();
    loop {
        let status = engine.get_status();
        if pred(&status) {
            return Ok(status);
        }
        if start.elapsed() >= timeout {
            return Err(format!("timeout: {label} not reached within {timeout:?}\n{}", dump(h, Some(engine))));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Samples the status stream every 250 ms until the session is over. The
/// samples are what the viewer-timeline regressions are asserted against.
async fn run_to_idle(
    h: &Harness,
    engine: &Arc<StreamEngine>,
    samples: &mut Vec<Sample>,
    timeout: Duration,
    label: &str,
) -> Result<EngineStatus, String> {
    let start = Instant::now();
    loop {
        let status = engine.get_status();
        samples.push(Sample::of(&status));
        if !engine.is_active() {
            return Ok(status);
        }
        if start.elapsed() >= timeout {
            return Err(format!("timeout: {label} not reached within {timeout:?}\n{}", dump(h, Some(engine))));
        }
        tokio::time::sleep(POLL).await;
    }
}

fn dump(h: &Harness, engine: Option<&StreamEngine>) -> String {
    let mut out = String::new();
    let logs = h.logs.lock().expect("logs lock");
    out.push_str("--- engine log tail (last 30) ---\n");
    let start = logs.len().saturating_sub(30);
    for line in &logs[start..] {
        out.push_str(&format!("{:5} {:7} {}\n", line.id, line.level, line.message));
    }
    drop(logs);
    if let Some(engine) = engine {
        let status = engine.get_status();
        out.push_str("--- last status ---\n");
        out.push_str(&serde_json::to_string_pretty(&status).unwrap_or_else(|_| "?".into()));
        out.push('\n');
    }
    let statuses = h.statuses.lock().expect("statuses lock");
    if let Some(last) = statuses.last() {
        out.push_str("--- last sink status ---\n");
        out.push_str(&serde_json::to_string(last).unwrap_or_else(|_| "?".into()));
        out.push('\n');
    }
    drop(statuses);
    out.push_str("--- ingest stderr tail ---\n");
    for line in h.ingest.stderr_tail_lines().iter().rev().take(12).rev() {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Bounded wrapper for the engine's control methods: a launch that never
/// returns must fail the scenario with a dump, not wedge the whole test.
async fn control_step(
    h: &Harness,
    engine: &Arc<StreamEngine>,
    label: &str,
    fut: impl Future<Output = EngineStatus>,
) -> Result<EngineStatus, String> {
    match tokio::time::timeout(CONTROL_WAIT, fut).await {
        Ok(status) => Ok(status),
        Err(_) => Err(format!("timeout: engine.{label} did not return within {CONTROL_WAIT:?}\n{}", dump(h, Some(engine)))),
    }
}

/// Best-effort teardown used on every exit path of a scenario. Bounded too: a
/// stop that never returns must not hang the test on the way out.
async fn stop_engine_bounded(engine: &Arc<StreamEngine>) {
    let _ = tokio::time::timeout(CONTROL_WAIT, engine.stop()).await;
}

/// Force-exits the process if a scenario wedges so hard that neither the
/// awaits nor the runtime shutdown can make progress (a task parked on a
/// poisoned lock, say). Cancelled by the test when it finishes normally; a
/// panicking test leaves it armed, which is exactly when it is needed.
fn spawn_watchdog(label: &'static str) -> Arc<AtomicBool> {
    let done = Arc::new(AtomicBool::new(false));
    let done_thread = Arc::clone(&done);
    std::thread::spawn(move || {
        for _ in 0..WATCHDOG_SECS {
            if done_thread.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        eprintln!("engine integration watchdog: '{label}' made no progress for {WATCHDOG_SECS}s, force-exiting");
        std::process::exit(101);
    });
    done
}

/* ------------------------------------------------------------------ *
 * Received-session analysis
 * ------------------------------------------------------------------ */

struct SessionInfo {
    size: u64,
    last_video_ts_sec: Option<f64>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
}

/// Last video timestamp in an FLV file, read from the tag list itself. The
/// ingest writes FLV through a pipe, so the muxer's header guess is worthless;
/// the tag timestamps are the authority on how much actually aired.
fn flv_last_video_ts_sec(path: &Path) -> Option<f64> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 13 || &data[0..3] != b"FLV" {
        return None;
    }
    // Layout: 9-byte header (bytes 5..9 hold DataOffset, whose value IS the
    // header size), then the 4-byte PreviousTagSize0, then the first tag — so
    // the walk starts at DataOffset + 4 (13 for ffmpeg's muxer).
    let data_offset = u32::from_be_bytes([data[5], data[6], data[7], data[8]]) as usize;
    let size = data.len();
    let mut offset = data_offset + 4;
    let mut last: Option<u32> = None;
    while offset + 15 <= size {
        let tag = &data[offset..offset + 11];
        let tag_type = tag[0];
        let timestamp = u32::from_be_bytes([0, tag[4], tag[5], tag[6]]) | ((tag[7] as u32) << 24);
        let data_size = u32::from_be_bytes([0, tag[1], tag[2], tag[3]]) as usize;
        if tag_type == 9 {
            last = Some(timestamp);
        }
        offset += 11 + data_size + 4;
    }
    last.map(|ts| ts as f64 / 1000.0)
}

/// Stream-level probe of one received session: video and audio codec names.
fn probe_received_streams(ffprobe: &str, path: &Path) -> (Option<String>, Option<String>) {
    let Ok(output) = std::process::Command::new(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_streams"])
        .arg(path)
        .output()
    else {
        return (None, None);
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return (None, None);
    };
    let mut video = None;
    let mut audio = None;
    if let Some(streams) = json.get("streams").and_then(|v| v.as_array()) {
        for stream in streams {
            match stream.get("codec_type").and_then(|t| t.as_str()) {
                Some("video") if video.is_none() => {
                    video = stream.get("codec_name").and_then(|c| c.as_str()).map(String::from)
                }
                Some("audio") if audio.is_none() => {
                    audio = stream.get("codec_name").and_then(|c| c.as_str()).map(String::from)
                }
                _ => {}
            }
        }
    }
    (video, audio)
}

/// Takes the sessions the scenario's listeners recorded, gives the data-carrying
/// ones a stream probe and a last-timestamp read.
async fn analyze_received(h: &Harness, from: usize) -> Vec<SessionInfo> {
    let files = h.ingest.received_from(from);
    let mut out = Vec::new();
    for file in files {
        let mut info = SessionInfo {
            size: file.size,
            last_video_ts_sec: None,
            video_codec: None,
            audio_codec: None,
        };
        if file.size > DATA_FLOOR_BYTES && file.path.is_file() {
            info.last_video_ts_sec = flv_last_video_ts_sec(&file.path);
            let (video, audio) = probe_received_streams(&h.ffprobe, &file.path);
            info.video_codec = video;
            info.audio_codec = audio;
        }
        out.push(info);
    }
    out
}

/// The checks every full run shares: viewer-timeline regressions asserted over
/// the samples of an uninterrupted run.
fn check_viewer_timeline(checks: &mut Checks, samples: &[Sample], durations: &[f64]) {
    let progress_samples = samples.iter().filter(|s| s.position_sec > 0.0).count();
    checks.check(
        "status stream produced progress updates",
        progress_samples > 10,
        format!("{progress_samples} samples"),
    );

    let mut last_by_index: HashMap<i64, f64> = HashMap::new();
    let mut backwards: Vec<String> = vec![];
    for sample in samples {
        if sample.current_index < 0 {
            continue;
        }
        if let Some(prev) = last_by_index.get(&sample.current_index) {
            if sample.position_sec + 0.01 < *prev && sample.position_sec > 1.0 {
                backwards.push(format!("index {}: {prev:.2} -> {:.2}", sample.current_index, sample.position_sec));
            }
        }
        last_by_index.insert(sample.current_index, sample.position_sec);
    }
    checks.check(
        "reported position never went backwards within a file",
        backwards.is_empty(),
        if backwards.is_empty() {
            format!("checked {} samples", samples.len())
        } else {
            backwards.join(", ")
        },
    );

    let mut viewer_backwards: Vec<String> = vec![];
    for pair in samples.windows(2) {
        let (prev, cur) = (&pair[0], &pair[1]);
        if viewer_state(&prev.state) && viewer_state(&cur.state) && cur.completed_sec < prev.completed_sec - 0.05 {
            viewer_backwards.push(format!("{:.2} -> {:.2}", prev.completed_sec, cur.completed_sec));
        }
    }
    checks.check(
        "the viewer timeline never moves backwards during a file change",
        viewer_backwards.is_empty(),
        if viewer_backwards.is_empty() {
            format!("checked {} live samples", samples.len())
        } else {
            format!("backward at {}", viewer_backwards.join(", "))
        },
    );

    // A change of currentIndex may only follow a published position that
    // actually finished the entries before it.
    let mut unearned: Vec<String> = vec![];
    for pair in samples.windows(2) {
        let (prev, cur) = (&pair[0], &pair[1]);
        if cur.current_index <= prev.current_index || cur.current_index <= 0 {
            continue;
        }
        let idx = cur.current_index as usize;
        if idx > durations.len() {
            continue;
        }
        let boundary: f64 = durations[..idx].iter().sum();
        if prev.completed_sec < boundary - 1.5 {
            unearned.push(format!(
                "entry {} shown while the published total was only {:.2}s of {:.2}s",
                cur.current_index, prev.completed_sec, boundary
            ));
        }
    }
    let saw_second_entry = samples.iter().any(|s| s.current_index == 1);
    checks.check(
        "the entry shown is only advanced by the published position",
        unearned.is_empty() && saw_second_entry,
        if unearned.is_empty() {
            format!("every entry change waited for the published total (checked {} samples)", samples.len())
        } else {
            unearned.join(", ")
        },
    );

    // The bar is derived: completed == sum(before) + position, position within
    // the current file. Any other writer of these fields breaks this.
    let mut inconsistent: Vec<String> = vec![];
    for sample in samples {
        if sample.current_index < 0 {
            if sample.completed_sec != 0.0 || sample.position_sec != 0.0 {
                inconsistent.push(format!("idle sample with completed={:.2} position={:.2}", sample.completed_sec, sample.position_sec));
            }
            continue;
        }
        let idx = sample.current_index as usize;
        if idx > durations.len() {
            continue;
        }
        let before: f64 = durations[..idx].iter().sum();
        if (sample.completed_sec - (before + sample.position_sec)).abs() > 0.05 {
            inconsistent.push(format!(
                "index {} completed={:.2} but sumBefore+position={:.2}",
                sample.current_index,
                sample.completed_sec,
                before + sample.position_sec
            ));
        }
        if sample.position_sec > sample.current_duration_sec + 0.05 {
            inconsistent.push(format!(
                "index {} position={:.2} exceeds duration={:.2}",
                sample.current_index, sample.position_sec, sample.current_duration_sec
            ));
        }
    }
    checks.check(
        "position and session total stay consistent while live",
        inconsistent.is_empty(),
        if inconsistent.is_empty() {
            format!("checked {} samples", samples.len())
        } else {
            inconsistent.join(", ")
        },
    );
}

/// Shared tail checks for a finished run: per-entry statuses, the zeroed
/// timeline, ingest content, error logs.
fn check_session_end(
    checks: &mut Checks,
    final_status: &EngineStatus,
    item_ids: [&str; 2],
    expected: [&str; 2],
) {
    checks.check(
        "engine returned to idle at the end of the playlist",
        final_status.state == "idle",
        format!("state={}", final_status.state),
    );
    let status_a = final_status.item_status.get(item_ids[0]).map(String::as_str).unwrap_or("(missing)");
    let status_b = final_status.item_status.get(item_ids[1]).map(String::as_str).unwrap_or("(missing)");
    checks.check(
        "entry statuses match the outcome of the run",
        status_a == expected[0] && status_b == expected[1],
        format!(
            "itemStatus={{ {}: {status_a}, {}: {status_b} }} (expected {{ {}: {}, {}: {} }})",
            item_ids[0], item_ids[1], item_ids[0], expected[0], item_ids[1], expected[1]
        ),
    );
    // The entries are the record of what aired and stay `done`; the position is
    // not kept. This is the resetViewerTimeline regression.
    checks.check(
        "the session total is not left on the status line after the run",
        final_status.completed_sec == 0.0
            && final_status.position_sec == 0.0
            && final_status.current_duration_sec == 0.0
            && final_status.current_index == -1,
        format!(
            "completed={:.2}s position={:.2}s duration={:.2}s index={}",
            final_status.completed_sec, final_status.position_sec, final_status.current_duration_sec, final_status.current_index
        ),
    );
}

fn check_no_error_logs(checks: &mut Checks, h: &Harness, logs_before: usize) {
    let errors = h.error_logs_since(logs_before);
    checks.check(
        "no error-level log entries",
        errors.is_empty(),
        if errors.is_empty() {
            "none".into()
        } else {
            errors.join(" | ").chars().take(400).collect()
        },
    );
}

/* ------------------------------------------------------------------ *
 * Scenario 1 + 2: plain full run, sampled while live
 * ------------------------------------------------------------------ */

async fn scenario_plain_full_run(h: &Arc<Harness>) -> Result<(), String> {
    println!("=== scenario: plain full run (single-process pipeline) ===");
    let engine = h.new_engine();
    let result = plain_full_run_body(h, &engine).await;
    if result.is_err() || engine.is_active() {
        stop_engine_bounded(&engine).await;
    }
    result
}

async fn plain_full_run_body(h: &Arc<Harness>, engine: &Arc<StreamEngine>) -> Result<(), String> {
    let mut checks = Checks::new();
    let logs_before = h.log_len();
    let received_from = h.ingest.received_count();
    let dur_a = h.info_a.duration_sec;
    let dur_b = h.info_b.duration_sec;

    h.set_mode(false, 2.0);
    engine.set_playlist(vec![
        mk_item("plain-a", &h.clip_a, &h.info_a),
        mk_item("plain-b", &h.clip_b, &h.info_b),
    ]);
    if !h.ingest.wait_for_listener(LISTEN_WAIT).await {
        return Err(format!("no ingest listener became ready\n{}", dump(h, Some(engine))));
    }
    control_step(h, engine, "start()", engine.start(None)).await?;

    let mut samples = Vec::new();
    let final_status = run_to_idle(h, engine, &mut samples, RUN_TIMEOUT, "plain run to idle").await?;
    // Let the last listener flush and exit before reading its recording.
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let saw_live = samples.iter().any(|s| s.state == "live");
    checks.check("engine reached the live state", saw_live, format!("states sampled: {}", samples.len()));

    let sessions = analyze_received(h, received_from).await;
    let data: Vec<&SessionInfo> = sessions.iter().filter(|s| s.size > DATA_FLOOR_BYTES).collect();

    // Each playlist entry is its own publish session in this pipeline.
    checks.check(
        "each playlist entry opened its own publish session",
        data.len() >= 2,
        format!(
            "{} sessions with data, sizes={}",
            data.len(),
            sessions.iter().map(|s| format!("{}KB", s.size / 1024)).collect::<Vec<_>>().join(",")
        ),
    );
    let decodable = !data.is_empty()
        && data
            .iter()
            .all(|s| s.video_codec.as_deref() == Some("h264") && s.audio_codec.as_deref() == Some("aac"));
    checks.check(
        "received sessions are decodable video",
        decodable,
        data.iter()
            .map(|s| format!(
                "{}/{}",
                s.video_codec.as_deref().unwrap_or("?"),
                s.audio_codec.as_deref().unwrap_or("?")
            ))
            .collect::<Vec<_>>()
            .join(" | "),
    );
    let covered_a = data.iter().any(|s| s.last_video_ts_sec.unwrap_or(0.0) >= dur_a - AIRTIME_TOLERANCE_SEC);
    let covered_b = data.iter().any(|s| s.last_video_ts_sec.unwrap_or(0.0) >= dur_b - AIRTIME_TOLERANCE_SEC);
    checks.check(
        "each entry aired in full inside its own session",
        covered_a && covered_b,
        format!(
            "durations {dur_a:.1}s/{dur_b:.1}s, last video timestamps {}",
            data.iter().map(|s| format!("{:.1}s", s.last_video_ts_sec.unwrap_or(0.0))).collect::<Vec<_>>().join(",")
        ),
    );
    let total_received: u64 = sessions.iter().map(|s| s.size).sum();
    checks.check(
        "ingest server received the stream",
        total_received > 200_000,
        format!("{} KB total", total_received / 1024),
    );

    check_viewer_timeline(&mut checks, &samples, &[dur_a, dur_b]);

    // In this pipeline there is no buffer, so there is no lead to report.
    let max_lead = samples
        .iter()
        .map(|s| s.encoded_sec.unwrap_or(s.completed_sec) - s.completed_sec)
        .fold(0.0_f64, f64::max);
    checks.check("single-process pipeline reports no buffer lead", max_lead < 0.5, format!("max lead {max_lead:.2}s"));

    check_session_end(&mut checks, &final_status, ["plain-a", "plain-b"], ["done", "done"]);

    // The queue is replaced the way the UI's clear button + add does it: a
    // fresh queue must read as unstarted, not carry the previous session's
    // progress (the other half of the resetViewerTimeline regression).
    engine.set_playlist(vec![]);
    engine.set_playlist(vec![mk_item("plain-e", &h.clip_b, &h.info_b)]);
    let fresh = engine.get_status();
    checks.check(
        "a queue added after a session reads as unstarted",
        fresh.completed_sec == 0.0 && fresh.position_sec == 0.0 && fresh.current_index == -1,
        format!(
            "completed={:.2}s position={:.2}s index={}",
            fresh.completed_sec, fresh.position_sec, fresh.current_index
        ),
    );

    // The renderer re-keys every log row; colliding ids would make rows
    // disappear, so the engine's own ids must not collide.
    let ids: Vec<u64> = h.logs.lock().expect("logs lock").iter().skip(logs_before).map(|l| l.id).collect();
    let duplicates = ids.len() - ids.iter().collect::<HashSet<_>>().len();
    checks.check("this engine run emitted unique log ids", duplicates == 0, format!("{} entries, {duplicates} duplicate(s)", ids.len()));

    check_no_error_logs(&mut checks, h, logs_before);
    checks.finish()
}

/* ------------------------------------------------------------------ *
 * Scenario 3: buffered full run
 * ------------------------------------------------------------------ */

async fn scenario_buffered_full_run(h: &Arc<Harness>) -> Result<(), String> {
    println!("=== scenario: buffered full run (two-process pipeline, 12s lead) ===");
    let engine = h.new_engine();
    let result = buffered_full_run_body(h, &engine).await;
    if result.is_err() || engine.is_active() {
        stop_engine_bounded(&engine).await;
    }
    result
}

async fn buffered_full_run_body(h: &Arc<Harness>, engine: &Arc<StreamEngine>) -> Result<(), String> {
    let mut checks = Checks::new();
    let logs_before = h.log_len();
    let received_from = h.ingest.received_count();
    let dur_a = h.info_a.duration_sec;
    let dur_b = h.info_b.duration_sec;

    h.set_mode(true, 12.0);
    engine.set_playlist(vec![
        mk_item("buffered-a", &h.clip_a, &h.info_a),
        mk_item("buffered-b", &h.clip_b, &h.info_b),
    ]);
    if !h.ingest.wait_for_listener(LISTEN_WAIT).await {
        return Err(format!("no ingest listener became ready\n{}", dump(h, Some(engine))));
    }
    control_step(h, engine, "start()", engine.start(None)).await?;

    let mut samples = Vec::new();
    let final_status = run_to_idle(h, engine, &mut samples, RUN_TIMEOUT, "buffered run to idle").await?;
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let saw_live = samples.iter().any(|s| s.state == "live");
    checks.check("engine reached the live state", saw_live, format!("states sampled: {}", samples.len()));
    let saw_buffered = samples.iter().any(|s| s.buffered == Some(true));
    checks.check(
        "the status stream reported the buffered playout",
        saw_buffered,
        format!("buffered flag seen: {saw_buffered}"),
    );

    let sessions = analyze_received(h, received_from).await;
    let data: Vec<&SessionInfo> = sessions.iter().filter(|s| s.size > DATA_FLOOR_BYTES).collect();

    // ONE publish session is supposed to carry the WHOLE playlist while the
    // encoder restarts behind it — that is the point of the two-process design.
    checks.check(
        "the buffered playout published the playlist over a single RTMP session",
        data.len() >= 1,
        format!(
            "{} sessions with data, sizes={}",
            data.len(),
            sessions.iter().map(|s| format!("{}KB", s.size / 1024)).collect::<Vec<_>>().join(",")
        ),
    );
    let decodable = !data.is_empty()
        && data
            .iter()
            .all(|s| s.video_codec.as_deref() == Some("h264") && s.audio_codec.as_deref() == Some("aac"));
    checks.check(
        "received sessions are decodable video",
        decodable,
        data.iter()
            .map(|s| format!(
                "{}/{}",
                s.video_codec.as_deref().unwrap_or("?"),
                s.audio_codec.as_deref().unwrap_or("?")
            ))
            .collect::<Vec<_>>()
            .join(" | "),
    );
    let max_aired = data.iter().map(|s| s.last_video_ts_sec.unwrap_or(0.0)).fold(0.0_f64, f64::max);
    checks.check(
        "the session aired the whole playlist, not just the first file",
        max_aired >= dur_a + dur_b - AIRTIME_TOLERANCE_SEC - 1.0,
        format!("last video timestamp {max_aired:.1}s vs {:.1}s", dur_a + dur_b),
    );
    let total_received: u64 = sessions.iter().map(|s| s.size).sum();
    checks.check(
        "ingest server received the stream",
        total_received > 200_000,
        format!("{} KB total", total_received / 1024),
    );

    check_viewer_timeline(&mut checks, &samples, &[dur_a, dur_b]);

    // The encoder really did run ahead, so the timeline checks above had a gap
    // to catch rather than an absent one.
    let max_lead = samples
        .iter()
        .map(|s| s.encoded_sec.unwrap_or(s.completed_sec) - s.completed_sec)
        .fold(0.0_f64, f64::max);
    checks.check("the encoder really did lead the publisher", max_lead > 2.0, format!("max lead {max_lead:.2}s"));

    check_session_end(&mut checks, &final_status, ["buffered-a", "buffered-b"], ["done", "done"]);
    check_no_error_logs(&mut checks, h, logs_before);
    checks.finish()
}

/* ------------------------------------------------------------------ *
 * Scenario 4: stop mid-run
 * ------------------------------------------------------------------ */

async fn scenario_stop_mid_run(h: &Arc<Harness>) -> Result<(), String> {
    println!("=== scenario: stop mid-run ===");
    let engine = h.new_engine();
    let result = stop_mid_run_body(h, &engine).await;
    if result.is_err() || engine.is_active() {
        stop_engine_bounded(&engine).await;
    }
    result
}

async fn stop_mid_run_body(h: &Arc<Harness>, engine: &Arc<StreamEngine>) -> Result<(), String> {
    let mut checks = Checks::new();
    let logs_before = h.log_len();
    let received_from = h.ingest.received_count();
    let dur_a = h.info_a.duration_sec;

    h.set_mode(false, 2.0);
    engine.set_playlist(vec![
        mk_item("stop-a", &h.clip_a, &h.info_a),
        mk_item("stop-b", &h.clip_b, &h.info_b),
    ]);
    if !h.ingest.wait_for_listener(LISTEN_WAIT).await {
        return Err(format!("no ingest listener became ready\n{}", dump(h, Some(engine))));
    }
    control_step(h, engine, "start()", engine.start(None)).await?;

    // The other way a session ends: the user stops it mid-file.
    let mid = wait_for(h, engine, PHASE_WAIT, "the first seconds of the session", |st| st.position_sec > 1.0).await?;
    checks.check(
        "the stop landed mid-file with progress visible",
        mid.completed_sec > 1.0 && mid.completed_sec < dur_a - AIRTIME_TOLERANCE_SEC,
        format!("stopped at {:.2}s of a {:.1}s first entry", mid.completed_sec, dur_a),
    );

    control_step(h, engine, "stop()", engine.stop()).await?;
    let after = engine.get_status();

    check_session_end(&mut checks, &after, ["stop-a", "stop-b"], ["pending", "pending"]);

    tokio::time::sleep(Duration::from_millis(1200)).await;
    let sessions = analyze_received(h, received_from).await;
    let partial: Vec<&SessionInfo> = sessions.iter().filter(|s| s.size > DATA_FLOOR_BYTES).collect();
    let partial_ok = partial
        .iter()
        .any(|s| s.video_codec.as_deref() == Some("h264") && s.last_video_ts_sec.unwrap_or(0.0) > 0.5);
    checks.check(
        "the stopped session left real received bytes",
        partial_ok,
        format!(
            "{} sessions with data, last timestamps {}",
            partial.len(),
            partial.iter().map(|s| format!("{:.1}s", s.last_video_ts_sec.unwrap_or(0.0))).collect::<Vec<_>>().join(",")
        ),
    );

    check_no_error_logs(&mut checks, h, logs_before);
    checks.finish()
}

/* ------------------------------------------------------------------ *
 * Scenario 5: skip while live (buffered: skip restarts the session)
 * ------------------------------------------------------------------ */

async fn scenario_skip_while_live(h: &Arc<Harness>) -> Result<(), String> {
    println!("=== scenario: skip while live (buffered) ===");
    let engine = h.new_engine();
    let result = skip_while_live_body(h, &engine).await;
    if result.is_err() || engine.is_active() {
        stop_engine_bounded(&engine).await;
    }
    result
}

async fn skip_while_live_body(h: &Arc<Harness>, engine: &Arc<StreamEngine>) -> Result<(), String> {
    let mut checks = Checks::new();
    let logs_before = h.log_len();
    let received_from = h.ingest.received_count();
    let dur_b = h.info_b.duration_sec;

    h.set_mode(true, 12.0);
    engine.set_playlist(vec![
        mk_item("skip-a", &h.clip_a, &h.info_a),
        mk_item("skip-b", &h.clip_b, &h.info_b),
    ]);
    if !h.ingest.wait_for_listener(LISTEN_WAIT).await {
        return Err(format!("no ingest listener became ready\n{}", dump(h, Some(engine))));
    }
    control_step(h, engine, "start()", engine.start(None)).await?;

    // Skip once the viewer is genuinely into the first entry — in buffered
    // mode the position only moves with the published stream, so this is
    // deterministic.
    wait_for(h, engine, PHASE_WAIT, "the viewer two seconds into the first entry", |st| {
        st.position_sec > 2.0 && st.current_index == 0
    })
    .await?;

    control_step(h, engine, "skip_next()", engine.skip_next(None)).await?;

    wait_for(h, engine, PHASE_WAIT, "reaching the second entry after the skip", |st| st.current_index == 1).await?;
    println!("  skip delivered, viewer moved to the second entry");

    let mut samples = Vec::new();
    let final_status = run_to_idle(h, engine, &mut samples, RUN_TIMEOUT, "skip run to idle").await?;
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // A jump discards the buffer and reopens the publish session; that must
    // not read as a lost stream (no reconnect), or the skip would stall.
    let reconnects = samples.iter().map(|s| s.reconnect_count).max().unwrap_or(0);
    checks.check(
        "the skip restarted the session without dropping it",
        reconnects == 0,
        format!("reconnect count {reconnects}"),
    );

    let status_a = final_status.item_status.get("skip-a").map(String::as_str).unwrap_or("(missing)");
    let status_b = final_status.item_status.get("skip-b").map(String::as_str).unwrap_or("(missing)");
    // The abandoned entry must not be live/pending — that would mean the queue
    // stopped tracking it — and the target must have finished.
    checks.check(
        "the skip left the first entry behind and finished the target",
        status_a == "skipped" && status_b == "done",
        format!("itemStatus={{ skip-a: {status_a}, skip-b: {status_b} }}"),
    );
    check_session_end(&mut checks, &final_status, ["skip-a", "skip-b"], ["skipped", "done"]);

    let sessions = analyze_received(h, received_from).await;
    let data: Vec<&SessionInfo> = sessions.iter().filter(|s| s.size > DATA_FLOOR_BYTES).collect();
    let last_aired = data.last().map(|s| s.last_video_ts_sec.unwrap_or(0.0)).unwrap_or(0.0);
    checks.check(
        "the post-skip session aired the target in full",
        last_aired >= dur_b - AIRTIME_TOLERANCE_SEC,
        format!(
            "target is {dur_b:.1}s, last data session aired {last_aired:.1}s over {} data session(s)",
            data.len()
        ),
    );
    let total_received: u64 = sessions.iter().map(|s| s.size).sum();
    checks.check(
        "ingest server received the stream",
        total_received > 100_000,
        format!("{} KB total", total_received / 1024),
    );

    check_no_error_logs(&mut checks, h, logs_before);
    checks.finish()
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plain_pipeline_full_run_and_viewer_timeline() {
    let watchdog = spawn_watchdog("plain full run");
    let h = Harness::new().await;
    match scenario_plain_full_run(&h).await {
        Ok(()) => println!("scenario plain full run: all checks passed"),
        Err(err) => panic!("plain full run failed:\n{err}"),
    }
    watchdog.store(true, Ordering::SeqCst);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn buffered_pipeline_full_run() {
    let watchdog = spawn_watchdog("buffered full run");
    let h = Harness::new().await;
    match scenario_buffered_full_run(&h).await {
        Ok(()) => println!("scenario buffered full run: all checks passed"),
        Err(err) => panic!("buffered full run failed:\n{err}"),
    }
    watchdog.store(true, Ordering::SeqCst);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_mid_run_resets_status() {
    let watchdog = spawn_watchdog("stop mid-run");
    let h = Harness::new().await;
    match scenario_stop_mid_run(&h).await {
        Ok(()) => println!("scenario stop mid-run: all checks passed"),
        Err(err) => panic!("stop mid-run failed:\n{err}"),
    }
    watchdog.store(true, Ordering::SeqCst);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn skip_while_live_restarts_session() {
    let watchdog = spawn_watchdog("skip while live");
    let h = Harness::new().await;
    match scenario_skip_while_live(&h).await {
        Ok(()) => println!("scenario skip while live: all checks passed"),
        Err(err) => panic!("skip while live failed:\n{err}"),
    }
    watchdog.store(true, Ordering::SeqCst);
}
