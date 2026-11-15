//! The streaming engine: a session state machine over ffmpeg. Port of
//! `src/main/stream/engine.ts`.
//!
//! Concurrency model: the TypeScript class relied on the JS event loop for
//! serialised access; here the same fields live behind one `Mutex<EngineCore>`
//! held in short critical sections (never across an await, and never while a
//! log/status callback runs — those re-lock), and every await point keeps the
//! generation guards the original used, so a stop that arrives mid-launch
//! invalidates that launch exactly like it did there.

use crate::ffmpeg::command::{
    build_encoder_args, build_stream_command, describe_streams, split_output_args, BuildRequest,
};
use crate::shared::defaults::BUFFER_SEC_MIN;
use crate::shared::i18n;
use crate::shared::protocol::{
    address_matches_protocol, build_push_target, container_for_protocol, muxer_for_protocol,
    network_for_protocol, protocol_key_args, protocol_schemes, DEFAULT_STREAM_PROTOCOL,
};
use crate::shared::types::{
    EncoderLiveStats, EngineStatus, LogEntry, MediaInfo, PlaylistItem, SessionSettings,
};
use crate::stream::byte_rate::{now_ms, ByteRateMeter};
use crate::stream::playout::{EncoderPass, Playout, PlayoutCallbacks, PlayoutEvent};
use crate::stream::supervisor::{spawn_supervised, Supervisor};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// How close to the end of a file counts as "finished normally".
const COMPLETION_TOLERANCE_SEC: f64 = 1.5;
/// How far the pusher may lag the encoder's hand-off point and still count as
/// "everything has aired".
const DRAIN_TOLERANCE_SEC: f64 = 0.5;
/// Backstop for the drain wait: content, not a stuck process, decides the end.
const DRAIN_MAX_SEC: f64 = 300.0;
const DRAIN_STALL_MS: f64 = 45_000.0;
/// Gap left between what the pusher has published and where the next pass
/// starts: larger than a frame, smaller than anything a viewer would notice.
const PASS_START_MARGIN_SEC: f64 = 0.25;
/// Delay before the next encoder pass is spawned, in buffered mode. Not a
/// pause between files: it only keeps the next pass from being spawned inside
/// the previous pass's own exit handler.
const NEXT_PASS_DELAY_MS: u64 = 150;
/// Pause before the next file in the single-process pipeline: that pipeline
/// closes and reopens the publish session for every file, so the server has to
/// release the stream key first (the old user setting's default).
const REPUBLISH_DELAY_MS: u64 = 1000;
/// Where the send-rate readout stops being reassuring (fixed on purpose; see
/// the TS original for the measured thresholds).
const NETWORK_WARN_RATIO: f64 = 0.85;
const NETWORK_BAD_RATIO: f64 = 0.6;
const NETWORK_WARN_RATIO_ESTIMATED: f64 = 0.5;
const NETWORK_BAD_RATIO_ESTIMATED: f64 = 0.3;
/// How long a link must hold a better reading before the colour clears.
const NETWORK_RECOVER_MS: f64 = 3000.0;

/// The engine's dependencies on the running application (injected so the
/// engine, like the original, stays testable without the settings stores).
#[derive(Clone)]
pub struct EngineDeps {
    pub get_ffmpeg_path: Arc<dyn Fn() -> String + Send + Sync>,
    pub get_settings: Arc<dyn Fn() -> SessionSettings + Send + Sync>,
    /// Probe results are provided by the caller so the engine stays I/O free.
    pub get_media: Arc<dyn Fn(&str) -> Option<MediaInfo> + Send + Sync>,
    pub probe_media: Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = MediaInfo> + Send>> + Send + Sync>,
    /// The language the log is written in, read per use so a switch applies to
    /// the next line rather than at the next session.
    pub get_language: Arc<dyn Fn() -> String + Send + Sync>,
}

#[derive(Clone)]
pub struct EngineSink {
    pub status: Arc<dyn Fn(EngineStatus) + Send + Sync>,
    pub log: Arc<dyn Fn(LogEntry) + Send + Sync>,
    pub playlist: Arc<dyn Fn(Vec<PlaylistItem>) + Send + Sync>,
}

#[derive(Debug, Clone)]
pub struct PassInfo {
    pub index: usize,
    pub start_sec: f64,
    pub item_duration_sec: f64,
    pub ts_offset: f64,
}

struct DrainState {
    started_at: f64,
    last_progress_at: f64,
    waiting_for_sec: f64,
    stall_logged: bool,
}

impl Clone for DrainState {
    fn clone(&self) -> Self {
        Self {
            started_at: self.started_at,
            last_progress_at: self.last_progress_at,
            waiting_for_sec: self.waiting_for_sec,
            stall_logged: self.stall_logged,
        }
    }
}

struct EngineTimer {
    handle: tokio::task::AbortHandle,
}

enum TimerSlot {
    Restart,
    Reconnect,
}

struct EngineCore {
    items: Vec<PlaylistItem>,
    state: String,
    current_index: i64,
    position_sec: f64,
    start_position_sec: f64,
    completed_sec: f64,
    item_duration: f64,
    speed: f64,
    fps: f64,
    bitrate_kbps: f64,
    network_rate: ByteRateMeter,
    network_state: String,
    network_ok_since: f64,
    dropped_frames: f64,
    frame: f64,
    connected: bool,
    started_at: Option<f64>,
    reconnect_count: u32,
    command_line: String,
    child: Option<Supervisor>,
    generation: u64,
    out_time_sec: f64,
    stopping: bool,
    restart_timer: Option<EngineTimer>,
    reconnect_timer: Option<EngineTimer>,
    drain_timer: Option<EngineTimer>,
    log_seq: u64,
    last_stderr_line: String,
    last_stderr_repeat: u64,
    /* --- two-process playout (buffered mode) --- */
    playout: Option<Arc<Playout>>,
    encoder_pass: Option<PassInfo>,
    encoder_index: i64,
    encoder_item_duration: f64,
    drain: Option<DrainState>,
    restarting_session: bool,
    deferred_encoder_exit: Option<(usize, Option<i32>, f64)>,
    aired_passes: Vec<PassInfo>,
    published_sec: f64,
    encoder_stats: Option<EncoderLiveStats>,
}

impl EngineCore {
    fn new() -> Self {
        Self {
            items: vec![],
            state: "idle".into(),
            current_index: -1,
            position_sec: 0.0,
            start_position_sec: 0.0,
            completed_sec: 0.0,
            item_duration: 0.0,
            speed: 0.0,
            fps: 0.0,
            bitrate_kbps: 0.0,
            network_rate: ByteRateMeter::new(),
            network_state: "ok".into(),
            network_ok_since: 0.0,
            dropped_frames: 0.0,
            frame: 0.0,
            connected: false,
            started_at: None,
            reconnect_count: 0,
            command_line: String::new(),
            child: None,
            generation: 0,
            out_time_sec: 0.0,
            stopping: false,
            restart_timer: None,
            reconnect_timer: None,
            drain_timer: None,
            log_seq: 1,
            last_stderr_line: String::new(),
            last_stderr_repeat: 0,
            playout: None,
            encoder_pass: None,
            encoder_index: -1,
            encoder_item_duration: 0.0,
            drain: None,
            restarting_session: false,
            deferred_encoder_exit: None,
            aired_passes: vec![],
            published_sec: 0.0,
            encoder_stats: None,
        }
    }
}

pub struct StreamEngine {
    deps: EngineDeps,
    sink: EngineSink,
    core: Mutex<EngineCore>,
}

/// Whether this session runs the buffered two-process playout. The switch is
/// the authority; the delay only decides how deep the buffer is. A delay below
/// the floor is clamped rather than treated as "off".
fn buffered_mode(output: &crate::shared::types::OutputSettings) -> bool {
    output.buffered && output.buffer_sec > 0.0
}

/// How far the buffered encoder may run ahead of the publisher, in seconds.
/// The floor is enforced here as well as in the settings, so a value that never
/// passed through normalisation cannot leave the playout with a buffer too
/// small to cover a file change.
fn buffer_lead_limit_sec(output: &crate::shared::types::OutputSettings) -> f64 {
    BUFFER_SEC_MIN.max(output.buffer_sec)
}

/// Whether the buffered playout's MPEG-TS relay can carry the requested codec.
/// MPEG-TS carries H.264/HEVC but not AV1 (written as private data, read back
/// as `bin_data` and dropped), so AV1 uses the single-process FLV path.
fn buffered_relay_supports_codec(settings: &SessionSettings, media: &MediaInfo) -> bool {
    let codec = if settings.video.codec == "copy" {
        media.video_streams.first().map(|s| s.codec.as_str()).unwrap_or("")
    } else {
        settings.video.codec.as_str()
    };
    codec != "av1"
}

fn format_duration(total_seconds: f64) -> String {
    let s = total_seconds.max(0.0).floor() as i64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    if h > 0 {
        format!("{h}:{m:02}:{sec:02}")
    } else {
        format!("{m:02}:{sec:02}")
    }
}

impl StreamEngine {
    pub fn new(deps: EngineDeps, sink: EngineSink) -> Arc<Self> {
        Arc::new(Self { deps, sink, core: Mutex::new(EngineCore::new()) })
    }

    fn lock(&self) -> MutexGuard<'_, EngineCore> {
        self.core.lock().expect("engine core lock")
    }

    /// Type-erased wrappers around the two mutually recursive launch paths.
    /// Without the erasure the spawned continuations form an async-fn type
    /// cycle the compiler cannot break on its own.
    fn launch_from_boxed(
        self: &Arc<Self>,
        index: usize,
        position_sec: f64,
        reason: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
        let this = Arc::clone(self);
        Box::pin(async move { this.launch_current_from(index, position_sec, reason).await })
    }

    fn advance_to_boxed(self: &Arc<Self>, index: usize, reason: String) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let this = Arc::clone(self);
        Box::pin(async move { this.advance_to(index, reason).await })
    }

    /* ------------------------------------------------------------ *
     * i18n (reads the language per call, like the TS mainT)
     * ------------------------------------------------------------ */

    fn t(&self, key: &str) -> String {
        i18n::t(&(self.deps.get_language)(), key)
    }

    fn t_params(&self, key: &str, params: Vec<(&'static str, String)>) -> String {
        i18n::t_params(&(self.deps.get_language)(), key, &params)
    }

    /* ------------------------------------------------------------ *
     * Playlist
     * ------------------------------------------------------------ */

    pub fn get_playlist(&self) -> Vec<PlaylistItem> {
        self.lock().items.clone()
    }

    pub fn set_playlist(&self, items: Vec<PlaylistItem>) {
        {
            let mut core = self.lock();
            core.items = items;
            // A queue that is replaced while nothing is running has no viewer
            // position: resetting here is the second half of the session-end
            // reset, and also covers sessions that ended in `error`.
            if !Self::is_active_core(&core) {
                Self::reset_viewer_timeline(&mut core);
            }
        }
        self.emit_playlist();
        self.emit_status();
    }

    fn set_item_status_locked(core: &mut EngineCore, index: usize, status: &str, error: Option<String>) {
        let Some(item) = core.items.get_mut(index) else { return };
        item.status = status.into();
        if let Some(err) = error {
            item.error = Some(err);
        } else if status != "error" {
            item.error = None;
        }
    }

    /* ------------------------------------------------------------ *
     * Status / logging
     * ------------------------------------------------------------ */

    fn build_status(&self, core: &mut EngineCore) -> EngineStatus {
        let total: f64 = core.items.iter().map(|i| i.duration_sec).sum();
        let encoded = self.encoded_sec(core);
        let network_kbps = self.network_kbps(core);
        let mut item_status = HashMap::new();
        let mut item_error = HashMap::new();
        for i in &core.items {
            item_status.insert(i.id.clone(), i.status.clone());
            if let Some(err) = &i.error {
                item_error.insert(i.id.clone(), err.clone());
            }
        }
        EngineStatus {
            state: core.state.clone(),
            current_index: core.current_index,
            position_sec: core.position_sec,
            current_duration_sec: core.item_duration,
            completed_sec: core.completed_sec,
            total_duration_sec: total,
            speed: core.speed,
            fps: core.fps,
            bitrate_kbps: core.bitrate_kbps,
            network_kbps,
            network_state: self.classify_network(core, network_kbps),
            dropped_frames: core.dropped_frames,
            frame: core.frame,
            order: core.items.iter().map(|i| i.id.clone()).collect(),
            item_status,
            item_error,
            reconnect_count: core.reconnect_count,
            connected: core.connected,
            started_at: core.started_at,
            elapsed_sec: core.started_at.map(|s| ((now_ms() - s) / 1000.0).round() as u64).unwrap_or(0),
            buffered: core.playout.as_ref().map(|_| true),
            encoder: if core.playout.is_some() { core.encoder_stats } else { None },
            encoded_sec: encoded,
        }
    }

    /// Session-timeline position the encoder has reached, for the buffer
    /// display. Taken from the playout rather than derived from a lead
    /// measurement, and never reported below what has already been published.
    fn encoded_sec(&self, core: &EngineCore) -> Option<f64> {
        let playout = core.playout.as_ref()?;
        core.encoder_stats?;
        Some(core.completed_sec.max(playout.get_encoded_sec()))
    }

    fn network_kbps(&self, core: &EngineCore) -> f64 {
        match &core.playout {
            Some(playout) => playout.get_network_kbps(),
            None => core.network_rate.kbps(now_ms()),
        }
    }

    /// The bitrate the session is expected to put on the wire: the configured
    /// video+audio target with a small margin for container overhead. The
    /// TARGET is read, never maxBitrateKbps (see the TS original for the
    /// measured reasoning). Quality-targeted encoding configures no bitrate,
    /// so the encoder's own rate is the reference.
    fn network_reference_kbps(&self, core: &EngineCore) -> f64 {
        let settings = (self.deps.get_settings)();
        let target = if settings.video.rate_control == "crf" {
            0.0
        } else {
            settings.video.bitrate_kbps.max(0.0)
        };
        if target > 0.0 {
            return ((target + settings.audio.bitrate_kbps.max(0.0)) * 1.05).round();
        }
        match &core.playout {
            Some(_) => core.encoder_stats.map(|s| s.bitrate_kbps).unwrap_or(0.0).round(),
            None => core.bitrate_kbps.round(),
        }
    }

    /// Turns the measured egress into the verdict behind the readout's colour.
    fn classify_network(&self, core: &mut EngineCore, measured_kbps: f64) -> String {
        // A session that is not running has nothing to judge: the byte counter
        // keeps whatever it last reported, and re-deriving a verdict from it
        // would paint the idle status line with a dead session's colour.
        if core.state == "idle" || core.stopping {
            return "ok".into();
        }
        let reference = self.network_reference_kbps(core);
        let configured = (self.deps.get_settings)().video.rate_control != "crf";
        if reference < 200.0 || measured_kbps <= 0.0 {
            return Self::decay_network_state(core, "ok");
        }
        let ratio = measured_kbps / reference;
        let warn = if configured { NETWORK_WARN_RATIO } else { NETWORK_WARN_RATIO_ESTIMATED };
        let bad = if configured { NETWORK_BAD_RATIO } else { NETWORK_BAD_RATIO_ESTIMATED };
        if ratio < bad {
            Self::decay_network_state(core, "bad")
        } else if ratio < warn {
            Self::decay_network_state(core, "warn")
        } else {
            Self::decay_network_state(core, "ok")
        }
    }

    /// Applies the recovery delay to a state that reads better than the current
    /// one: getting worse is immediate, getting better has to hold.
    fn decay_network_state(core: &mut EngineCore, next: &str) -> String {
        let now = now_ms();
        if next == core.network_state {
            if next == "ok" {
                core.network_ok_since = now;
            }
            return core.network_state.clone();
        }
        if next == "bad" || (next == "warn" && core.network_state == "ok") {
            core.network_state = next.into();
            core.network_ok_since = 0.0;
            return core.network_state.clone();
        }
        if core.network_ok_since == 0.0 {
            core.network_ok_since = now;
        }
        if now - core.network_ok_since >= NETWORK_RECOVER_MS {
            core.network_state = next.into();
            core.network_ok_since = now;
        }
        core.network_state.clone()
    }

    fn emit_status(&self) {
        let status = {
            let mut core = self.lock();
            self.build_status(&mut core)
        };
        (self.sink.status)(status);
    }

    fn emit_playlist(&self) {
        let items = self.lock().items.clone();
        (self.sink.playlist)(items);
    }

    pub fn log(&self, level: &str, message: String) {
        let id = {
            let mut core = self.lock();
            let id = core.log_seq;
            core.log_seq += 1;
            id
        };
        (self.sink.log)(LogEntry { id, ts: now_ms(), level: level.into(), message });
    }

    /* ------------------------------------------------------------ *
     * Viewer timeline
     * ------------------------------------------------------------ */

    /// Sets the position inside the current file and derives the session total
    /// from it, so the two can never disagree. Only the VIEWER's position is
    /// written here — in buffered mode that means callers must be acting on the
    /// published position or on the user's own instruction.
    fn set_position(core: &mut EngineCore, position_sec: f64) {
        let max = if core.item_duration > 0.0 { core.item_duration } else { position_sec };
        let clamped = position_sec.max(0.0).min(max);
        core.position_sec = clamped;
        core.completed_sec = Self::sum_durations_before(core, core.current_index) + clamped;
    }

    /// Moves the viewer to an entry and a position inside it. Used only where
    /// the viewer's timeline genuinely restarts: opening a session, and a
    /// skip/jump that replaces the publish session.
    fn move_viewer_to(core: &mut EngineCore, index: usize, position_sec: f64, duration_sec: f64) {
        core.current_index = index as i64;
        core.start_position_sec = position_sec;
        core.item_duration = if duration_sec != 0.0 {
            duration_sec
        } else {
            core.items.get(index).map(|i| i.duration_sec).unwrap_or(0.0)
        };
        Self::set_position(core, position_sec);
    }

    /// Puts the viewer's progress back to the start of the queue. The progress
    /// bar is drawn from these fields, so zeros are what "the stream is over"
    /// has to look like — the next queue is a different timeline.
    fn reset_viewer_timeline(core: &mut EngineCore) {
        core.current_index = -1;
        core.position_sec = 0.0;
        core.start_position_sec = 0.0;
        core.completed_sec = 0.0;
        core.item_duration = 0.0;
    }

    /// Clears the figures that belong to a SESSION rather than to one pass:
    /// reset once when a run opens and once when it closes, never per pass.
    fn reset_session_stats(core: &mut EngineCore) {
        core.out_time_sec = 0.0;
        core.speed = 0.0;
        core.fps = 0.0;
        core.bitrate_kbps = 0.0;
        core.frame = 0.0;
        core.dropped_frames = 0.0;
        core.reconnect_count = 0;
        core.encoder_stats = None;
        core.command_line = String::new();
        core.network_rate.reset();
        core.network_state = "ok".into();
        core.network_ok_since = now_ms();
    }

    fn sum_durations_before(core: &EngineCore, index: i64) -> f64 {
        let mut sum = 0.0;
        let mut i = 0i64;
        while i < index && (i as usize) < core.items.len() {
            sum += core.items[i as usize].duration_sec;
            i += 1;
        }
        sum
    }

    /* ------------------------------------------------------------ *
     * Control
     * ------------------------------------------------------------ */

    fn is_active_core(core: &EngineCore) -> bool {
        core.state != "idle" && core.state != "error"
    }

    pub fn is_active(&self) -> bool {
        Self::is_active_core(&self.lock())
    }

    pub fn get_status(&self) -> EngineStatus {
        let mut core = self.lock();
        self.build_status(&mut core)
    }

    pub async fn start(self: &Arc<Self>, at_index: Option<usize>) -> EngineStatus {
        {
            let core = self.lock();
            if core.items.is_empty() {
                drop(core);
                self.log("warn", self.t("main.engine.playlistEmpty"));
                return self.get_status();
            }
            // The guard is deliberately "any running state", not a list of
            // three: a `draining` session still owns the publish timeline and
            // a `stopping` one is mid-teardown.
            if Self::is_active_core(&core) || core.state == "stopping" {
                drop(core);
                self.log("info", self.t("main.engine.alreadyStreaming"));
                return self.get_status();
            }
        }
        let ffmpeg = (self.deps.get_ffmpeg_path)();
        if ffmpeg.is_empty() {
            self.log("error", self.t("main.engine.noFfmpeg"));
            self.lock().state = "error".into();
            self.emit_status();
            return self.get_status();
        }
        let settings = (self.deps.get_settings)();
        if settings.output.server.trim().is_empty() {
            self.log("error", self.t("main.engine.noTarget"));
            self.lock().state = "error".into();
            self.emit_status();
            return self.get_status();
        }
        // The UI validates only on the test button; a hand-edited settings file
        // or an obs-websocket write could still pair an srt address with rtmp
        // and reach ffmpeg as `-f flv srt://…`. Refuse before spawning anything.
        if !address_matches_protocol(&settings.output.server, Some(&settings.output.protocol)) {
            let schemes = protocol_schemes(&settings.output.protocol);
            self.log("error", self.t_params("main.dialog.badUrlProtocol", vec![("schemes", schemes.into())]));
            self.lock().state = "error".into();
            self.emit_status();
            return self.get_status();
        }
        // Claim the state synchronously, before the first await: two calls
        // arriving in the launch window would otherwise both start a session.
        let first_index;
        {
            let mut core = self.lock();
            core.state = "preparing".into();
            core.stopping = false;
            Self::cancel_timers(&mut core);
            core.generation += 1;
            for item in core.items.iter_mut() {
                item.status = "pending".into();
                item.error = None;
            }
            core.completed_sec = 0.0;
            core.started_at = Some(now_ms());
            Self::reset_session_stats(&mut core);
            // A new session starts a new publish timeline, so the pass log and
            // the published position must not carry over from the previous run.
            core.aired_passes.clear();
            core.published_sec = 0.0;
            core.drain = None;
            core.encoder_pass = None;
            core.encoder_index = -1;
            core.encoder_item_duration = 0.0;
            let idx = match at_index {
                Some(n) => (n as i64).clamp(0, core.items.len() as i64 - 1).max(0) as usize,
                None => 0,
            };
            // Starting at an entry means the entries before it were passed
            // over, not played.
            if at_index.is_some() {
                for i in 0..idx {
                    core.items[i].status = "skipped".into();
                }
            }
            first_index = idx;
        }
        {
            let mut core = self.lock();
            let duration = core.items.get(first_index).map(|i| i.duration_sec).unwrap_or(0.0);
            Self::move_viewer_to(&mut core, first_index, 0.0, duration);
        }
        self.emit_playlist();
        self.log("info", self.t("main.engine.sessionStarting"));
        // The log is persisted and the panel is copyable: the target's key
        // portion is replaced with `*****`, only the server stays readable.
        self.log(
            "debug",
            format!(
                "{}: {}",
                self.t("main.engine.streamTarget"),
                crate::log_redact::mask_target(&settings.output.server, &settings.output.stream_key, Some(&settings.output.protocol))
            ),
        );
        let (count, total) = {
            let core = self.lock();
            (core.items.len(), core.items.iter().map(|i| i.duration_sec).sum())
        };
        self.log(
            "info",
            self.t_params("main.engine.playlistReady", vec![("n", count.to_string()), ("duration", format_duration(total))]),
        );

        if let Err(err) = self.launch_current_from(first_index, 0.0, "session-start".into()).await {
            self.fail_launch(err);
        }
        self.get_status()
    }

    pub async fn stop(&self) -> EngineStatus {
        {
            let mut core = self.lock();
            if core.state == "idle" {
                drop(core);
                return self.get_status();
            }
            // Invalidate every launch that is still awaiting something: without
            // this they resume after stop() has cleared the handles and spawn a
            // publisher nobody can stop.
            core.stopping = true;
            core.generation += 1;
            Self::cancel_timers(&mut core);
            core.state = "stopping".into();
        }
        self.emit_status();
        self.log("info", self.t("main.engine.stopping"));
        self.kill_child(true).await;
        // The buffered playout owns two processes; stopping it flushes whatever
        // the pusher still had in hand before the RTMP session is closed.
        let playout = self.lock().playout.take();
        if let Some(playout) = playout {
            playout.stop().await;
        }
        {
            let mut core = self.lock();
            core.encoder_pass = None;
            core.drain = None;
            core.aired_passes.clear();
            core.published_sec = 0.0;
            core.state = "idle".into();
            core.connected = false;
            // The run is over: the viewer's progress goes back to zero, for a
            // stop the user asked for exactly as for a queue that played out.
            Self::reset_viewer_timeline(&mut core);
            core.encoder_index = -1;
            core.encoder_item_duration = 0.0;
            core.started_at = None;
            Self::reset_session_stats(&mut core);
            for item in core.items.iter_mut() {
                if item.status == "live" || item.status == "preparing" {
                    item.status = "pending".into();
                }
            }
            core.stopping = false;
        }
        self.emit_playlist();
        self.emit_status();
        self.log("info", self.t("main.engine.stopped"));
        self.get_status()
    }

    /// Skip to the next playlist entry; the last entry ends the session.
    pub async fn skip_next(self: &Arc<Self>, reason: Option<String>) -> EngineStatus {
        let reason = reason.unwrap_or_else(|| self.t("main.engine.skipManual"));
        let index = {
            let core = self.lock();
            if core.current_index < 0 || core.state == "idle" {
                drop(core);
                self.log("warn", self.t("main.engine.nothingStreaming"));
                return self.get_status();
            }
            // A stop in progress is tearing the session down; advancing the
            // queue while the old encoder is still being killed is what opened
            // a new pass with no owner.
            if core.stopping || core.state == "stopping" {
                drop(core);
                self.log("warn", self.t("main.engine.nothingStreaming"));
                return self.get_status();
            }
            core.current_index as usize
        };
        self.log("info", self.t_params("main.engine.skipReason", vec![("reason", reason)]));
        {
            let mut core = self.lock();
            Self::set_item_status_locked(&mut core, index, "skipped", None);
            Self::reset_entries_from(&mut core, index + 1);
        }
        self.emit_playlist();
        self.advance_to(index + 1, "skip".into()).await;
        self.get_status()
    }

    /// Jump straight to a specific playlist entry.
    pub async fn jump_to_item(self: &Arc<Self>, item_id: &str) -> EngineStatus {
        let found = {
            let core = self.lock();
            core.items.iter().position(|i| i.id == item_id).map(|idx| (idx, core.items[idx].name.clone()))
        };
        let Some((index, name)) = found else {
            self.log("warn", self.t("main.engine.itemNotFound"));
            return self.get_status();
        };
        {
            let core = self.lock();
            if core.stopping || core.state == "stopping" {
                drop(core);
                self.log("warn", self.t("main.engine.nothingStreaming"));
                return self.get_status();
            }
        }
        {
            let mut core = self.lock();
            for i in 0..index {
                if core.items[i].status != "done" {
                    core.items[i].status = "skipped".into();
                }
            }
            // A jump replaces the publish session and discards the buffer, so
            // every entry from the target onward is about to be played again; a
            // later entry left `live` made two rows claim "streaming" at once.
            Self::reset_entries_from(&mut core, index);
        }
        self.emit_playlist();
        self.log("info", self.t_params("main.engine.jumpingTo", vec![("name", name)]));
        let was_idle = {
            let core = self.lock();
            core.state == "idle"
        };
        if was_idle {
            return self.start(Some(index)).await;
        }
        self.advance_to(index, "jump".into()).await;
        self.get_status()
    }

    /// Clears playback badges of entries that a jump/skip is about to replay.
    fn reset_entries_from(core: &mut EngineCore, index: usize) {
        for i in index..core.items.len() {
            let item = &mut core.items[i];
            if item.status != "pending" || item.error.is_some() {
                item.status = "pending".into();
                item.error = None;
            }
        }
    }

    /* ------------------------------------------------------------ *
     * Timers / child process
     * ------------------------------------------------------------ */

    fn cancel_timers(core: &mut EngineCore) {
        for slot in [&mut core.restart_timer, &mut core.reconnect_timer, &mut core.drain_timer] {
            if let Some(timer) = slot.take() {
                timer.handle.abort();
            }
        }
    }

    fn set_timer(core: &mut EngineCore, which: TimerSlot, delay_ms: u64) -> tokio::sync::oneshot::Receiver<()> {
        let slot = match which {
            TimerSlot::Restart => &mut core.restart_timer,
            TimerSlot::Reconnect => &mut core.reconnect_timer,
        };
        if let Some(old) = slot.take() {
            old.handle.abort();
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let _ = tx.send(());
        })
        .abort_handle();
        *slot = Some(EngineTimer { handle });
        rx
    }

    async fn kill_child(&self, graceful: bool) {
        let supervisor = self.lock().child.take();
        let Some(supervisor) = supervisor else { return };
        if supervisor.has_exited() {
            return;
        }
        // The signal first (ffmpeg handles it); the timer is only the backstop.
        supervisor.wait_exited(if graceful { 1500 } else { 400 }).await;
        if !supervisor.has_exited() {
            supervisor.kill();
            let _ = supervisor.wait_exited(1000).await;
        }
    }

    /* ------------------------------------------------------------ *
     * Launch / lifecycle
     * ------------------------------------------------------------ */

    async fn advance_to(self: &Arc<Self>, index: usize, reason: String) {
        {
            let core = self.lock();
            // A timer can outlive the session it was scheduled by (publisher
            // lost, queue ended, user pressed stop): launching here after the
            // teardown would recreate a session with no owner.
            if core.state == "idle" || core.stopping {
                return;
            }
        }
        let settings = (self.deps.get_settings)();
        let item_count = self.lock().items.len();
        if index >= item_count {
            if settings.output.loop_playlist {
                self.log("info", self.t("main.engine.playlistLooping"));
                {
                    let mut core = self.lock();
                    for item in core.items.iter_mut() {
                        item.status = "pending".into();
                    }
                    core.completed_sec = 0.0;
                }
                self.emit_playlist();
                if let Err(err) = self.launch_from_boxed(0, 0.0, reason).await {
                    self.fail_launch(err);
                }
                return;
            }
            // Buffered playout: the files are all encoded, but the pusher is
            // paced at 1x and still holds a backlog. Closing the session here
            // would cut the viewer off mid-file, so the run waits for the
            // backlog to air first. `is_session_active` rather than
            // `is_pusher_running`: a queue short enough to be encoded inside
            // the pusher's 600 ms head start has a session that has not opened
            // yet (measured: one 15 s clip, 0.33 s to encode, never aired).
            let session_active = {
                let core = self.lock();
                core.playout.as_ref().map(|p| p.is_session_active()).unwrap_or(false)
            };
            if session_active {
                let (waiting_for, published) = {
                    let core = self.lock();
                    let playout = core.playout.as_ref().expect("checked above");
                    (playout.get_next_offset(), playout.get_published_sec())
                };
                if published < waiting_for - DRAIN_TOLERANCE_SEC {
                    let now = now_ms();
                    {
                        let mut core = self.lock();
                        core.drain = Some(DrainState {
                            started_at: now,
                            last_progress_at: now,
                            waiting_for_sec: waiting_for,
                            stall_logged: false,
                        });
                        core.state = "draining".into();
                    }
                    self.emit_status();
                    self.log(
                        "info",
                        self.t_params("main.engine.drainingBuffer", vec![("time", format_duration(waiting_for - published))]),
                    );
                    self.start_drain_watchdog();
                    return;
                }
            }
            self.log("info", self.t("main.engine.playlistFinished"));
            self.finish_session(true).await;
            return;
        }
        if let Err(err) = self.launch_from_boxed(index, 0.0, reason).await {
            self.fail_launch(err);
        }
    }

    /// Checks the drain independently of publisher progress (that callback used
    /// to refresh `last_progress_at` first and stopped arriving when the
    /// publisher stalled, so the stall branch could never fire from it alone).
    fn start_drain_watchdog(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                let Some(engine) = weak.upgrade() else { return };
                engine.check_drain_complete();
            }
        })
        .abort_handle();
        // cancel_timers aborts this via the drain_timer slot (finish_session,
        // stop and start all cancel).
        if let Some(old) = self.lock().drain_timer.take() {
            old.handle.abort();
        }
        self.lock().drain_timer = Some(EngineTimer { handle });
    }

    /// Closes the RTMP session and returns the engine to idle.
    async fn finish_session(self: &Arc<Self>, played_out: bool) {
        {
            let mut core = self.lock();
            // Invalidate in-flight launches before awaiting anything: a queued
            // 150 ms advanceTo or a still-running probe would otherwise wake up
            // after this teardown and create a new session.
            core.stopping = true;
            core.generation += 1;
            Self::cancel_timers(&mut core);
            core.drain = None;
        }
        // Resolve the queue BEFORE anything is awaited: otherwise there is a
        // window where the session already reads as finished while the queue
        // still shows the last entry as live.
        if played_out {
            let changed = {
                let mut core = self.lock();
                let mut changed = false;
                for item in core.items.iter_mut() {
                    if item.status == "live" || item.status == "preparing" || item.status == "pending" {
                        item.status = "done".into();
                        changed = true;
                    }
                }
                changed
            };
            if changed {
                self.emit_playlist();
            }
        }
        self.kill_child(true).await;
        let playout = self.lock().playout.take();
        if let Some(playout) = playout {
            playout.stop().await;
        }
        {
            let mut core = self.lock();
            core.state = "idle".into();
            core.connected = false;
            // A queue that played out ends the same way a stopped one does as
            // far as the progress bar is concerned: back to zero. The
            // per-entry statuses stay `done`.
            Self::reset_viewer_timeline(&mut core);
            core.encoder_index = -1;
            core.encoder_item_duration = 0.0;
            core.encoder_pass = None;
            core.aired_passes.clear();
            core.published_sec = 0.0;
            core.started_at = None;
            Self::reset_session_stats(&mut core);
            core.stopping = false;
        }
        self.emit_status();
    }

    #[allow(dead_code)] // mirrors the TS original, which keeps the same wrapper
    async fn launch_current(self: &Arc<Self>, position_sec: f64, reason: String) -> Result<(), String> {
        let index = {
            let core = self.lock();
            core.current_index.max(0) as usize
        };
        self.launch_current_from(index, position_sec, reason).await
    }

    #[allow(clippy::too_many_lines)]
    async fn launch_current_from(self: &Arc<Self>, index: usize, position_sec: f64, reason: String) -> Result<(), String> {
        let item = self.lock().items.get(index).cloned();
        let Some(item) = item else { return Ok(()) };

        self.kill_child(true).await;
        {
            let core = self.lock();
            // A stop that arrived during the kill invalidates this launch.
            if core.stopping || core.state == "stopping" {
                return Ok(());
            }
        }
        {
            let mut core = self.lock();
            Self::cancel_timers(&mut core);
            core.generation += 1;
        }
        let generation = self.lock().generation;

        let settings = (self.deps.get_settings)();
        // Everything below describes what the VIEWER sees, so in buffered mode
        // it is the pusher's job — not this function's. Starting an encoder
        // pass says nothing about where the viewer is: moving the viewer's
        // entry and position here made the progress bar jump to the next file
        // the moment the encoder began it (see the TS original).
        let viewer_state_from_this_pass = !buffered_mode(&settings.output);
        if viewer_state_from_this_pass {
            let duration = item.duration_sec;
            {
                let mut core = self.lock();
                core.encoder_index = index as i64;
                core.encoder_item_duration = duration;
                Self::move_viewer_to(&mut core, index, position_sec, duration);
                // Raw ffmpeg timeline: rebased to zero by an input seek, so it
                // starts at 0 for every pass regardless of where it begins.
                core.out_time_sec = 0.0;
                core.speed = 0.0;
                core.fps = 0.0;
                core.bitrate_kbps = 0.0;
                core.frame = 0.0;
                core.dropped_frames = 0.0;
            }
        }
        {
            let mut core = self.lock();
            core.connected = false;
        }
        self.emit_status();

        /* --- probe (cached) --- */
        {
            let mut core = self.lock();
            core.state = "preparing".into();
            Self::set_item_status_locked(&mut core, index, "preparing", None);
        }
        self.emit_playlist();
        self.emit_status();
        let mut media = (self.deps.get_media)(&item.path);
        if media.is_none() {
            media = Some((self.deps.probe_media)(item.path.clone()).await);
        }
        let media = media.expect("probe result");
        {
            let core = self.lock();
            if generation != core.generation || core.stopping {
                return Ok(());
            }
        }

        if media.video_streams.is_empty() && media.audio_streams.is_empty() {
            let msg = media.probe_error.clone().unwrap_or_else(|| self.t("main.engine.mediaUnreadable"));
            self.log(
                "error",
                self.t_params("main.engine.itemSkipped", vec![("name", item.name.clone()), ("message", msg.clone())]),
            );
            {
                let mut core = self.lock();
                Self::set_item_status_locked(&mut core, index, "error", Some(msg));
                core.state = "error".into();
            }
            self.emit_playlist();
            self.emit_status();
            let this = Arc::clone(self);
            let rx = {
                let mut core = self.lock();
                Self::set_timer(&mut core, TimerSlot::Restart, 800)
            };
            tokio::spawn(async move {
                if rx.await.is_ok() {
                    let ok = {
                        let core = this.lock();
                        generation == core.generation && !core.stopping
                    };
                    if ok {
                        this.advance_to_boxed(index + 1, "finish".into()).await;
                    }
                }
            });
            return Ok(());
        }

        // In buffered mode the viewer is still on the previous file;
        // moveViewerTo and the pusher's reports are the only writers of
        // itemDuration.
        if viewer_state_from_this_pass {
            let mut core = self.lock();
            core.item_duration = if media.duration_sec != 0.0 { media.duration_sec } else { item.duration_sec };
        }
        if media.duration_sec != 0.0 && (media.duration_sec - item.duration_sec).abs() > 1.0 {
            {
                let mut core = self.lock();
                if let Some(entry) = core.items.get_mut(index) {
                    entry.duration_sec = media.duration_sec;
                }
            }
            self.emit_playlist();
        }

        /* Two-process playout: encoder ahead of a pacing pusher. The MPEG-TS
         * relay carries H.264 and HEVC but not AV1, so AV1 falls back to the
         * single-process FLV path (ffmpeg writes AV1 as Enhanced-RTMP `av01`
         * directly). */
        if buffered_mode(&settings.output) {
            if buffered_relay_supports_codec(&settings, &media) {
                self.launch_buffered(index, &item, &media, position_sec, &reason, generation).await;
                return Ok(());
            }
            if reason != "retry" {
                self.log("info", self.t("main.engine.av1SingleProcess"));
            }
        }

        let built = match build_stream_command(&BuildRequest {
            ffmpeg_path: (self.deps.get_ffmpeg_path)(),
            media: media.clone(),
            item: item.clone(),
            settings: settings.clone(),
            start_position_sec: position_sec,
            output_override: None,
            language: Some((self.deps.get_language)()),
        }) {
            Ok(b) => b,
            Err(err) => {
                self.log("error", self.t_params("main.engine.buildFailed", vec![("error", err.clone())]));
                {
                    let mut core = self.lock();
                    Self::set_item_status_locked(&mut core, index, "error", Some(err));
                    core.state = "error".into();
                }
                self.emit_playlist();
                self.emit_status();
                return Ok(());
            }
        };
        {
            let mut core = self.lock();
            core.command_line = built.command_line.clone();
        }

        self.log_stream_choice(&item, &media, &built.summary, built.video_stream_index, built.audio_stream_index, position_sec, &reason);

        // Only when the stream really is audio only: a command that generated a
        // black stand-in picture IS pushing video.
        if built.video_stream_index < 0 && !built.black_video {
            self.log("warn", self.t("main.engine.noVideoSelected"));
        }
        for w in &built.warnings {
            self.log("warn", w.clone());
        }
        self.log("ffmpeg", built.command_line.clone());

        /* --- spawn --- */
        {
            let core = self.lock();
            // The probe/build above awaited; a stop during either must not end
            // in a process whose handle stop() has already dropped.
            if generation != core.generation || core.stopping {
                return Ok(());
            }
        }
        {
            let mut core = self.lock();
            core.state = "connecting".into();
        }
        self.emit_status();

        let mut cmd = Command::new((self.deps.get_ffmpeg_path)());
        cmd.args(&built.args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                self.log("error", self.t_params("main.engine.spawnFailed", vec![("error", err.to_string())]));
                {
                    let mut core = self.lock();
                    Self::set_item_status_locked(&mut core, index, "error", Some(err.to_string()));
                    core.state = "error".into();
                }
                self.emit_playlist();
                self.emit_status();
                return Ok(());
            }
        };
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        {
            let core = self.lock();
            if generation != core.generation || core.stopping {
                drop(core);
                let _ = child.start_kill();
                return Ok(());
            }
        }

        let this = Arc::clone(self);
        let supervisor = spawn_supervised(child, move |code| {
            let this = Arc::clone(&this);
            tokio::spawn(async move {
                let fut: std::pin::Pin<Box<dyn Future<Output = ()> + Send>> =
                    Box::pin(this.on_close(generation, index, code));
                fut.await;
            });
        });
        {
            let mut core = self.lock();
            core.child = Some(supervisor);
            core.state = "live".into();
            Self::set_item_status_locked(&mut core, index, "live", None);
        }
        self.emit_playlist();
        self.emit_status();

        // stdout reader: `-progress pipe:1` text (the output target is the
        // server, so stdout carries only progress blocks).
        {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => this.on_stdout_line(generation, &line).await,
                        _ => return,
                    }
                }
            });
        }
        // stderr reader: ffmpeg's own log.
        {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => this.on_stderr_line(generation, &line).await,
                        _ => return,
                    }
                }
            });
        }
        Ok(())
    }

    /// Writes the "what did we find and what did we pick" diagnostics for one
    /// pass. Both pipelines call this and must produce the same lines;
    /// `reason === 'retry'` resumes mid-file, where repeating the inventory
    /// would only add noise.
    fn log_stream_choice(
        &self,
        item: &PlaylistItem,
        media: &MediaInfo,
        summary: &[String],
        video_stream_index: i64,
        audio_stream_index: i64,
        position_sec: f64,
        reason: &str,
    ) {
        if reason == "retry" && position_sec > 0.0 {
            return;
        }
        let language = (self.deps.get_language)();
        let mut head = i18n::t_params(&language, "main.engine.preparingItem", &[("name", item.name.clone())]);
        if position_sec > 0.0 {
            head.push_str(&i18n::t_params(&language, "main.engine.preparingFrom", &[("time", format_duration(position_sec))]));
        }
        self.log("info", head);
        // Log exactly what was found, so "the stream had no video" is
        // diagnosable from the log alone.
        self.log("debug", format!("   {}: {}", self.t("main.engine.itemPath"), item.path));
        self.log("debug", format!("   {}", describe_streams(media, &language)));
        if video_stream_index >= 0 {
            let v = media.video_streams.iter().find(|s| s.index == video_stream_index);
            self.log(
                "debug",
                format!(
                    "   {}{}",
                    i18n::t_params(&language, "main.engine.selectedVideo", &[("index", video_stream_index.to_string())]),
                    v.map(|v| format!(
                        " ({} {}x{} @ {}fps)",
                        v.codec,
                        v.width.map(|w| w.to_string()).unwrap_or_else(|| "?".into()),
                        v.height.map(|h| h.to_string()).unwrap_or_else(|| "?".into()),
                        v.fps.map(|f| f.to_string()).unwrap_or_else(|| "?".into())
                    ))
                    .unwrap_or_default()
                ),
            );
        }
        if audio_stream_index >= 0 {
            let a = media.audio_streams.iter().find(|s| s.index == audio_stream_index);
            self.log(
                "debug",
                format!(
                    "   {}{}",
                    i18n::t_params(&language, "main.engine.selectedAudio", &[("index", audio_stream_index.to_string())]),
                    a.map(|a| format!(
                        " ({} {}ch @ {}Hz)",
                        a.codec,
                        a.channels.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                        a.sample_rate.map(|r| r.to_string()).unwrap_or_else(|| "?".into())
                    ))
                    .unwrap_or_default()
                ),
            );
        }
        for line in summary {
            self.log("debug", format!("   {line}"));
        }
    }

    /* ------------------------------------------------------------ *
     * Two-process playout (buffered mode)
     * ------------------------------------------------------------ */

    /// Feeds one playlist entry to the buffered playout. The pusher is created
    /// once per session and then left alone: every later call only replaces the
    /// encoder, so the RTMP publish session survives and viewers never
    /// re-buffer. Each pass carries a timeline offset so the published stream
    /// stays continuous across restarts.
    async fn launch_buffered(
        self: &Arc<Self>,
        index: usize,
        item: &PlaylistItem,
        media: &MediaInfo,
        position_sec: f64,
        reason: &str,
        generation: u64,
    ) {
        let settings = (self.deps.get_settings)();
        let ffmpeg = (self.deps.get_ffmpeg_path)();

        let built = match build_encoder_args(&BuildRequest {
            ffmpeg_path: ffmpeg.clone(),
            media: media.clone(),
            item: item.clone(),
            settings: settings.clone(),
            start_position_sec: position_sec,
            output_override: None,
            language: Some((self.deps.get_language)()),
        }) {
            Ok(b) => b,
            Err(err) => {
                self.log("error", self.t_params("main.engine.buildEncoderFailed", vec![("error", err.clone())]));
                {
                    let mut core = self.lock();
                    Self::set_item_status_locked(&mut core, index, "error", Some(err));
                    core.state = "error".into();
                }
                self.emit_playlist();
                self.emit_status();
                return;
            }
        };
        self.log_stream_choice(item, media, &built.summary, built.video_stream_index, built.audio_stream_index, position_sec, reason);
        for w in &built.warnings {
            self.log("warn", w.clone());
        }
        {
            let core = self.lock();
            if generation != core.generation || core.stopping {
                return;
            }
        }

        // The encoder's own view of this pass. The viewer's fields are NOT
        // touched here (see the note in launch_current_from): what the encoder
        // is producing is reported as a buffer lead and as per-entry "preparing"
        // status, both of which stay on the encoder's side of the line.
        {
            let mut core = self.lock();
            core.encoder_index = index as i64;
            core.encoder_item_duration = if media.duration_sec != 0.0 { media.duration_sec } else { item.duration_sec };
        }

        // A pass that has to open the publish session itself: either the
        // playout does not exist yet (a retry after the pusher died drops it),
        // or the pass is about to replace the session (skip/jump). Either way
        // the published timeline starts over at this entry, so this is also
        // where the viewer moves.
        let reset_viewer = {
            let core = self.lock();
            if core.playout.is_none() {
                // The guard must go first: create_playout and log() both take
                // the core lock again, and the mutex is not reentrant.
                drop(core);
                self.create_playout(&settings, &ffmpeg);
                self.log(
                    "info",
                    self.t_params(
                        "main.engine.bufferedEnabled",
                        vec![("sec", (buffer_lead_limit_sec(&settings.output) as i64).to_string())],
                    ),
                );
                true
            } else {
                false
            }
        };

        let restart_session = {
            let core = self.lock();
            let playout = core.playout.as_ref().expect("created above");
            playout.is_session_active() && (reason == "skip" || reason == "jump")
        };
        let ts_offset = {
            let core = self.lock();
            let playout = core.playout.as_ref().expect("created above");
            if restart_session {
                if position_sec > 0.05 {
                    PASS_START_MARGIN_SEC
                } else {
                    0.0
                }
            } else {
                playout.get_next_offset() + if position_sec > 0.05 { PASS_START_MARGIN_SEC } else { 0.0 }
            }
        };
        if restart_session {
            // The timeline restarts with the session, so what the viewer is
            // watching is reported against the new one from here on.
            let mut core = self.lock();
            core.aired_passes.clear();
            core.published_sec = 0.0;
            core.drain = None;
        }
        {
            let mut core = self.lock();
            // A new publish session means the viewer's timeline restarts at
            // this entry, so it moves now rather than when the new publisher
            // first reports — and for a skip or a jump that is also what the
            // user just asked for. This is the only way a buffered file change
            // moves the viewer; a plain `finish` advance leaves it where the
            // pusher is.
            if reset_viewer || restart_session {
                let duration = core.encoder_item_duration;
                Self::move_viewer_to(&mut core, index, position_sec, duration);
            }
            core.encoder_pass = Some(PassInfo {
                index,
                start_sec: position_sec,
                item_duration_sec: core.encoder_item_duration,
                ts_offset,
            });
            // Recorded before the encoder starts, so a pusher that crosses into
            // this pass while it is still being built is already reported as
            // watching it. Duplicate offsets are kept: a pass that produced no
            // material must still occupy its slot, or every later report would
            // be mapped to the pass before it.
            let pass_snapshot = core.encoder_pass.clone();
            if let Some(pass) = pass_snapshot {
                core.aired_passes.push(pass);
            }
            // A bounded tail prevents a multi-day loop from turning the lookup
            // into an ever-growing scan.
            if core.aired_passes.len() > 128 {
                let excess = core.aired_passes.len() - 64;
                core.aired_passes.drain(..excess);
            }
        }

        let pass = EncoderPass {
            input: item.path.clone(),
            inputs: built.inputs.clone(),
            args: built.args.clone(),
            start_position_sec: position_sec,
            input_offset_sec: built.input_offset_sec,
            ts_offset,
            seq: 0,
        };
        {
            let playout = self.lock().playout.as_ref().expect("created above").clone();
            if restart_session {
                // The session is being replaced, so nothing the playout reports
                // until it is back counts as progress: treating that as "a file
                // completed" ends the playlist — which tears down the very
                // session the restart is opening (measured: the jump was
                // cancelled by the completion of the file it was jumping to).
                self.lock().restarting_session = true;
                playout.restart_session(pass).await;
                self.lock().restarting_session = false;
                {
                    let core = self.lock();
                    let still_ours = core.playout.as_ref().map(|p| Arc::ptr_eq(p, &playout)).unwrap_or(false);
                    if generation != core.generation || core.stopping || !still_ours {
                        return;
                    }
                }
                // The new pass has been handed over and will air from the start
                // of the file.
                {
                    let mut core = self.lock();
                    core.encoder_pass = Some(PassInfo {
                        index,
                        start_sec: position_sec,
                        item_duration_sec: core.encoder_item_duration,
                        ts_offset,
                    });
                    core.aired_passes.clear();
                    let pass_snapshot = core.encoder_pass.clone();
                    if let Some(pass) = pass_snapshot {
                        core.aired_passes.push(pass);
                    }
                }
                // A pass that finished during the restart was held back and has
                // to be accounted for now: the new publisher is up, so this is
                // the point at which "the file is finished" can be acted on.
                let deferred = self.lock().deferred_encoder_exit.take();
                if let Some((d_index, d_code, d_material)) = deferred {
                    self.handle_encoder_exit(d_index, d_code, d_material);
                }
            } else if playout.is_session_active() {
                // The session exists — including while its publisher is still
                // inside the head start. Starting a second one there would
                // leave two publishers on the key, so a pass that arrives in
                // that window replaces the encoder instead.
                playout.restart_encoder(pass).await;
            } else {
                playout.start(pass, false).await;
                {
                    let core = self.lock();
                    let still_ours = core.playout.as_ref().map(|p| Arc::ptr_eq(p, &playout)).unwrap_or(false);
                    if generation != core.generation || core.stopping || !still_ours {
                        return;
                    }
                }
            }
        }

        {
            let mut core = self.lock();
            core.state = "live".into();
            // The entry is marked `preparing`, not `live`: "live" means the
            // viewer can see it, and being handed to the encoder is not that —
            // the encoder runs ahead. markPlayedThrough promotes it when the
            // publisher actually reaches it.
            Self::set_item_status_locked(&mut core, index, "preparing", None);
        }
        self.emit_playlist();
        self.emit_status();
    }

    /// Creates the playout and its event bridge. The bridge sends events over a
    /// channel to a dispatcher that calls back into the engine (via Weak, so
    /// the engine → playout → engine reference chain cannot leak).
    fn create_playout(self: &Arc<Self>, settings: &SessionSettings, ffmpeg: &str) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PlayoutEvent>();
        let engine_weak = Arc::downgrade(self);
        // The playout formats its own log lines; the lookup goes through the
        // engine so the language is resolved per call.
        let t_weak = Arc::downgrade(self);
        let t: crate::stream::playout::TranslateFn = Arc::new(move |key, params| match t_weak.upgrade() {
            Some(engine) => engine.t_params(key, params),
            None => i18n::t_params(&(crate::store::settings::get_language)(), key, &params),
        });
        let callbacks = PlayoutCallbacks { tx, t };
        let playout = Playout::new(
            ffmpeg.to_string(),
            self.build_pusher_args(settings),
            buffer_lead_limit_sec(&settings.output),
            callbacks,
        );
        self.lock().playout = Some(playout);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let Some(engine) = engine_weak.upgrade() else { return };
                match event {
                    PlayoutEvent::Log(level, message) => engine.log(&level, message),
                    PlayoutEvent::Published(sec) => engine.on_published(sec),
                    PlayoutEvent::PusherExit(code) => engine.on_pusher_exit(code).await,
                    PlayoutEvent::EncoderExit(code, material) => engine.on_encoder_exit(code, material),
                }
            }
        });
    }

    /// The pusher's arguments: the muxer, per-protocol connection options and
    /// the push destination. The protocol decides all three; only the FLV
    /// muxer accepts the FLV flag set, and only RTSP can choose its transport.
    fn build_pusher_args(&self, settings: &SessionSettings) -> Vec<String> {
        let out = &settings.output;
        let protocol = if out.protocol.is_empty() { DEFAULT_STREAM_PROTOCOL.to_string() } else { out.protocol.clone() };
        let mut args: Vec<String> = Vec::new();
        if container_for_protocol(Some(&protocol)).as_deref() == Some("flv") {
            args.push("-flvflags".into());
            args.push("no_duration_filesize".into());
        }
        if protocol == "rtsp" {
            args.push("-rtsp_transport".into());
            args.push(network_for_protocol(Some(&protocol), Some(&out.network)));
        }
        args.extend(protocol_key_args(Some(&protocol), &out.stream_key));
        if !out.extra_output_args.trim().is_empty() {
            args.extend(split_output_args(&out.extra_output_args));
        }
        args.push("-f".into());
        args.push(muxer_for_protocol(Some(&protocol)));
        args.push(build_push_target(&out.server, &out.stream_key, Some(&protocol)));
        args
    }

    /// The pusher reported how far it has published. Its timeline is the
    /// session timeline and only moves forward, so the media position is that
    /// value minus the offset of the pass the pusher has reached.
    fn on_published(self: &Arc<Self>, seconds: f64) {
        {
            let core = self.lock();
            // A publisher that is being torn down keeps reporting for a moment,
            // and those late blocks still name the pass that just aired. The
            // same applies while a skip/jump is replacing the session.
            if core.stopping || core.restarting_session || core.state == "idle" {
                return;
            }
        }
        let was_connected = {
            let mut core = self.lock();
            let was = core.connected;
            core.connected = true;
            was
        };
        if !was_connected {
            self.log("info", self.t("main.engine.rtmpAccepted"));
        }
        let playlist_changed = {
            let mut core = self.lock();
            // Progress, not elapsed time, is what proves the pusher is still
            // working, so the drain stall guard measures inactivity.
            if seconds > core.published_sec {
                if let Some(drain) = &mut core.drain {
                    drain.last_progress_at = now_ms();
                }
            }
            core.published_sec = seconds;
            // What is on screen is decided by which pass boundary the pusher
            // has crossed — not by the pass currently being encoded.
            let live = Self::pass_at(&core, seconds);
            let mut changed = false;
            if let Some(live) = live {
                core.item_duration = live.item_duration_sec;
                core.current_index = live.index as i64;
                Self::set_position(&mut core, live.start_sec + (seconds - live.ts_offset).max(0.0));
                changed = Self::mark_played_through(&mut core, &live);
            }
            changed
        };
        // The live figures belong to the encoder (which runs at its own pace),
        // so they travel separately from the viewer's numbers.
        {
            let mut core = self.lock();
            if let Some(playout) = &core.playout {
                let (speed, fps, bitrate, lead) = playout.get_encoder_stats();
                core.encoder_stats = Some(EncoderLiveStats { speed, fps, bitrate_kbps: bitrate, lead_sec: lead });
            }
        }
        if playlist_changed {
            self.emit_playlist();
        }
        self.emit_status();
        self.check_drain_complete();
    }

    /// Marks playlist entries as aired, driven ONLY by the published position:
    /// what the encoder has finished is not what has been sent, and in buffered
    /// mode the two can be a long way apart.
    fn mark_played_through(core: &mut EngineCore, live: &PassInfo) -> bool {
        let mut changed = false;
        for (i, item) in core.items.iter_mut().enumerate() {
            // Only the entry being published may say "live"; the published
            // position is the authority that clears a stale one.
            if i > live.index && (item.status == "live" || item.status == "done") {
                item.status = "pending".into();
                changed = true;
                continue;
            }
            // The session timeline only moves forward, so an entry the viewer
            // has already passed can never become current again. Holding onto
            // `done` makes the queue immune to an out-of-order report.
            let desired: Option<String> = if item.status == "done" {
                Some("done".into())
            } else if i < live.index {
                Some("done".into())
            } else if i == live.index {
                Some("live".into())
            } else {
                None
            };
            // Entries the user resolved (skipped) or that failed keep what they
            // were given: a skip is a decision, not a playback state.
            let Some(desired) = desired else { continue };
            if item.status == "skipped" || item.status == "error" {
                continue;
            }
            if item.status != desired {
                item.status = desired;
                changed = true;
            }
        }
        changed
    }

    /// The pass the pusher is currently airing: the last boundary it reached.
    /// Before the pusher's first report the session has only just started, so
    /// the fallback is the OLDEST pass (returning the newest moved the viewer
    /// into a file that had not aired yet).
    fn pass_at(core: &EngineCore, seconds: f64) -> Option<PassInfo> {
        let mut found: Option<PassInfo> = None;
        for p in &core.aired_passes {
            if seconds >= p.ts_offset - 0.001 {
                found = Some(p.clone());
            } else {
                break;
            }
        }
        found.or_else(|| core.aired_passes.first().cloned())
    }

    /// Ends the session once the pusher has published everything that was
    /// encoded. The stall guard exists because a publisher that stops
    /// reporting while still running is a fault (a dead RTMP connection), not
    /// content.
    fn check_drain_complete(self: &Arc<Self>) {
        let (mut drain, published) = {
            let core = self.lock();
            match (&core.drain, core.stopping, core.state.as_str()) {
                (Some(drain), false, "idle") | (Some(drain), false, _) => (drain.clone(), core.published_sec),
                _ => return,
            }
        };
        let now = now_ms();
        let mut played_out = false;
        let mut act = false;
        if published >= drain.waiting_for_sec - DRAIN_TOLERANCE_SEC {
            self.log("info", self.t_params("main.engine.bufferAired", vec![("sec", format!("{published:.1}"))]));
            played_out = true;
            act = true;
        } else if now - drain.last_progress_at > DRAIN_STALL_MS {
            // The interval calls this every second, so the line is written once
            // per stall.
            if !drain.stall_logged {
                drain.stall_logged = true;
                {
                    let mut core = self.lock();
                    if let Some(d) = &mut core.drain {
                        d.stall_logged = true;
                    }
                }
                let waiting_for = drain.waiting_for_sec;
                self.log(
                    "warn",
                    self.t_params(
                        "main.engine.publisherStalled",
                        vec![("sec", format!("{published:.1}")), ("delivered", format!("{waiting_for:.1}"))],
                    ),
                );
            }
        } else if (now - drain.started_at) / 1000.0 > drain.waiting_for_sec + DRAIN_MAX_SEC {
            let waiting_for = drain.waiting_for_sec;
            self.log("warn", self.t_params("main.engine.drainTooLong", vec![("sec", format!("{waiting_for:.1}"))]));
            act = true;
        } else {
            return;
        }
        if act {
            // The drained queue itself is the queue played out; a stalled
            // publisher is not.
            let this = Arc::clone(self);
            tokio::spawn(async move {
                this.finish_session(played_out).await;
            });
        }
    }

    /// An encoder pass ended: what it produced is now part of the stream.
    fn on_encoder_exit(self: &Arc<Self>, code: Option<i32>, material_sec: f64) {
        let index = {
            let core = self.lock();
            if core.stopping {
                return;
            }
            match &core.encoder_pass {
                Some(pass) => pass.index,
                None => return,
            }
        };
        // A pass that ends while the session is being replaced cannot be acted
        // on yet — and cannot simply be dropped either: a fast encoder finishes
        // a short file inside the restart window, and a dropped completion
        // leaves the run sitting on a finished file with an empty buffer. Held
        // here and replayed when the restart finishes (see launch_buffered).
        if self.lock().restarting_session {
            self.lock().deferred_encoder_exit = Some((index, code, material_sec));
            return;
        }
        self.handle_encoder_exit(index, code, material_sec);
    }

    /// Accounts for a finished pass: reports it, then queues the next file.
    fn handle_encoder_exit(self: &Arc<Self>, index: usize, code: Option<i32>, material_sec: f64) {
        let item_name = self.lock().items.get(index).map(|i| i.name.clone());
        let file_word = self.t("main.engine.file");
        if code != Some(0) {
            let unknown = self.t("main.engine.unknown");
            let code_str = code.map(|c| c.to_string()).unwrap_or_else(|| unknown.clone());
            self.log(
                "warn",
                self.t_params(
                    "main.engine.encoderCrashed",
                    vec![("name", item_name.clone().unwrap_or_else(|| file_word.clone())), ("code", code_str.clone())],
                ),
            );
            let detail = self.t_params("main.engine.encoderExitCode", vec![("code", code_str)]);
            {
                let mut core = self.lock();
                Self::set_item_status_locked(&mut core, index, "error", Some(detail));
            }
            self.emit_playlist();
            self.emit_status();
        }
        self.log(
            "info",
            self.t_params(
                "main.engine.encoderDone",
                vec![("name", item_name.unwrap_or(file_word)), ("sec", format!("{material_sec:.1}"))],
            ),
        );
        // Being encoded is NOT being streamed, so the entry is not marked done
        // here: the status is advanced from the published position instead. The
        // short delay only keeps the next pass from being spawned inside this
        // pass's own exit handler.
        let generation = self.lock().generation;
        let this = Arc::clone(self);
        let rx = {
            let mut core = self.lock();
            Self::set_timer(&mut core, TimerSlot::Restart, NEXT_PASS_DELAY_MS)
        };
        let _ = generation;
        tokio::spawn(async move {
            if rx.await.is_ok() {
                let ok = {
                    let core = this.lock();
                    !core.stopping && core.state != "idle" && core.state != "error"
                };
                if ok {
                    this.advance_to_boxed(index + 1, "finish".into()).await;
                }
            }
        });
    }

    /// The pusher died: that IS the RTMP session, so the run is over.
    async fn on_pusher_exit(self: &Arc<Self>, code: Option<i32>) {
        let playout = {
            let mut core = self.lock();
            if core.stopping {
                return;
            }
            // The session that scheduled the pending advance is gone: cancel it
            // and invalidate any in-flight launch, or a 150 ms advanceTo can
            // start a new encoder/session after the reconnect budget has
            // already been exhausted.
            core.generation += 1;
            Self::cancel_timers(&mut core);
            core.connected = false;
            // The buffered playout is the RTMP session, so a dead publisher
            // takes it with it: without this the engine keeps handing encoder
            // passes to a playout whose reader is gone.
            core.playout.take()
        };
        if let Some(playout) = playout {
            playout.stop().await;
        }
        {
            let mut core = self.lock();
            core.aired_passes.clear();
            core.published_sec = 0.0;
            core.drain = None;
        }
        // A publish that failed is retried before the run is given up on. This
        // matters most right after a skip or a jump: the server may still be
        // tearing the previous session down. Retrying replays the position the
        // viewer is at rather than resuming mid-buffer, because the playout —
        // and its buffer — are gone.
        let settings = (self.deps.get_settings)();
        if settings.output.max_reconnect_attempts > 0.0
            && (self.lock().reconnect_count as f64) < settings.output.max_reconnect_attempts
        {
            let count = {
                let mut core = self.lock();
                core.reconnect_count += 1;
                core.reconnect_count
            };
            let delay_ms = (settings.output.reconnect_delay_sec.max(1.0) * 1000.0) as u64;
            {
                let mut core = self.lock();
                core.state = "reconnecting".into();
            }
            self.emit_status();
            let unknown = self.t("main.engine.unknown");
            self.log(
                "warn",
                self.t_params(
                    "main.engine.publisherRetry",
                    vec![
                        ("code", code.map(|c| c.to_string()).unwrap_or(unknown)),
                        ("delay", format!("{}", delay_ms as f64 / 1000.0)),
                        ("n", count.to_string()),
                        ("max", (settings.output.max_reconnect_attempts as i64).to_string()),
                    ],
                ),
            );
            let this = Arc::clone(self);
            let rx = {
                let mut core = self.lock();
                Self::set_timer(&mut core, TimerSlot::Reconnect, delay_ms)
            };
            tokio::spawn(async move {
                if rx.await.is_ok() {
                    let ok = {
                        let core = this.lock();
                        !core.stopping && core.state != "idle"
                    };
                    if ok {
                        let (index, position) = {
                            let core = this.lock();
                            (core.current_index.max(0) as usize, core.position_sec.max(0.0))
                        };
                        if let Err(err) = this.launch_from_boxed(index, position, "retry".into()).await {
                            this.fail_launch(err);
                        }
                    }
                }
            });
            return;
        }
        self.fail_session(code, None).await;
    }

    /// Ends a session that cannot continue, leaving the status line honest.
    async fn fail_session(self: &Arc<Self>, code: Option<i32>, reason: Option<String>) {
        {
            let mut core = self.lock();
            Self::cancel_timers(&mut core);
            core.state = "error".into();
        }
        self.kill_child(true).await;
        let playout = self.lock().playout.take();
        if let Some(playout) = playout {
            playout.stop().await;
        }
        let index = {
            let core = self.lock();
            core.encoder_pass.as_ref().map(|p| p.index as i64).unwrap_or(core.current_index)
        };
        let unknown = self.t("main.engine.unknown");
        let detail = reason.unwrap_or_else(|| {
            self.t_params("main.engine.publisherLost", vec![("code", code.map(|c| c.to_string()).unwrap_or_else(|| unknown.clone()))])
        });
        {
            let mut core = self.lock();
            if index >= 0 {
                Self::set_item_status_locked(&mut core, index as usize, "error", Some(detail.clone()));
            }
            core.encoder_pass = None;
            core.encoder_index = -1;
            core.encoder_item_duration = 0.0;
            core.started_at = None;
            core.connected = false;
            // The run is over, however badly: the progress bar must not keep
            // the position the dead session happened to reach.
            Self::reset_viewer_timeline(&mut core);
            Self::reset_session_stats(&mut core);
        }
        self.emit_playlist();
        self.emit_status();
        self.log("error", detail);
    }

    /// Surfaces an exception thrown by a fire-and-forget launch path.
    fn fail_launch(self: &Arc<Self>, err: String) {
        {
            let core = self.lock();
            if core.stopping {
                return;
            }
        }
        let message = self.t_params("main.engine.launchFailed", vec![("error", err)]);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.fail_session(None, Some(message)).await;
        });
    }

    /* ------------------------------------------------------------ *
     * ffmpeg output parsing (single-process pipeline)
     * ------------------------------------------------------------ */

    async fn on_stdout_line(&self, generation: u64, line: &str) {
        let Some((key, value)) = line.split_once('=') else { return };
        let key = key.trim();
        let value = value.trim();
        let mut connected_now = false;
        let mut emit = false;
        {
            let mut core = self.lock();
            if generation != core.generation {
                return;
            }
            match key {
                "out_time_us" | "out_time_ms" => {
                    if let Ok(micro) = value.parse::<f64>() {
                        let elapsed = micro / 1_000_000.0;
                        // ffmpeg's `-progress` timeline is relative to the
                        // *output*, which an input seek rebased to zero:
                        // positionSec is the seek offset plus what ffmpeg has
                        // produced since (the reported value directly made the
                        // bar jump backwards at every seek and never reach the
                        // end).
                        if elapsed > core.out_time_sec - 1.0 {
                            core.out_time_sec = elapsed;
                            let base = core.start_position_sec;
                            Self::set_position(&mut core, base + elapsed);
                        }
                    }
                }
                "speed" => {
                    if let Ok(v) = value.replace('x', "").parse::<f64>() {
                        core.speed = v;
                    }
                }
                "fps" => {
                    if let Ok(v) = value.parse::<f64>() {
                        if v > 0.0 {
                            core.fps = v;
                        }
                    }
                }
                "bitrate" => {
                    if let Ok(v) = value.replace("kbits/s", "").trim().parse::<f64>() {
                        if v > 0.0 {
                            core.bitrate_kbps = v;
                            if !core.connected {
                                core.connected = true;
                                connected_now = true;
                            }
                        }
                    }
                }
                "total_size" => {
                    // Bytes this process has written to the server, i.e. the
                    // network figure. Absent for outputs that do not count
                    // bytes, in which case the readout stays blank.
                    if let Ok(bytes) = value.parse::<f64>() {
                        if bytes > 0.0 {
                            core.network_rate.add(bytes, now_ms());
                        }
                    }
                }
                "frame" => {
                    if let Ok(v) = value.parse::<f64>() {
                        core.frame = v;
                    }
                }
                "drop_frames" => {
                    if let Ok(v) = value.parse::<f64>() {
                        core.dropped_frames = v;
                    }
                }
                "progress" => emit = true,
                _ => {}
            }
        }
        if connected_now {
            self.log("info", self.t("main.engine.rtmpAccepted"));
        }
        if emit {
            self.emit_status();
        }
    }

    fn is_noisy(line: &str) -> bool {
        if line.trim().is_empty() {
            return true;
        }
        // Periodic per-stream statistics; `-progress` already gives us these.
        regex::Regex::new(r"^\s*(frame=|size=|video:|audio:|subtitle:)").expect("static regex").is_match(line)
    }

    fn classify_stderr(line: &str) -> &'static str {
        let l = line.to_ascii_lowercase();
        if l.contains("error") || l.contains("failed") || l.contains("invalid") || l.contains("unable to") {
            return "error";
        }
        if l.contains("warning") || l.contains("deprecated") {
            return "warn";
        }
        "ffmpeg"
    }

    async fn on_stderr_line(&self, generation: u64, raw: &str) {
        enum Action {
            Skip,
            Log(String, String),
            LogAndDisconnect(String, String),
            Repeat(String, u64),
        }
        let action = {
            let mut core = self.lock();
            if generation != core.generation {
                return;
            }
            let line = raw.trim_end();
            if Self::is_noisy(line) {
                return;
            }
            if line == core.last_stderr_line {
                core.last_stderr_repeat += 1;
                if core.last_stderr_repeat % 50 == 0 {
                    Action::Repeat(line.to_string(), core.last_stderr_repeat + 1)
                } else {
                    Action::Skip
                }
            } else {
                core.last_stderr_line = line.to_string();
                core.last_stderr_repeat = 0;
                let level = Self::classify_stderr(line).to_string();
                let disconnects = regex::Regex::new(
                    r"Connection|Server error|Unauthorized|timed out|Broken pipe|Cannot open connection|av_interleaved_write_frame",
                )
                .expect("static regex")
                .is_match(line);
                if disconnects {
                    core.connected = false;
                    Action::LogAndDisconnect(level, line.to_string())
                } else {
                    Action::Log(level, line.to_string())
                }
            }
        };
        match action {
            Action::Skip => {}
            Action::Log(level, message) => self.log(&level, message),
            Action::LogAndDisconnect(level, message) => {
                self.log(&level, message);
                self.emit_status();
            }
            Action::Repeat(line, repeat) => {
                self.log("ffmpeg", format!("{line}  (×{repeat})"));
            }
        }
    }

    /// The single-process child exited.
    async fn on_close(self: &Arc<Self>, generation: u64, index: usize, code: Option<i32>) {
        {
            let mut core = self.lock();
            if generation != core.generation {
                return;
            }
            core.child = None;
            core.connected = false;
            if core.stopping {
                drop(core);
                self.emit_status();
                return;
            }
        }
        let settings = (self.deps.get_settings)();
        let (item_duration, position_sec) = {
            let core = self.lock();
            (core.item_duration, core.position_sec)
        };
        // A publish that ends on its own had nothing left to send, so it counts
        // as finishing the file. This must not depend solely on positionSec:
        // the last report of a short tail (after a seek, or a file whose last
        // block is cut mid-second) can sit just under the end.
        let reached_end = item_duration > 0.0 && position_sec >= item_duration - COMPLETION_TOLERANCE_SEC;
        let clean_exit = code == Some(0);

        if reached_end || clean_exit {
            let duration = self.lock().items.get(index).map(|i| i.duration_sec).unwrap_or(0.0);
            let name = self
                .lock()
                .items
                .get(index)
                .map(|i| i.name.clone())
                .unwrap_or_else(|| self.t("main.engine.file"));
            {
                let mut core = self.lock();
                Self::set_item_status_locked(&mut core, index, "done", None);
                core.completed_sec = Self::sum_durations_before(&core, index as i64) + duration;
                core.position_sec = duration;
            }
            self.emit_playlist();
            self.emit_status();
            self.log("info", self.t_params("main.engine.itemDone", vec![("name", name)]));
            // Single-process only: each file is its own publish session, so the
            // server needs a moment to release the stream key before the next
            // publish takes it. The buffered pipeline never republishes at a
            // file change and does not wait at all.
            {
                let mut core = self.lock();
                core.state = "preparing".into();
            }
            self.emit_status();
            let this = Arc::clone(self);
            let rx = {
                let mut core = self.lock();
                Self::set_timer(&mut core, TimerSlot::Restart, REPUBLISH_DELAY_MS)
            };
            tokio::spawn(async move {
                if rx.await.is_ok() {
                    let ok = {
                        let core = this.lock();
                        generation == core.generation && !core.stopping
                    };
                    if ok {
                        this.advance_to_boxed(index + 1, "finish".into()).await;
                    }
                }
            });
            return;
        }

        /* Premature exit: attempt reconnection. */
        let unknown = self.t("main.engine.unknown");
        let detail = match code {
            None => self.t_params("main.engine.signal", vec![("name", unknown.clone())]),
            Some(c) => self.t_params("main.engine.exitCode", vec![("code", c.to_string())]),
        };
        if settings.output.max_reconnect_attempts <= 0.0
            || (self.lock().reconnect_count as f64) >= settings.output.max_reconnect_attempts
        {
            self.log("error", self.t_params("main.engine.crashNoRetry", vec![("detail", detail.clone())]));
            {
                let mut core = self.lock();
                Self::set_item_status_locked(
                    &mut core,
                    index,
                    "error",
                    Some(self.t_params("main.engine.crashDetail", vec![("detail", detail.clone())])),
                );
                core.state = "error".into();
                Self::cancel_timers(&mut core);
                core.generation += 1;
                core.encoder_pass = None;
                core.encoder_index = -1;
                core.encoder_item_duration = 0.0;
                core.started_at = None;
                // Terminal: nothing will advance the queue, so the progress bar
                // and the live figures go back to zero like any other end of
                // session.
                Self::reset_viewer_timeline(&mut core);
                Self::reset_session_stats(&mut core);
            }
            self.emit_playlist();
            self.emit_status();
            return;
        }

        let count = {
            let mut core = self.lock();
            core.reconnect_count += 1;
            core.reconnect_count
        };
        let delay_ms = (settings.output.reconnect_delay_sec.max(1.0) * 1000.0) as u64;
        {
            let mut core = self.lock();
            core.state = "reconnecting".into();
        }
        self.emit_status();
        self.log(
            "warn",
            self.t_params(
                "main.engine.reconnecting",
                vec![
                    ("detail", detail.clone()),
                    ("delay", format!("{}", delay_ms as f64 / 1000.0)),
                    ("time", format_duration(position_sec)),
                    ("n", count.to_string()),
                    ("max", (settings.output.max_reconnect_attempts as i64).to_string()),
                ],
            ),
        );
        let this = Arc::clone(self);
        let rx = {
            let mut core = self.lock();
            Self::set_timer(&mut core, TimerSlot::Reconnect, delay_ms)
        };
        tokio::spawn(async move {
            if rx.await.is_ok() {
                let ok = {
                    let core = this.lock();
                    generation == core.generation && !core.stopping
                };
                if ok {
                    let position = (this.lock().position_sec - 1.0).max(0.0);
                    if let Err(err) = this.launch_from_boxed(index, position, "retry".into()).await {
                        this.fail_launch(err);
                    }
                }
            }
        });
    }

    /* ------------------------------------------------------------ *
     * External helpers
     * ------------------------------------------------------------ */

    /// The entry the preview should describe: the ENCODER's entry, not the
    /// viewer's — this answers "what is this app encoding right now". Falls
    /// back to the viewer's entry (and then to the first one) before any
    /// encoder pass has been started.
    fn encoder_item(core: &EngineCore) -> Option<PlaylistItem> {
        let idx = if core.encoder_index >= 0 {
            core.encoder_index as usize
        } else if core.current_index >= 0 {
            core.current_index as usize
        } else {
            0
        };
        core.items.get(idx).or_else(|| core.items.first()).cloned()
    }

    pub fn get_command_preview(&self) -> String {
        let settings = (self.deps.get_settings)();
        let secrets = crate::log_redact::collect_secrets(Some(&settings.output));
        let saved = {
            let core = self.lock();
            if !core.command_line.is_empty() {
                Some(crate::log_redact::redact_text(&core.command_line, &secrets))
            } else {
                None
            }
        };
        if let Some(saved) = saved {
            return saved;
        }
        let item = {
            let core = self.lock();
            Self::encoder_item(&core)
        };
        let Some(item) = item else {
            return self.t("main.engine.previewEmpty");
        };
        let media = (self.deps.get_media)(&item.path);
        let Some(media) = media else {
            return self.t("main.engine.previewProbing");
        };
        match build_stream_command(&BuildRequest {
            ffmpeg_path: {
                let p = (self.deps.get_ffmpeg_path)();
                if p.is_empty() { "ffmpeg".into() } else { p }
            },
            media,
            item,
            settings: settings.clone(),
            start_position_sec: 0.0,
            output_override: None,
            language: Some((self.deps.get_language)()),
        }) {
            Ok(command) => {
                // The buffered pipeline actually runs two processes (encoder +
                // publisher); this preview is the single-process equivalent,
                // and it says so rather than pretending.
                let note = if buffered_mode(&settings.output) {
                    format!("{}\n", self.t("main.engine.previewBufferedEquivalent"))
                } else {
                    String::new()
                };
                crate::log_redact::redact_text(&format!("{note}{}", command.command_line), &secrets)
            }
            Err(err) => self.t_params("main.engine.previewFailed", vec![("error", err)]),
        }
    }
}
