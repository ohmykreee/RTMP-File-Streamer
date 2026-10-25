//! Two-process playout: an encoder writes MPEG-TS segments, a long-lived pusher
//! publishes them. Port of `src/main/stream/playout.ts`.
//!
//!   encoder ffmpeg --(MPEG-TS on stdout)--> relay --> pusher stdin --(-re)--> RTMP
//!
//! Porting notes (differences from the Node original, same observable behavior):
//!  - The Node relay relied on libuv's in-memory stdin write queue and its
//!    `drain` events; here a dedicated writer task owns the pusher's stdin and
//!    drains an in-memory pending queue with `write_all().await`, which is the
//!    same "accept everything, write at pipe speed" backpressure shape.
//!  - The encoder's stdout pause is a hold flag polled by the relay loop: not
//!    reading lets the OS pipe fill, which blocks ffmpeg in `write()` exactly
//!    like the paused Node stream did.
//!  - `-progress pipe:3` needs a real fd 3, which Rust's std/tokio cannot hand
//!    an extra pipe on Windows; the progress channel is instead
//!    `-progress tcp://127.0.0.1:<ephemeral port>`, one listener per process.
//!    The data (key=value lines) and its cadence are identical.
//!  - Every ffmpeg process is owned by a supervisor task that waits for its
//!    exit and receives kill requests over a channel, so a replaced process is
//!    killed promptly while its exit is still attributed to the right pass.

use crate::shared::i18n::EN;
use crate::stream::byte_rate::{now_ms, ByteRateMeter};
use crate::stream::supervisor::{spawn_supervised, Supervisor};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, Notify};

/// MPEG-TS packets are fixed size; the relay must never split one.
const TS_PACKET: usize = 188;
/// Safety margin added to the timeline offset of every pass after the first.
const PASS_SPLICE_MARGIN_SEC: f64 = 0.05;
/// How much of the buffer is spent before a held encoder is released again.
fn lead_release_margin_sec(lead_limit_sec: f64) -> f64 {
    (4.0f64).max(lead_limit_sec * 0.25)
}
/// A hold that outlives this is a publisher that has stopped sending.
fn lead_hold_backstop_sec(lead_limit_sec: f64) -> f64 {
    lead_limit_sec * 2.0 + 10.0
}
/// How often the buffered pipeline reports its own health.
const HEALTH_INTERVAL_MS: f64 = 30_000.0;
/// Head start the encoder gets over the publisher on a first start, in ms.
const PUSHER_HEAD_START_MS: u64 = 600;
/// The same head start after a publisher failure or a skip: longer, because the
/// server has to release the previous publish session before a new one can
/// take the key.
const PUSHER_HEAD_START_RETRY_MS: u64 = 1500;
/// Production below this share of real time starves the publisher.
const HEALTH_MIN_RATE: f64 = 0.98;
/// How long the publisher may go without reporting progress before it counts
/// as blocked rather than merely pacing.
const PUSHER_SILENCE_WARN_SEC: f64 = 5.0;
/// Prefix of this class's scratch folders in the OS temp area.
const TEMP_PREFIX: &str = "rtmp-streamer-";

/// Message lookup for this class's log lines; defaults to the reference
/// language (the TS version does the same when no `t` is injected).
pub type TranslateFn = Arc<dyn Fn(&str, Vec<(&'static str, String)>) -> String + Send + Sync>;

#[allow(dead_code)] // parity with the TS default when no t is injected
fn default_t(key: &str, _params: Vec<(&'static str, String)>) -> String {
    EN.get(key).cloned().unwrap_or_else(|| key.to_string())
}

/// Events the playout reports to the engine.
#[derive(Debug, Clone)]
pub enum PlayoutEvent {
    Log(String, String), // level, message
    Published(f64),
    PusherExit(Option<i32>),
    EncoderExit(Option<i32>, f64),
}

#[derive(Clone)]
pub struct PlayoutCallbacks {
    pub tx: mpsc::UnboundedSender<PlayoutEvent>,
    pub t: TranslateFn,
}

impl PlayoutCallbacks {
    fn log(&self, level: &str, key: &str, params: Vec<(&'static str, String)>) {
        let _ = self.tx.send(PlayoutEvent::Log(level.into(), (self.t)(key, params)));
    }
    fn log_raw(&self, level: &str, message: String) {
        let _ = self.tx.send(PlayoutEvent::Log(level.into(), message));
    }
}

#[derive(Clone)]
pub struct EncoderPass {
    /// Absolute path of the source file to encode.
    pub input: String,
    /// Extra inputs (generated silence / black frames) for tracks the file lacks.
    pub inputs: Vec<String>,
    /// Extra input/output arguments (filters, mapping, encoder options).
    pub args: Vec<String>,
    /// Where to start inside the source, in seconds.
    pub start_position_sec: f64,
    /// A/V offset applied to the source input (`-itsoffset`), in seconds.
    pub input_offset_sec: f64,
    /// Timeline value the pass must start at, so the stream stays continuous.
    pub ts_offset: f64,
    /// Identity of this pass, assigned by `start_encoder`.
    pub seq: u64,
}

struct PlayoutState {
    pusher: Option<Supervisor>,
    pusher_pending: bool,
    encoder: Option<Supervisor>,
    current_encoder_seq: u64,
    current_pusher_epoch: u64,
    seq: u64,
    next_offset: f64,
    published_sec: f64,
    encoded_sec: f64,
    enc_speed: f64,
    enc_fps: f64,
    enc_bitrate: f64,
    pass_offset_sec: f64,
    stopping: bool,
    current_pass: Option<EncoderPass>,
    encoder_held: bool,
    hold_started_at: f64,
    hold_epoch: u64,
    hold_reported: bool,
    burst_from_sec: f64,
    burst_from_ms: f64,
    hold_count: u64,
    health_at: f64,
    health_encoded_sec: f64,
    health_published_sec: f64,
    health_wall_ms: f64,
    low_rate_windows: u64,
    pusher_speed: f64,
    pusher_sent_bytes: f64,
    network_rate: ByteRateMeter,
    pusher_last_report_at: f64,
    pusher_silence_reported: bool,
    epoch: u64,
    pending: VecDeque<Vec<u8>>,
    pending_len: usize,
    carry: Vec<u8>,
    relayed_bytes: u64,
    pumped_bytes: u64,
    pass_material: HashMap<u64, f64>,
    ts_pts_first: f64,
    ts_pts_last: f64,
    ts_pts_packets: u64,
    ts_pts_video_headers: u64,
    dir: std::path::PathBuf,
}

pub struct Playout {
    ffmpeg_path: String,
    output_args: Vec<String>,
    lead_limit_sec: f64,
    callbacks: PlayoutCallbacks,
    state: Mutex<PlayoutState>,
    writer_notify: Notify,
}

static STALE_SWEPT: AtomicBool = AtomicBool::new(false);

/// Removes scratch folders a previous run left behind (older than an hour),
/// bounding the leak without touching anything that is not ours.
fn sweep_stale_temp_dirs() {
    if STALE_SWEPT.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(tmp) = std::env::temp_dir().read_dir() else { return };
    let cutoff = now_ms() - 60.0 * 60.0 * 1000.0;
    for entry in tmp.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(TEMP_PREFIX) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        if now_ms() - modified < cutoff {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// Rounds a pass offset up to the millisecond ffmpeg is given, plus the margin.
fn pass_start_offset(ts_offset: f64) -> f64 {
    ((ts_offset + PASS_SPLICE_MARGIN_SEC) * 1000.0).ceil() / 1000.0
}

fn format_num(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/// Binds an ephemeral loopback listener for `-progress tcp://…`.
async fn progress_listener() -> std::io::Result<TcpListener> {
    TcpListener::bind("127.0.0.1:0").await
}

impl Playout {
    pub fn new(ffmpeg_path: String, output_args: Vec<String>, lead_limit_sec: f64, callbacks: PlayoutCallbacks) -> Arc<Self> {
        sweep_stale_temp_dirs();
        let dir = {
            let base = std::env::temp_dir();
            let mut n = 0u32;
            loop {
                let candidate = base.join(format!("{TEMP_PREFIX}{}-{n:x}", now_ms() as u64));
                match std::fs::create_dir(&candidate) {
                    Ok(()) => break candidate,
                    Err(_) if n < 100 => n += 1,
                    Err(_) => break base.join(format!("{TEMP_PREFIX}fallback")),
                }
            }
        };
        Arc::new(Self {
            ffmpeg_path,
            output_args,
            lead_limit_sec: lead_limit_sec.max(0.0),
            callbacks,
            state: Mutex::new(PlayoutState {
                pusher: None,
                pusher_pending: false,
                encoder: None,
                current_encoder_seq: 0,
                current_pusher_epoch: 0,
                seq: 0,
                next_offset: 0.0,
                published_sec: 0.0,
                encoded_sec: 0.0,
                enc_speed: 0.0,
                enc_fps: 0.0,
                enc_bitrate: 0.0,
                pass_offset_sec: 0.0,
                stopping: false,
                current_pass: None,
                encoder_held: false,
                hold_started_at: 0.0,
                hold_epoch: 0,
                hold_reported: false,
                burst_from_sec: 0.0,
                burst_from_ms: 0.0,
                hold_count: 0,
                health_at: 0.0,
                health_encoded_sec: 0.0,
                health_published_sec: 0.0,
                health_wall_ms: 0.0,
                low_rate_windows: 0,
                pusher_speed: 0.0,
                pusher_sent_bytes: 0.0,
                network_rate: ByteRateMeter::new(),
                pusher_last_report_at: 0.0,
                pusher_silence_reported: false,
                epoch: 0,
                pending: VecDeque::new(),
                pending_len: 0,
                carry: Vec::new(),
                relayed_bytes: 0,
                pumped_bytes: 0,
                pass_material: HashMap::new(),
                ts_pts_first: f64::NAN,
                ts_pts_last: f64::NAN,
                ts_pts_packets: 0,
                ts_pts_video_headers: 0,
                dir,
            }),
            writer_notify: Notify::new(),
        })
    }

    /* ------------------------------------------------------------ *
     * Lifecycle
     * ------------------------------------------------------------ */

    /// Starts the publisher and the first encoder pass: the encoder goes first
    /// and the publisher follows a fixed, short moment later (see
    /// `PUSHER_HEAD_START_MS`).
    pub async fn start(self: &Arc<Self>, pass: EncoderPass, retry: bool) {
        let epoch = {
            let mut st = self.state.lock().expect("playout state lock");
            // A publisher that has already exited is NOT a running publisher:
            // keeping the handle would silently swallow every later pass.
            if Self::pusher_running(&st) {
                return;
            }
            st.epoch += 1;
            let epoch = st.epoch;
            st.pusher = None;
            st.stopping = false;
            // A session is being opened: from here until the publisher exists,
            // "no pusher yet" must not read as "the session is over".
            st.pusher_pending = true;
            epoch
        };
        // The encoder goes first; its output is read and queued as it comes.
        self.start_encoder(pass).await;
        let wait_ms = if retry { PUSHER_HEAD_START_RETRY_MS } else { PUSHER_HEAD_START_MS };
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
        {
            let st = self.state.lock().expect("playout state lock");
            // A stop, a skip/jump restart or another start may have happened
            // during the head start. `stopping` alone is not enough:
            // `restart_session` clears it again before calling here, which is
            // how the old start woke up and created a second publisher.
            if st.stopping || st.epoch != epoch {
                return;
            }
        }
        self.start_pusher().await;
    }

    /// Replaces the encoder pass; the pusher (and the RTMP session) is untouched.
    pub async fn restart_encoder(self: &Arc<Self>, pass: EncoderPass) {
        self.kill_encoder().await;
        self.start_encoder(pass).await;
    }

    /// Throws the buffer away and starts a BRAND NEW RTMP session for `pass`.
    /// This is what a skip or a jump uses: the material the viewer asked for is
    /// usually already inside the buffer behind content they have not watched,
    /// and a published timeline can only move forward.
    pub async fn restart_session(self: &Arc<Self>, pass: EncoderPass) {
        {
            let mut st = self.state.lock().expect("playout state lock");
            // Invalidate a head start that is still waiting from the previous
            // start: that timer is exactly what used to create a second
            // publisher behind the new one.
            st.epoch += 1;
        }
        // The encoder goes first, before anything is awaited: killing it stops
        // the abandoned file from being relayed and its completion from being
        // reported against the wrong pass.
        self.kill_encoder().await;
        // Forced: the buffered audio/video is being thrown away, so there is
        // nothing to flush and no reason to wait for a polite session end.
        self.stop_pusher(true).await;
        {
            let mut st = self.state.lock().expect("playout state lock");
            // New session, new timeline: the counters describe the session that
            // just ended.
            st.next_offset = 0.0;
            st.published_sec = 0.0;
            st.encoded_sec = 0.0;
            st.pending.clear();
            st.pending_len = 0;
            st.carry = Vec::new();
            st.relayed_bytes = 0;
            st.pumped_bytes = 0;
            // The byte counter restarts with the new publisher.
            st.network_rate.reset();
            st.pusher_sent_bytes = 0.0;
            st.pass_material.clear();
            st.ts_pts_first = f64::NAN;
            st.ts_pts_last = f64::NAN;
            st.ts_pts_packets = 0;
            st.ts_pts_video_headers = 0;
            st.stopping = false;
        }
        self.callbacks.log("info", "main.engine.bufferDropped", vec![]);
        self.start(pass, true).await;
    }

    /// Stops both processes and removes the scratch directory.
    pub async fn stop(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().expect("playout state lock");
            st.epoch += 1;
            st.stopping = true;
        }
        self.kill_encoder().await;
        self.stop_pusher(false).await;
        self.cleanup();
    }

    /// Ends the publish session and waits for the process to be gone. Closing
    /// stdin makes the pusher flush and leave the session cleanly; the kill is
    /// the backstop for a publisher wedged on a dead socket.
    async fn stop_pusher(self: &Arc<Self>, forced: bool) {
        let supervisor = {
            let mut st = self.state.lock().expect("playout state lock");
            st.epoch += 1;
            st.pusher_pending = false;
            // The slot is gone, so this publisher's exit must never be reported
            // as the session dying — the same reason the TS original nulls the
            // pusher slot before the kill. A skip/jump kills its publisher to
            // replace it; reporting that death made the engine tear down the
            // playout the restart had just opened and reconnect for no reason.
            // (kill_encoder clears `current_encoder_seq` for the same effect.)
            st.current_pusher_epoch = 0;
            st.pusher.take()
        };
        self.writer_notify.notify_waiters(); // wake the writer so it drops stdin
        let Some(supervisor) = supervisor else { return };
        if supervisor.has_exited() {
            return;
        }
        if forced {
            supervisor.kill();
        } else {
            // Dropping the stdin handle (the writer task exits on the epoch
            // change) is what makes the pusher read EOF and flush.
            self.writer_notify.notify_waiters();
        }
        if supervisor.wait_exited(2500).await.is_none() && !supervisor.has_exited() {
            supervisor.kill();
        }
    }

    fn pusher_running(st: &PlayoutState) -> bool {
        st.pusher.as_ref().map(|p| !p.has_exited()).unwrap_or(false)
    }

    /* ------------------------------------------------------------ *
     * Read-only figures
     * ------------------------------------------------------------ */

    /// Live figures of the encoder process: (speed, fps, bitrateKbps, leadSec).
    pub fn get_encoder_stats(&self) -> (f64, f64, f64, f64) {
        let st = self.state.lock().expect("playout state lock");
        (st.enc_speed, st.enc_fps, st.enc_bitrate, (st.encoded_sec - st.published_sec).max(0.0))
    }

    /// Byte counters for the relay path:
    /// (relayedBytes, pumpedBytes, pendingBytes, carryBytes).
    pub fn get_relay_stats(&self) -> (u64, u64, usize, usize) {
        let st = self.state.lock().expect("playout state lock");
        (st.relayed_bytes, st.pumped_bytes, st.pending_len, st.carry.len())
    }

    /// Session-timeline position the encoder has reached, in seconds.
    pub fn get_encoded_sec(&self) -> f64 {
        let st = self.state.lock().expect("playout state lock");
        st.next_offset.max(st.encoded_sec)
    }

    /// Where the pusher has published up to (seconds on the session timeline).
    pub fn get_published_sec(&self) -> f64 {
        let st = self.state.lock().expect("playout state lock");
        st.published_sec
    }

    /// What the publish session is putting on the wire, in kbit/s (0 = none yet).
    pub fn get_network_kbps(&self) -> f64 {
        let st = self.state.lock().expect("playout state lock");
        st.network_rate.kbps(now_ms())
    }

    /// The timeline value the next pass will start at.
    pub fn get_next_offset(&self) -> f64 {
        let st = self.state.lock().expect("playout state lock");
        st.next_offset
    }

    pub fn is_pusher_running(&self) -> bool {
        let st = self.state.lock().expect("playout state lock");
        Self::pusher_running(&st)
    }

    /// Whether a publish session exists: the publisher is up, or its head start
    /// is running. This — not `is_pusher_running` — is what "there is still
    /// something to air" means to the engine.
    pub fn is_session_active(&self) -> bool {
        let st = self.state.lock().expect("playout state lock");
        st.pusher_pending || Self::pusher_running(&st)
    }

    /* ------------------------------------------------------------ *
     * Timeline accounting
     * ------------------------------------------------------------ */

    fn publish_segment(st: &mut PlayoutState, duration_sec: f64) {
        st.next_offset += duration_sec.max(0.001);
    }

    fn cleanup(&self) {
        let dir = self.state.lock().expect("playout state lock").dir.clone();
        let _ = std::fs::remove_dir_all(dir);
    }

    /* ------------------------------------------------------------ *
     * Pusher
     * ------------------------------------------------------------ */

    async fn start_pusher(self: &Arc<Self>) {
        let listener = progress_listener().await.ok();
        let port = listener.as_ref().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(0);

        let mut args: Vec<String> = [
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "info",
            // `-re` on the *input* is what paces publication: the encoder may be
            // seconds ahead, the viewer still receives exactly one second per
            // second.
            "-re",
            "-f",
            "mpegts",
            "-i",
            "pipe:0",
            "-c",
            "copy",
            "-max_interleave_delta",
            "0",
            // Progress on its own channel so stderr stays ffmpeg's log.
            "-progress",
            &format!("tcp://127.0.0.1:{port}"),
            "-nostats",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        args.extend(self.output_args.iter().cloned());
        self.callbacks.log_raw(
            "debug",
            (self.callbacks.t)("main.engine.publisherCmd", vec![("args", args.join(" "))]),
        );

        let mut cmd = Command::new(&self.ffmpeg_path);
        cmd.args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }

        let spawn_result = cmd.stdin(std::process::Stdio::piped()).spawn();
        let mut child = match spawn_result {
            Ok(c) => c,
            Err(err) => {
                self.callbacks.log("error", "main.playout.processError", vec![("error", err.to_string())]);
                let mut st = self.state.lock().expect("playout state lock");
                st.pusher_pending = false;
                return;
            }
        };
        let stdin: ChildStdin = child.stdin.take().expect("pusher stdin piped");
        let stderr = child.stderr.take().expect("pusher stderr piped");

        let epoch;
        {
            let mut st = self.state.lock().expect("playout state lock");
            epoch = st.epoch;
            st.current_pusher_epoch = epoch;
            st.pusher_pending = false;
            st.pusher_last_report_at = 0.0;
            st.pusher_silence_reported = false;
            st.pusher_speed = 0.0;
            st.pusher_sent_bytes = 0.0;
            st.health_at = 0.0;
        }
        self.callbacks.log_raw(
            "info",
            (self.callbacks.t)("main.engine.publisherStarted", vec![("pid", "0".to_string())]),
        );

        let supervisor = spawn_supervised(child, {
            let this = Arc::clone(self);
            move |code| {
                // Only the publisher that is still current owns this session: a
                // stop/restart clears the slot, which keeps its late close from
                // being reported as a lost stream.
                let (was_current, stopping) = {
                    let mut st = this.state.lock().expect("playout state lock");
                    let was_current = st.current_pusher_epoch == epoch;
                    if was_current {
                        st.pusher = None;
                    }
                    (was_current, st.stopping)
                };
                if !was_current || stopping {
                    return;
                }
                this.callbacks.log(
                    "warn",
                    "main.engine.publisherExited",
                    vec![(
                        "code",
                        code.map(|c| c.to_string()).unwrap_or_else(|| (this.callbacks.t)("main.engine.unknown", vec![])),
                    )],
                );
                let _ = this.callbacks.tx.send(PlayoutEvent::PusherExit(code));
            }
        });
        self.state.lock().expect("playout state lock").pusher = Some(supervisor);

        // Writer task: drains the pending queue into the pusher's stdin at pipe
        // speed. This is the process that owns the RTMP session's input, and it
        // outlives every encoder pass. It exits when the epoch moves on (its
        // stdin drop is what gives the pusher EOF on a clean stop).
        {
            let this = Arc::clone(self);
            let writer_epoch = epoch;
            tokio::spawn(async move {
                let mut stdin = Some(stdin);
                loop {
                    // Wait for data or the end of this publish session.
                    loop {
                        let has_data = {
                            let st = this.state.lock().expect("playout state lock");
                            st.epoch != writer_epoch || !st.pending.is_empty() || st.stopping
                        };
                        if has_data {
                            break;
                        }
                        tokio::select! {
                            _ = this.writer_notify.notified() => {}
                            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                        }
                    }
                    {
                        let st = this.state.lock().expect("playout state lock");
                        if st.epoch != writer_epoch {
                            break; // dropping `stdin` gives the pusher EOF
                        }
                    }
                    let chunk = {
                        let mut st = this.state.lock().expect("playout state lock");
                        st.pending.pop_front().map(|c| {
                            st.pending_len -= c.len();
                            c
                        })
                    };
                    let Some(chunk) = chunk else { continue };
                    let Some(mut pipe) = stdin.take() else { break };
                    match pipe.write_all(&chunk).await {
                        Ok(()) => {
                            stdin = Some(pipe);
                            let mut st = this.state.lock().expect("playout state lock");
                            st.pumped_bytes += chunk.len() as u64;
                        }
                        Err(err) => {
                            // Dropping `pipe` here closes stdin; the publisher reads
                            // a failed pipe as a clean end of stream, so it exits 0
                            // and the engine sees "the RTMP session ended" — that
                            // silent path is reported as an error.
                            drop(pipe);
                            let st = this.state.lock().expect("playout state lock");
                            let intentional = st.stopping || st.epoch != writer_epoch;
                            drop(st);
                            if !intentional {
                                this.callbacks.log(
                                    "error",
                                    "main.playout.writeFailed",
                                    vec![("code", err.to_string())],
                                );
                            }
                            // The chunk in flight is lost (as in the TS pump, which
                            // also drops it on a failed write); the rest stays queued
                            // until the engine tears the playout down.
                            let mut st = this.state.lock().expect("playout state lock");
                            st.pending.clear();
                            st.pending_len = 0;
                            return;
                        }
                    }
                }
            });
        }

        // Progress reader: the pusher's own timeline is the session timeline.
        if let Some(listener) = listener {
            let this = Arc::clone(self);
            let epoch2 = epoch;
            tokio::spawn(async move {
                let Ok((stream, _)) = listener.accept().await else { return };
                let mut lines = BufReader::new(stream).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let current = {
                                let st = this.state.lock().expect("playout state lock");
                                st.current_pusher_epoch == epoch2
                            };
                            if !current {
                                return;
                            }
                            this.on_pusher_output_line(&line);
                        }
                        _ => return,
                    }
                }
            });
        }

        // Log reader: the pusher's own log is where RTMP failures surface.
        {
            let this = Arc::clone(self);
            let epoch2 = epoch;
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let is_current = {
                                let st = this.state.lock().expect("playout state lock");
                                st.current_pusher_epoch == epoch2
                            };
                            if !is_current {
                                return;
                            }
                            this.on_pusher_log_line(&line);
                        }
                        _ => return,
                    }
                }
            });
        }

        // Health/silence check, independent of publisher progress.
        {
            let this = Arc::clone(self);
            let epoch2 = epoch;
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    let alive = {
                        let st = this.state.lock().expect("playout state lock");
                        st.epoch == epoch2 && !st.stopping
                    };
                    if !alive {
                        return;
                    }
                    this.report_health();
                }
            });
        }

        // Hand over whatever the encoder produced during the head start.
        self.writer_notify.notify_waiters();
    }

    /* ------------------------------------------------------------ *
     * Relay: encoder stdout -> pending queue -> publisher stdin
     * ------------------------------------------------------------ */

    async fn start_encoder(self: &Arc<Self>, mut pass: EncoderPass) {
        let seq = {
            let mut st = self.state.lock().expect("playout state lock");
            st.seq += 1;
            let seq = st.seq;
            pass.seq = seq;
            st.pass_offset_sec = pass.ts_offset;
            // A fresh pass starts unheld, whatever the pass before it was doing.
            st.hold_epoch += 1;
            st.encoder_held = false;
            st.hold_reported = false;
            // A fresh encoder starts on a packet boundary; a half-packet left by
            // the previous process must never be prepended to it.
            st.carry = Vec::new();
            st.burst_from_sec = st.encoded_sec;
            st.burst_from_ms = now_ms();
            st.current_pass = Some(EncoderPass {
                input: pass.input.clone(),
                inputs: pass.inputs.clone(),
                args: pass.args.clone(),
                start_position_sec: pass.start_position_sec,
                input_offset_sec: pass.input_offset_sec,
                ts_offset: pass.ts_offset,
                seq,
            });
            seq
        };

        let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "info"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // Per-item A/V offset: `build_encoder_args` returned it instead of
        // applying it itself because the caller owns the source input.
        if pass.input_offset_sec.abs() > 0.0005 {
            args.push("-itsoffset".into());
            args.push(format!("{}", round2(pass.input_offset_sec)));
        }
        if pass.start_position_sec > 0.05 {
            args.push("-ss".into());
            args.push(format!("{}", round2(pass.start_position_sec)));
            args.push("-noaccurate_seek".into());
        }
        args.push("-fflags".into());
        args.push("+genpts".into());
        args.push("-i".into());
        args.push(pass.input.clone());
        // Generated stand-in tracks are inputs of their own, after the file.
        args.extend(pass.inputs.iter().cloned());
        // Stream selection belongs to `pass.args`.
        args.extend(pass.args.iter().cloned());
        // Every pass must OPEN on a keyframe: the seam between two passes is a
        // splice mid-stream, and forcing frame 0 of each pass to be an IDR makes
        // the seam decodable.
        args.push("-force_key_frames".into());
        args.push("expr:eq(n,0)".into());
        // The viewer's timeline must not step backwards when a pass is replaced.
        // The offset is rounded UP and carries a margin (see `pass_start_offset`).
        if pass.ts_offset > 0.0 {
            args.push("-output_ts_offset".into());
            args.push(format_num(pass_start_offset(pass.ts_offset)));
        }
        args.push("-muxdelay".into());
        args.push("0".into());
        args.push("-muxpreload".into());
        args.push("0".into());
        // Keep the MPEG-TS program identity identical in every pass, so two
        // consecutive passes look like one uninterrupted program.
        args.push("-mpegts_start_pid".into());
        args.push("256".into());
        args.push("-mpegts_pmt_start_pid".into());
        args.push("4096".into());
        args.push("-mpegts_service_id".into());
        args.push("1".into());
        args.push("-mpegts_service_type".into());
        args.push("digital_tv".into());
        args.push("-mpegts_flags".into());
        args.push("+resend_headers".into());
        // The span this pass contributes has to be measured; it goes to its own
        // channel, NEVER to stdout (fd 1 carries the MPEG-TS itself).
        let listener = progress_listener().await.ok();
        let port = listener.as_ref().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(0);
        args.push("-progress".into());
        args.push(format!("tcp://127.0.0.1:{port}"));
        args.push("-nostats".into());
        args.push("-flush_packets".into());
        args.push("1".into());
        args.push("-f".into());
        args.push("mpegts".into());
        args.push("pipe:1".into());

        self.callbacks.log_raw(
            "debug",
            (self.callbacks.t)("main.engine.encoderCmd", vec![("seq", seq.to_string()), ("args", args.join(" "))]),
        );
        {
            let mut st = self.state.lock().expect("playout state lock");
            st.ts_pts_first = f64::NAN;
            st.ts_pts_last = f64::NAN;
            st.ts_pts_packets = 0;
            st.ts_pts_video_headers = 0;
        }

        let mut cmd = Command::new(&self.ffmpeg_path);
        cmd.args(&args)
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
                self.callbacks.log("error", "main.playout.encoderProcessError", vec![("error", err.to_string())]);
                return;
            }
        };
        let stdout = child.stdout.take().expect("encoder stdout piped");
        let stderr = child.stderr.take().expect("encoder stderr piped");
        {
            let mut st = self.state.lock().expect("playout state lock");
            st.current_encoder_seq = seq;
        }
        self.callbacks.log_raw(
            "info",
            (self.callbacks.t)("main.engine.encoderStarted", vec![("seq", seq.to_string()), ("pid", "0".to_string())]),
        );

        let supervisor = spawn_supervised(child, {
            let this = Arc::clone(self);
            move |code| {
                let (was_current, stopping) = {
                    let mut st = this.state.lock().expect("playout state lock");
                    let was_current = st.current_encoder_seq == seq;
                    if was_current {
                        st.encoder = None;
                    }
                    (was_current, st.stopping)
                };
                if stopping || !was_current {
                    return;
                }
                // The pass is complete (or died): account for what it produced.
                // The publisher keeps reading the socket either way.
                let pass = this.state.lock().expect("playout state lock").current_pass.clone();
                this.finish_pass(pass, code);
            }
        });
        self.state.lock().expect("playout state lock").encoder = Some(supervisor);

        // Relay loop: the ONLY reader of the transport stream, which is never
        // decoded as text. While a hold is in effect it stops reading, which
        // lets the OS pipe fill and blocks ffmpeg in write() — the same
        // backpressure the paused Node stream provided.
        {
            let this = Arc::clone(self);
            let my_seq = seq;
            tokio::spawn(async move {
                let mut reader = stdout;
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let (held, stopping) = {
                        let st = this.state.lock().expect("playout state lock");
                        (st.encoder_held, st.stopping || st.current_encoder_seq != my_seq)
                    };
                    if stopping {
                        return;
                    }
                    if held {
                        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                        continue;
                    }
                    match reader.read(&mut buf).await {
                        Ok(0) => return,
                        Ok(n) => {
                            {
                                let st = this.state.lock().expect("playout state lock");
                                if st.current_encoder_seq != my_seq || st.stopping {
                                    return;
                                }
                            }
                            this.relay(&buf[..n]);
                            this.update_encoder_hold();
                        }
                        Err(_) => return,
                    }
                }
            });
        }

        // Progress reader: how much material the pass has produced, which is
        // what the next pass must offset its timeline by.
        if let Some(listener) = listener {
            let this = Arc::clone(self);
            let my_seq = seq;
            tokio::spawn(async move {
                let Ok((stream, _)) = listener.accept().await else { return };
                let mut lines = BufReader::new(stream).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let is_current = {
                                let st = this.state.lock().expect("playout state lock");
                                st.current_encoder_seq == my_seq
                            };
                            if !is_current {
                                return;
                            }
                            this.on_encoder_output_line(&line, my_seq);
                        }
                        _ => return,
                    }
                }
            });
        }

        // Log reader: a sample of the encoder's own log so failures stay diagnosable.
        {
            let this = Arc::clone(self);
            let my_seq = seq;
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let is_current = {
                                let st = this.state.lock().expect("playout state lock");
                                st.current_encoder_seq == my_seq
                            };
                            if !is_current {
                                return;
                            }
                            this.on_encoder_log_line(&line);
                        }
                        _ => return,
                    }
                }
            });
        }
    }

    /// Hands encoder bytes to the publisher, keeping MPEG-TS packets aligned.
    fn relay(self: &Arc<Self>, chunk: &[u8]) {
        let ready = {
            let mut st = self.state.lock().expect("playout state lock");
            // A session being torn down will never take another byte: queueing
            // here would only grow this process's memory with material nobody
            // can publish.
            if st.stopping {
                return;
            }
            let mut buf = std::mem::take(&mut st.carry);
            buf.extend_from_slice(chunk);
            // A pass boundary can land mid-packet, and forwarding a partial
            // 188-byte TS packet makes the reader report "Packet corrupt". The
            // remainder is held back and prepended to the next pass's first bytes.
            let whole = buf.len() - (buf.len() % TS_PACKET);
            st.carry = buf.split_off(whole);
            if whole == 0 {
                return;
            }
            buf
        };
        self.note_ts_pts(&ready);
        let mut st = self.state.lock().expect("playout state lock");
        st.relayed_bytes += ready.len() as u64;
        st.pending_len += ready.len();
        st.pending.push_back(ready);
        drop(st);
        self.writer_notify.notify_one();
    }

    /// Holds the encoder back while it is further ahead of the publisher than
    /// allowed. A hold ends when the publisher has actually drained the buffer
    /// back to the release mark — that feedback keeps the encoder at 1x on
    /// average, which a timer cannot do.
    fn update_encoder_hold(self: &Arc<Self>) {
        let lead = {
            let st = self.state.lock().expect("playout state lock");
            st.encoded_sec - st.published_sec
        };
        let held = self.state.lock().expect("playout state lock").encoder_held;
        if !held {
            if lead <= self.lead_limit_sec {
                return;
            }
            let (burst_sec, burst_wall_sec, seq) = {
                let mut st = self.state.lock().expect("playout state lock");
                st.encoder_held = true;
                st.hold_started_at = now_ms();
                st.hold_count += 1;
                st.hold_epoch += 1;
                let burst_wall = ((st.hold_started_at - st.burst_from_ms) / 1000.0).max(0.001);
                (st.encoded_sec - st.burst_from_sec, burst_wall, st.seq)
            };
            if !self.state.lock().expect("playout state lock").hold_reported {
                self.state.lock().expect("playout state lock").hold_reported = true;
                self.callbacks.log(
                    "debug",
                    "main.playout.leadHold",
                    vec![("lead", format!("{lead:.1}")), ("limit", format!("{:.1}", self.lead_limit_sec))],
                );
            }
            self.callbacks.log(
                "debug",
                "main.playout.leadBurst",
                vec![
                    ("seq", seq.to_string()),
                    ("burst", format!("{burst_sec:.1}")),
                    ("wall", format!("{burst_wall_sec:.2}")),
                    ("rate", format!("{:.1}", burst_sec / burst_wall_sec)),
                    ("lead", format!("{lead:.1}")),
                    (
                        "release",
                        format!("{:.1}", self.lead_limit_sec - lead_release_margin_sec(self.lead_limit_sec)),
                    ),
                ],
            );
            // Backstop only: a publisher that has stopped reporting cannot drain
            // anything, so the hold is lifted anyway after a generous timeout.
            let this = Arc::clone(self);
            let my_epoch = self.state.lock().expect("playout state lock").hold_epoch;
            let backstop_ms = (lead_hold_backstop_sec(self.lead_limit_sec) * 1000.0) as u64;
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(backstop_ms)).await;
                let should_fire = {
                    let st = this.state.lock().expect("playout state lock");
                    st.hold_epoch == my_epoch && st.encoder_held
                };
                if !should_fire {
                    return;
                }
                let (held_sec, lead) = {
                    let st = this.state.lock().expect("playout state lock");
                    ((now_ms() - st.hold_started_at) / 1000.0, st.encoded_sec - st.published_sec)
                };
                this.callbacks.log(
                    "warn",
                    "main.playout.holdBackstop",
                    vec![("held", format!("{held_sec:.1}")), ("lead", format!("{lead:.1}"))],
                );
                this.release_encoder_hold();
            });
            return;
        }
        if lead > self.lead_limit_sec - lead_release_margin_sec(self.lead_limit_sec) {
            return;
        }
        let held_sec = {
            let st = self.state.lock().expect("playout state lock");
            (now_ms() - st.hold_started_at) / 1000.0
        };
        self.release_encoder_hold();
        self.callbacks.log(
            "debug",
            "main.playout.holdReleased",
            vec![("lead", format!("{lead:.1}")), ("held", format!("{held_sec:.1}"))],
        );
    }

    /// Lifts a hold and starts the burst accounting for the next one.
    fn release_encoder_hold(self: &Arc<Self>) {
        let mut st = self.state.lock().expect("playout state lock");
        st.hold_epoch += 1;
        st.encoder_held = false;
        st.burst_from_sec = st.encoded_sec;
        st.burst_from_ms = now_ms();
    }

    /// Periodic account of what the buffered pipeline is actually doing.
    fn report_health(self: &Arc<Self>) {
        let now = now_ms();
        {
            let mut st = self.state.lock().expect("playout state lock");
            let silent_sec = if st.pusher_last_report_at > 0.0 {
                (now - st.pusher_last_report_at) / 1000.0
            } else {
                0.0
            };
            if silent_sec > PUSHER_SILENCE_WARN_SEC {
                if !st.pusher_silence_reported {
                    st.pusher_silence_reported = true;
                    let sec = silent_sec;
                    self.callbacks.log("warn", "main.playout.pusherSilent", vec![("sec", format!("{sec:.0}"))]);
                }
            } else {
                st.pusher_silence_reported = false;
            }
            if st.health_at == 0.0 {
                st.health_at = now;
                st.health_encoded_sec = st.encoded_sec;
                st.health_published_sec = st.published_sec;
                st.health_wall_ms = now;
                return;
            }
            if now - st.health_at < HEALTH_INTERVAL_MS {
                return;
            }
        }

        let (wall_sec, produced_sec, aired_sec, lead, relay, pusher_speed, pusher_sent, encoded, published) = {
            let st = self.state.lock().expect("playout state lock");
            let wall = (now - st.health_wall_ms) / 1000.0;
            (
                wall,
                st.encoded_sec - st.health_encoded_sec,
                st.published_sec - st.health_published_sec,
                st.encoded_sec - st.published_sec,
                (st.relayed_bytes, st.pumped_bytes, st.pending_len),
                st.pusher_speed,
                st.pusher_sent_bytes,
                st.encoded_sec,
                st.published_sec,
            )
        };
        let encode_rate = if wall_sec > 0.0 { produced_sec / wall_sec } else { 0.0 };
        let air_rate = if wall_sec > 0.0 { aired_sec / wall_sec } else { 0.0 };
        let (relayed, pumped, pending) = relay;
        let queued_kb = pending as f64 / 1024.0;
        self.callbacks.log(
            "debug",
            "main.playout.health",
            vec![
                ("published", format!("{published:.1}")),
                ("aired", format!("{aired_sec:.1}")),
                ("wall", format!("{wall_sec:.1}")),
                ("airRate", format!("{air_rate:.2}")),
                ("pusherSpeed", format!("{pusher_speed:.2}")),
                ("sentMb", format!("{:.1}", pusher_sent / 1048576.0)),
                ("encoded", format!("{encoded:.1}")),
                ("encodeRate", format!("{encode_rate:.2}")),
                ("lead", format!("{lead:.1}")),
                ("limit", format!("{:.1}", self.lead_limit_sec)),
                ("holds", {
                    let st = self.state.lock().expect("playout state lock");
                    st.hold_count.to_string()
                }),
                ("relayMb", format!("{:.1}", relayed as f64 / 1048576.0)),
                ("pumpedMb", format!("{:.1}", pumped as f64 / 1048576.0)),
                ("queuedKb", format!("{queued_kb:.0}")),
                ("pendingKb", format!("{:.0}", pending as f64 / 1024.0)),
            ],
        );
        if air_rate < HEALTH_MIN_RATE {
            let windows = {
                let mut st = self.state.lock().expect("playout state lock");
                st.low_rate_windows += 1;
                st.low_rate_windows
            };
            self.callbacks.log(
                "warn",
                "main.playout.lowRate",
                vec![
                    ("aired", format!("{aired_sec:.1}")),
                    ("wall", format!("{wall_sec:.1}")),
                    ("rate", format!("{air_rate:.2}")),
                    ("windows", windows.to_string()),
                ],
            );
        } else {
            self.state.lock().expect("playout state lock").low_rate_windows = 0;
        }
        let mut st = self.state.lock().expect("playout state lock");
        st.health_at = now;
        st.health_encoded_sec = st.encoded_sec;
        st.health_published_sec = st.published_sec;
        st.health_wall_ms = now;
    }

    /// Reads one `-progress` line from the pusher. The pusher's own timeline is
    /// the session timeline: it starts at 0 and only ever moves forward.
    fn on_pusher_output_line(self: &Arc<Self>, line: &str) {
        let Some((key, value)) = line.split_once('=') else { return };
        let key = key.trim();
        let value = value.trim();
        {
            let mut st = self.state.lock().expect("playout state lock");
            // The publisher reports every ~0.5s whether or not it is moving,
            // which makes it the only clock the health line can rely on while
            // the encoder is held.
            st.pusher_last_report_at = now_ms();
        }
        self.report_health();
        match key {
            "out_time_us" | "out_time_ms" => {
                let Ok(micro) = value.parse::<f64>() else { return };
                let sec = micro / 1_000_000.0;
                let moved = {
                    let mut st = self.state.lock().expect("playout state lock");
                    if sec > st.published_sec {
                        st.published_sec = sec;
                        true
                    } else {
                        false
                    }
                };
                if moved {
                    let _ = self.callbacks.tx.send(PlayoutEvent::Published(sec));
                    // A publisher that is falling further behind is what starts a
                    // hold; one already in flight ends on its own when the buffer
                    // has drained.
                    self.update_encoder_hold();
                }
            }
            "total_size" => {
                if let Ok(bytes) = value.parse::<f64>() {
                    if bytes > 0.0 {
                        let mut st = self.state.lock().expect("playout state lock");
                        st.pusher_sent_bytes = bytes;
                        st.network_rate.add(bytes, now_ms());
                    }
                }
            }
            "speed" => {
                if let Ok(v) = value.replace('x', "").parse::<f64>() {
                    if v > 0.0 {
                        self.state.lock().expect("playout state lock").pusher_speed = v;
                    }
                }
            }
            "progress" if value == "end" => {
                // The publisher has caught up with the encoder; it simply waits
                // for the next packets.
                self.callbacks.log("debug", "main.engine.publisherCaughtUp", vec![]);
            }
            _ => {}
        }
    }

    /// Keeps the pusher's own log, which is where RTMP failures are reported.
    fn on_pusher_log_line(self: &Arc<Self>, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let re = regex::Regex::new(r"(?i)error|failed|cannot|refused|denied|unable to").expect("static regex");
        let level = if re.is_match(line) { "error" } else { "ffmpeg" };
        self.callbacks.log_raw(level, line.to_string());
    }

    /// Tracks how much material the pass has produced, for its timeline span.
    fn on_encoder_output_line(self: &Arc<Self>, line: &str, pass_seq: u64) {
        let Some((key, value)) = line.split_once('=') else { return };
        let key = key.trim();
        let value = value.trim();
        match key {
            "out_time_us" | "out_time_ms" => {
                if let Ok(micro) = value.parse::<f64>() {
                    let sec = micro / 1_000_000.0;
                    let mut st = self.state.lock().expect("playout state lock");
                    let current = st.pass_material.get(&pass_seq).copied().unwrap_or(0.0);
                    st.pass_material.insert(pass_seq, current.max(sec));
                    // The encoder's own position on the published timeline: its
                    // pass offset plus what this pass has produced so far.
                    st.encoded_sec = st.pass_offset_sec + sec;
                }
            }
            "speed" => {
                if let Ok(v) = value.replace('x', "").parse::<f64>() {
                    self.state.lock().expect("playout state lock").enc_speed = v;
                }
            }
            "fps" => {
                if let Ok(v) = value.parse::<f64>() {
                    if v > 0.0 {
                        self.state.lock().expect("playout state lock").enc_fps = v;
                    }
                }
            }
            "bitrate" => {
                if let Ok(v) = value.replace("kbits/s", "").trim().parse::<f64>() {
                    if v > 0.0 {
                        self.state.lock().expect("playout state lock").enc_bitrate = v;
                    }
                }
            }
            "progress" => {
                // One line per progress block (every ~0.5s of material): proof
                // that the transport really is moving.
                let s = self.get_relay_stats();
                let produced = {
                    let st = self.state.lock().expect("playout state lock");
                    st.pass_material.get(&pass_seq).copied().unwrap_or(0.0)
                };
                self.callbacks.log(
                    "debug",
                    "main.playout.passProgress",
                    vec![
                        ("seq", pass_seq.to_string()),
                        ("produced", format!("{produced:.1}")),
                        ("relayed", format!("{}", (s.0 as f64 / 1024.0).round())),
                        ("pumped", format!("{}", (s.1 as f64 / 1024.0).round())),
                        ("buffered", format!("{}", (s.2 as f64 / 1024.0).round())),
                    ],
                );
            }
            _ => {}
        }
    }

    /// Keeps a sample of the encoder's own log so failures stay diagnosable.
    fn on_encoder_log_line(self: &Arc<Self>, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let re = regex::Regex::new(r"(?i)error|failed|invalid|unable to").expect("static regex");
        let level = if re.is_match(line) { "error" } else { "ffmpeg" };
        self.callbacks.log_raw(level, line.to_string());
    }

    /// Records the video PTS span of the transport stream (diagnostic).
    fn note_ts_pts(&self, buf: &[u8]) {
        let mut st = self.state.lock().expect("playout state lock");
        let mut i = 0;
        while i + TS_PACKET <= buf.len() {
            if buf[i] != 0x47 {
                i += TS_PACKET;
                continue;
            }
            if buf[i + 1] & 0x40 == 0 {
                i += TS_PACKET;
                continue; // no payload-unit-start: no PTS
            }
            let pid = (((buf[i + 1] & 0x1f) as u32) << 8) | buf[i + 2] as u32;
            if pid != 256 {
                i += TS_PACKET;
                continue; // pinned video PID (see `-mpegts_start_pid`)
            }
            let afc = (buf[i + 3] >> 4) & 0x03;
            // The PTS lives in the PES header, NOT in the adaptation field.
            if afc == 0 || afc == 2 {
                i += TS_PACKET;
                continue; // adaptation only: no payload, no PES header
            }
            let af_len = if afc == 3 { buf[i + 4] as usize } else { 0 };
            let pes = i + 4 + if afc == 3 { 1 + af_len } else { 0 };
            if pes + 14 > i + TS_PACKET {
                i += TS_PACKET;
                continue;
            }
            if buf[pes] != 0 || buf[pes + 1] != 0 || buf[pes + 2] != 1 {
                i += TS_PACKET;
                continue; // start code
            }
            if (buf[pes + 7] >> 6) & 0x03 < 2 {
                i += TS_PACKET;
                continue; // PTS_DTS_flags: no PTS present
            }
            let s = pes + 9;
            let raw: u64 = (((buf[s] & 0x0e) as u64) << 29)
                | ((buf[s + 1] as u64) << 22)
                | (((buf[s + 2] & 0xfe) as u64) << 14)
                | ((buf[s + 3] as u64) << 7)
                | ((buf[s + 4] as u64) >> 1);
            let seconds = raw as f64 / 90_000.0;
            st.ts_pts_packets += 1;
            st.ts_pts_video_headers += 1;
            if st.ts_pts_first.is_nan() {
                st.ts_pts_first = seconds;
            }
            st.ts_pts_last = seconds;
            i += TS_PACKET;
        }
    }

    /// A pass finished: account for its span and let the caller start the next
    /// one. There is no segment file to inspect — the pass streamed its output
    /// into the socket — so the span comes from the last progress report.
    fn finish_pass(self: &Arc<Self>, pass: Option<EncoderPass>, code: Option<i32>) {
        let Some(pass) = pass else { return };
        let seq = pass.seq;
        let material_sec = {
            let mut st = self.state.lock().expect("playout state lock");
            // Keyed by pass, not shared: a replaced encoder can still report
            // progress for a moment, and a single field would let one pass
            // overwrite another's measurement.
            st.pass_material.remove(&seq).unwrap_or(0.0)
        };
        if code != Some(0) {
            self.callbacks.log(
                "warn",
                "main.engine.encoderPassExit",
                vec![
                    (
                        "code",
                        code.map(|c| c.to_string()).unwrap_or_else(|| (self.callbacks.t)("main.engine.unknown", vec![])),
                    ),
                    ("name", crate::shared::types::base_name(&pass.input)),
                ],
            );
        }
        if material_sec <= 0.0 {
            if code == Some(0) {
                self.callbacks.log("debug", "main.engine.encoderNoOutput", vec![]);
            }
            let _ = self.callbacks.tx.send(PlayoutEvent::EncoderExit(code, 0.0));
            return;
        }
        // The measured span is the only reliable source: the pass may have been
        // cut short, and a nominal duration would advance the timeline past
        // what aired.
        let span = material_sec;
        {
            let mut st = self.state.lock().expect("playout state lock");
            Self::publish_segment(&mut st, span);
        }
        let (pts, next, relayed) = {
            let st = self.state.lock().expect("playout state lock");
            ((st.ts_pts_first, st.ts_pts_last, st.ts_pts_video_headers), st.next_offset, st.relayed_bytes)
        };
        self.callbacks.log(
            "debug",
            "main.playout.passDone",
            vec![
                ("seq", pass.seq.to_string()),
                ("span", format!("{span:.2}")),
                ("next", format!("{next:.2}")),
                ("first", if pts.0.is_nan() { "?".into() } else { format!("{:.2}", pts.0) }),
                ("last", if pts.1.is_nan() { "?".into() } else { format!("{:.2}", pts.1) }),
                ("frames", pts.2.to_string()),
                ("kb", format!("{}", (relayed as f64 / 1024.0).round())),
            ],
        );
        let _ = self.callbacks.tx.send(PlayoutEvent::EncoderExit(code, span));
    }

    /// Kills the current encoder, if any. Its exit handler ignores a replaced
    /// encoder (the pipe can still deliver its completion), so this is also
    /// where its measurement is forgotten.
    async fn kill_encoder(self: &Arc<Self>) {
        let supervisor = {
            let mut st = self.state.lock().expect("playout state lock");
            let supervisor = st.encoder.take();
            // The pass will never report again: its exit handler ignores a
            // replaced encoder, so nothing else would remove its measurement.
            let finished_seq = st.current_pass.as_ref().map(|p| p.seq);
            if let Some(seq) = finished_seq {
                st.pass_material.remove(&seq);
            }
            st.current_encoder_seq = 0;
            supervisor
        };
        if let Some(supervisor) = supervisor {
            if !supervisor.has_exited() {
                supervisor.kill();
            }
        }
    }
}
