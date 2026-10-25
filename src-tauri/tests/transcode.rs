//! Real-ffmpeg checks ported from `test/harness.mjs`: section 4 (executing the
//! generated commands), section 5 (proving subtitles were actually rendered via
//! signalstats), section 6 (RTMP push against a listening ffmpeg ingest),
//! section 8 (seek / sync-offset permutations measured on the output), and
//! section 11 (stand-in tracks executed and inspected on the output).

mod common;

use std::path::Path;

use common::*;
use rtmp_file_streamer::ffmpeg::capabilities::RunResult;
use rtmp_file_streamer::ffmpeg::command::{build_encoder_args, build_stream_command, build_test_command, BuiltCommand};
use rtmp_file_streamer::shared::types::SessionSettings;
use serde_json::Value;

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/// Port of the harness `execute`: run the args and require exit 0 plus a real
/// file. Returns the file size in bytes.
async fn execute(args: &[String], expect_file: Option<&str>) -> u64 {
    let res = run(&ffmpeg_bin(), args, 180_000).await;
    let exists = expect_file.map(|f| Path::new(f).exists()).unwrap_or(true);
    let size = expect_file
        .filter(|_| exists)
        .map(|f| std::fs::metadata(f).map(|m| m.len()).unwrap_or(0))
        .unwrap_or(0);
    assert!(
        res.code == 0 && exists && size > 1000,
        "ffmpeg exit {}; {}",
        res.code,
        stderr_tail(&res.stderr, 3)
    );
    size
}

async fn ffprobe_json(file: &str) -> Value {
    let mut args = str_args(&["-v", "error", "-print_format", "json", "-show_streams", "-show_format"]);
    args.push(file.to_string());
    let res = run(&ffprobe_bin(), &args, 120_000).await;
    serde_json::from_str(res.stdout.trim()).unwrap_or(Value::Null)
}

fn find_stream<'a>(probe: &'a Value, codec_type: &str) -> &'a Value {
    probe
        .get("streams")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|s| s.get("codec_type").and_then(|t| t.as_str()) == Some(codec_type)))
        .unwrap_or(&Value::Null)
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn num_field(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok()).unwrap_or(f64::NAN)
}

/// Port of the harness `measure`: content length derived from the decoded
/// frame count, plus the format/stream start times.
#[allow(dead_code)] // the field set mirrors the harness measurement 1:1
struct Measured {
    format_duration: f64,
    format_start: f64,
    stream_start: f64,
    frames: f64,
    content_sec: f64,
}

async fn measure(file: &str) -> Measured {
    let mut args = str_args(&[
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=start_time,nb_read_frames,avg_frame_rate:format=start_time,duration",
        "-print_format",
        "json",
    ]);
    args.push(file.to_string());
    let res = run(&ffprobe_bin(), &args, 120_000).await;
    let parsed: Value = serde_json::from_str(res.stdout.trim()).unwrap_or(Value::Null);
    let stream = parsed.get("streams").and_then(|v| v.get(0)).cloned().unwrap_or(Value::Null);
    let format = parsed.get("format").cloned().unwrap_or(Value::Null);
    let rate = str_field(&stream, "avg_frame_rate");
    let fps = match rate.split_once('/') {
        Some((n, d)) => {
            let n: f64 = n.parse().unwrap_or(0.0);
            let d: f64 = d.parse().unwrap_or(0.0);
            if n > 0.0 && d > 0.0 {
                n / d
            } else {
                0.0
            }
        }
        None => 0.0,
    };
    let frames = stream
        .get("nb_read_frames")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(f64::NAN);
    Measured {
        format_duration: num_field(&format, "duration"),
        format_start: num_field(&format, "start_time"),
        stream_start: num_field(&stream, "start_time"),
        frames,
        content_sec: if fps > 0.0 && frames.is_finite() { frames / fps } else { f64::NAN },
    }
}

/// Port of the harness `inspect`: streams present in an output, the last PTS of
/// each and the format duration.
#[allow(dead_code)] // the field set mirrors the harness measurement 1:1
struct Inspect {
    video: Value,
    audio: Value,
    video_end_sec: f64,
    audio_end_sec: f64,
    format_duration: f64,
}

async fn last_pts(file: &str, kind: &str) -> f64 {
    let mut args = str_args(&["-v", "error", "-select_streams", kind, "-show_entries", "packet=pts_time", "-of", "csv=p=0"]);
    args.push(file.to_string());
    let res = run(&ffprobe_bin(), &args, 120_000).await;
    let rows: Vec<&str> = res.stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    rows.last().and_then(|r| r.trim().parse::<f64>().ok()).unwrap_or(f64::NAN)
}

async fn inspect(file: &str) -> Inspect {
    let probe = ffprobe_json(file).await;
    Inspect {
        video: find_stream(&probe, "video").clone(),
        audio: find_stream(&probe, "audio").clone(),
        video_end_sec: last_pts(file, "v").await,
        audio_end_sec: last_pts(file, "a").await,
        format_duration: num_field(probe.get("format").unwrap_or(&Value::Null), "duration"),
    }
}

/// Mean volume of the output's audio in dB (`-inf` for pure digital silence).
async fn mean_volume_db(file: &str) -> f64 {
    let args = str_args(&["-hide_banner", "-loglevel", "info", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
    let res = run(&ffmpeg_bin(), &args, 120_000).await;
    let re = regex::Regex::new(r"mean_volume:\s*(-?[\d.]+|-inf)\s*dB").unwrap();
    match re.captures(&res.stderr) {
        Some(c) if &c[1] == "-inf" => f64::NEG_INFINITY,
        Some(c) => c[1].parse().unwrap_or(f64::NAN),
        None => f64::NAN,
    }
}

/// Average luma of one frame, for "is this picture actually black".
async fn frame_luma(file: &str, at_sec: f64) -> f64 {
    let args = str_args(&[
        "-hide_banner",
        "-loglevel",
        "info",
        "-ss",
        &format!("{at_sec}"),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "signalstats,metadata=print:file=-",
        "-f",
        "null",
        "-",
    ]);
    let res = run(&ffmpeg_bin(), &args, 120_000).await;
    let re = regex::Regex::new(r"YAVG=([\d.]+)").unwrap();
    re.captures(&res.stdout).and_then(|c| c[1].parse().ok()).unwrap_or(f64::NAN)
}

/// Luma statistics of the subtitle band (bottom 160px above the 170px inset).
async fn band_stats(png: &str) -> (f64, f64, f64) {
    let args = str_args(&[
        "-hide_banner",
        "-loglevel",
        "info",
        "-i",
        png,
        "-vf",
        "crop=iw:160:0:ih-170,signalstats,metadata=print:file=-",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]);
    let res = run(&ffmpeg_bin(), &args, 120_000).await;
    let ymax = regex::Regex::new(r"YMAX=([\d.]+)").unwrap();
    let ymin = regex::Regex::new(r"YMIN=([\d.]+)").unwrap();
    let yavg = regex::Regex::new(r"YAVG=([\d.]+)").unwrap();
    (
        ymax.captures(&res.stdout).and_then(|c| c[1].parse().ok()).unwrap_or(f64::NAN),
        ymin.captures(&res.stdout).and_then(|c| c[1].parse().ok()).unwrap_or(f64::NAN),
        yavg.captures(&res.stdout).and_then(|c| c[1].parse().ok()).unwrap_or(f64::NAN),
    )
}

/// Port of the harness `renderedBurnChecks`: a command vector can look right
/// and still produce a picture without subtitles, so the output is sampled.
async fn rendered_burn_checks(tag: &str, out_file_path: &str) {
    let frame_sub = out_file(&format!("frame_{tag}_sub.png"));
    let frame_no_sub = out_file(&format!("frame_{tag}_nosub.png"));
    for f in [&frame_sub, &frame_no_sub] {
        let _ = std::fs::remove_file(f);
    }
    // The first cue runs 2s-8s, so the samples go inside it (t=4) and before it.
    let extract = |at: &str, target: &str| {
        let mut args = str_args(&["-hide_banner", "-loglevel", "error", "-y", "-ss", at, "-i", out_file_path, "-frames:v", "1"]);
        args.push(target.to_string());
        args
    };
    run(&ffmpeg_bin(), &extract("4", &frame_sub), 120_000).await;
    run(&ffmpeg_bin(), &extract("0.5", &frame_no_sub), 120_000).await;
    assert!(Path::new(&frame_sub).exists() && Path::new(&frame_no_sub).exists(), "subtitle frames not extracted");
    let (sub_max, sub_min, sub_avg) = band_stats(&frame_sub).await;
    let (clean_max, _, clean_avg) = band_stats(&frame_no_sub).await;
    assert!(sub_max >= 200.0, "with cue: YMAX={sub_max} YMIN={sub_min} YAVG={sub_avg}");
    assert!(
        (sub_avg - clean_avg).abs() > 0.05 || sub_max != clean_max,
        "no cue: YMAX={clean_max} YAVG={clean_avg}"
    );
}

/// Port of the harness `buildAndRun`: build against clip_a, run, measure.
async fn build_and_run(name: &str, item: &rtmp_file_streamer::shared::types::PlaylistItem, settings: &SessionSettings, start_position_sec: f64, out: &str) -> (BuiltCommand, Measured) {
    let _ = std::fs::remove_file(out);
    let p = probed();
    let built = build_stream_command(&build_request(&p.info_a, item, settings, start_position_sec, Some(out.to_string())))
        .expect("build_stream_command");
    let res = run(&ffmpeg_bin(), &built.args, 180_000).await;
    if res.code != 0 || !Path::new(out).exists() {
        panic!("{name}: ffmpeg exit {}; {}", res.code, stderr_tail(&res.stderr, 2));
    }
    (built, measure(out).await)
}

struct ProgressSample {
    t: Option<f64>,
    bytes: Option<f64>,
}

/// Parses `-progress` blocks the way the engine's stdout reader does.
fn parse_progress(stdout: &str) -> Vec<ProgressSample> {
    let mut samples = Vec::new();
    let mut current = ProgressSample { t: None, bytes: None };
    for line in stdout.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "out_time_us" => current.t = Some(value.parse::<f64>().unwrap_or(f64::NAN) / 1e6),
            "total_size" => current.bytes = Some(value.parse::<f64>().unwrap_or(f64::NAN)),
            "progress" => {
                let has_t = current.t.is_some_and(|t| t.is_finite());
                if has_t {
                    samples.push(std::mem::replace(&mut current, ProgressSample { t: None, bytes: None }));
                }
            }
            _ => {}
        }
    }
    samples
}

/// A free TCP port for the local RTMP ingest.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind :0")
        .local_addr()
        .expect("local addr")
        .port()
}

/// `ffmpeg -listen 1` as the downstream ingest, writing the received FLV.
async fn spawn_rtmp_listener(port: u16, out_path: &Path) -> (tokio::process::Child, tokio::task::JoinHandle<String>) {
    let url = format!("rtmp://127.0.0.1:{port}/live/test");
    let mut child = tokio::process::Command::new(ffmpeg_bin())
        .args([
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
            "-listen".to_string(),
            "1".to_string(),
            "-f".to_string(),
            "flv".to_string(),
            "-i".to_string(),
            url,
            "-c".to_string(),
            "copy".to_string(),
            "-f".to_string(),
            "flv".to_string(),
            "-y".to_string(),
        ])
        .arg(out_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn rtmp listener");
    let stderr = child.stderr.take().expect("listener stderr piped");
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut stderr = stderr;
        let _ = stderr.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });
    (child, reader)
}

/// Port of the harness `receiveTestPush`: push a test command at a fresh
/// listener and return the received file's probe result.
async fn receive_test_push(label: &str, tweak: impl FnOnce(&mut SessionSettings)) -> (RunResult, u64, Value) {
    let port = free_port();
    let file = out_file(&format!("received_{label}.flv"));
    let _ = std::fs::remove_file(&file);
    let (mut sink, _err) = spawn_rtmp_listener(port, Path::new(&file)).await;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let mut session = base_session();
    tweak(&mut session);
    let built = build_test_command(&session, &format!("rtmp://127.0.0.1:{port}/live"), "test", "zh");
    let res = run(&ffmpeg_bin(), &built.args, 90_000).await;
    let _ = sink.kill().await;
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let streams = if size > 0 { ffprobe_json(&file).await } else { Value::Null };
    let _ = std::fs::remove_file(&file);
    (res, size, streams)
}

/* ------------------------------------------------------------------ *
 * 4. executing generated commands (+ 5. rendered subtitle checks)
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn burn_in_transcode_runs_and_the_subtitles_are_really_rendered() {
    let p = probed();
    let out = out_file("out_burn.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_a, &p.item_a, &burn_session(), 0.0, Some(out.clone())))
        .expect("build_stream_command");
    let size = execute(&built.args, Some(&out)).await;
    let probe = ffprobe_json(&out).await;
    let video = find_stream(&probe, "video");
    let audio = find_stream(&probe, "audio");
    let duration = num_field(probe.get("format").unwrap_or(&Value::Null), "duration");
    assert!(
        !video.is_null() && !audio.is_null(),
        "video={:?} audio={:?}",
        str_field(video, "codec_name"),
        str_field(audio, "codec_name")
    );
    assert!(duration > 19.0, "output duration {duration}s for a ~20s clip, {size} bytes");
    rendered_burn_checks("sub", &out).await;
}

#[tokio::test]
async fn embedded_burn_transcode_runs_and_the_subtitles_are_really_rendered() {
    let p = probed();
    let out = out_file("out_burn_emb.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_emb, &p.item_emb, &burn_session(), 0.0, Some(out.clone())))
        .expect("build_stream_command");
    execute(&built.args, Some(&out)).await;
    let probe = ffprobe_json(&out).await;
    assert!(!find_stream(&probe, "video").is_null() && !find_stream(&probe, "audio").is_null());
    rendered_burn_checks("emb", &out).await;
}

#[tokio::test]
async fn seek_and_itsoffset_transcode_runs() {
    let p = probed();
    let mut item = p.item_a.clone();
    item.sync_offset_sec = 0.5;
    item.subtitle_delay_sec = 0.5;
    let out = out_file("out_seek.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_a, &item, &base_session(), 5.0, Some(out.clone())))
        .expect("build_stream_command");
    execute(&built.args, Some(&out)).await;
}

#[tokio::test]
async fn remux_copy_to_flv_runs() {
    let p = probed();
    let mut settings = base_session();
    settings.video.codec = "copy".into();
    let out = out_file("out_copy.flv");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_b, &mode_off(&p.item_b), &settings, 0.0, Some(out.clone())))
        .expect("build_stream_command");
    execute(&built.args, Some(&out)).await;
}

#[tokio::test]
async fn hardware_encoder_request_transcode_runs() {
    let p = probed();
    let mut settings = base_session();
    settings.video.encoder = "h264_amf".into();
    let out = out_file("out_hw.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_b, &mode_off(&p.item_b), &settings, 0.0, Some(out.clone())))
        .expect("build_stream_command");
    // The vector test pins which encoder this resolves to; here it only has to run.
    execute(&built.args, Some(&out)).await;
}

/* ------------------------------------------------------------------ *
 * 6. RTMP push against a listening ffmpeg endpoint
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn rtmp_push_against_a_listening_ffmpeg_endpoint() {
    let p = probed();
    let port = free_port();
    let received = out_file("received.flv");
    let _ = std::fs::remove_file(&received);

    let (mut listener, err_task) = spawn_rtmp_listener(port, Path::new(&received)).await;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let mut settings = base_session();
    settings.output.server = format!("rtmp://127.0.0.1:{port}/live/");
    settings.output.stream_key = "test".into();
    settings.output.realtime_pacing = true;
    settings.output.max_reconnect_attempts = 0.0;
    let built = build_stream_command(&build_request(&p.info_b, &mode_off(&p.item_b), &settings, 0.0, None))
        .expect("build_stream_command");

    let push = run(&ffmpeg_bin(), &built.args, 120_000).await;
    let _ = listener.kill().await;
    let listener_err = err_task.await.unwrap_or_default();
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let received_size = std::fs::metadata(&received).map(|m| m.len()).unwrap_or(0);
    assert!(
        listener_err.contains("Stream #") || received_size > 0,
        "no incoming connection accepted: {}",
        stderr_tail(&listener_err, 2)
    );
    assert!(received_size > 50_000, "{} KB written by the ingest side", received_size / 1024);

    // Progress blocks, parsed from the push's own -progress pipe:1 output.
    let samples = parse_progress(&push.stdout);
    let times: Vec<f64> = samples.iter().filter_map(|s| s.t).collect();
    let monotonic = times.windows(2).all(|w| w[1] >= w[0] - 1e-6);
    assert!(
        times.len() >= 3 && monotonic,
        "{} samples, first {:?} last {:?}",
        times.len(),
        times.first(),
        times.last()
    );
    let last = times.last().copied().unwrap_or(0.0);
    assert!(last > p.info_b.duration_sec - 2.0, "final out_time={last:.2}s of {}s", p.info_b.duration_sec);

    let byte_samples: Vec<&ProgressSample> = samples.iter().filter(|s| s.bytes.is_some_and(|b| b.is_finite() && b > 0.0)).collect();
    let byte_counts: Vec<f64> = byte_samples.iter().map(|s| s.bytes.unwrap_or(0.0)).collect();
    let byte_counts_rise = byte_counts.windows(2).all(|w| w[1] >= w[0]);
    assert!(
        byte_samples.len() >= 3 && byte_counts_rise && byte_counts.last().copied().unwrap_or(0.0) > 0.0,
        "{}/{} progress blocks carried total_size",
        byte_samples.len(),
        samples.len()
    );
    let final_bytes = byte_counts.last().copied().unwrap_or(0.0);
    assert!(
        received_size > 0 && final_bytes > received_size as f64 * 0.75 && final_bytes < received_size as f64 * 1.35,
        "ffmpeg counted {:.2} MB, the listener wrote {:.2} MB",
        final_bytes / 1048576.0,
        received_size as f64 / 1048576.0
    );

    let check = ffprobe_json(&received).await;
    let vs = find_stream(&check, "video");
    let as_ = find_stream(&check, "audio");
    assert!(
        !vs.is_null() && !as_.is_null(),
        "video={:?} {}x{} audio={:?} {}Hz",
        str_field(vs, "codec_name"),
        vs.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        vs.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        str_field(as_, "codec_name"),
        str_field(as_, "sample_rate")
    );
}

/* ------------------------------------------------------------------ *
 * 7 (end to end). the test push received by a real ingest
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn the_test_push_is_accepted_and_the_received_streams_match_the_configuration() {
    let (res, size, probe) = receive_test_push("test_audio", |s| {
        s.audio.codec = "aac".into();
        s.audio.rate_control = "cbr".into();
        s.audio.bitrate_kbps = 96.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
        s.video.scale = "1280:720".into();
        s.video.scale_width = 1280.0;
        s.video.scale_height = 720.0;
        s.video.scale_auto = false;
        s.video.fps = 25.0;
    })
    .await;
    assert!(res.code == 0 && size > 50_000, "exit {}, {} KB, {}", res.code, size / 1024, stderr_tail(&res.stderr, 3));
    let audio = find_stream(&probe, "audio");
    let video = find_stream(&probe, "video");
    let audio_desc = format!(
        "audio={} {}Hz {}ch",
        str_field(audio, "codec_name"),
        str_field(audio, "sample_rate"),
        audio.get("channels").and_then(|v| v.as_i64()).unwrap_or(0)
    );
    assert!(
        str_field(audio, "codec_name") == "aac" && str_field(audio, "sample_rate") == "22050" && audio.get("channels").and_then(|v| v.as_i64()) == Some(1),
        "{audio_desc}"
    );
    let video_desc = format!(
        "video={} {}x{} @{}",
        str_field(video, "codec_name"),
        video.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        video.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        str_field(video, "avg_frame_rate")
    );
    assert!(
        video.get("width").and_then(|v| v.as_i64()) == Some(1280)
            && video.get("height").and_then(|v| v.as_i64()) == Some(720)
            && str_field(video, "avg_frame_rate") == "25/1",
        "{video_desc}"
    );
}

#[tokio::test]
async fn audio_none_really_sends_a_video_only_stream() {
    let (res, size, probe) = receive_test_push("test_noaudio", |s| {
        s.audio.codec = "none".into();
    })
    .await;
    let video = find_stream(&probe, "video");
    let audio = find_stream(&probe, "audio");
    assert!(
        res.code == 0 && !video.is_null() && audio.is_null(),
        "exit {}, {} KB, video={:?}, audio={}",
        res.code,
        size / 1024,
        str_field(video, "codec_name"),
        if audio.is_null() { "absent" } else { "present" }
    );
}

/* ------------------------------------------------------------------ *
 * 8. seek and sync-offset permutations actually land correctly
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn seek_to_5s_yields_about_15s_of_content_starting_at_0() {
    let p = probed();
    let out = out_file("seek_plain.mp4");
    let (_, measured) = build_and_run("seek to 5s", &mode_off(&p.item_a), &base_session(), 5.0, &out).await;
    assert!(
        (measured.content_sec - 15.0).abs() < 1.2 && measured.format_start.abs() < 0.6,
        "content={:.2}s start={}",
        measured.content_sec,
        measured.format_start
    );
}

#[tokio::test]
async fn no_seek_keeps_the_full_20s() {
    let p = probed();
    let out = out_file("seek_none.mp4");
    let (_, measured) = build_and_run("full file", &mode_off(&p.item_a), &base_session(), 0.0, &out).await;
    assert!((measured.content_sec - 20.0).abs() < 1.2, "content={:.2}s", measured.content_sec);
}

#[tokio::test]
async fn positive_av_offset_delays_the_stream_by_exactly_the_offset() {
    let p = probed();
    let out = out_file("seek_pos.mp4");
    let mut item = mode_off(&p.item_a);
    item.sync_offset_sec = 2.0;
    let (built, measured) = build_and_run("positive sync offset", &item, &base_session(), 0.0, &out).await;
    assert!(
        (measured.content_sec - 20.0).abs() < 1.2 && (measured.format_start - 1.9).abs() < 0.3,
        "all {} frames kept, first packet at {}s (expected ~2s)",
        measured.frames,
        measured.format_start
    );
    assert!(
        built.warnings.iter().any(|w| w.contains("空档")),
        "{:?}",
        built.warnings
    );
}

#[tokio::test]
async fn negative_av_offset_trims_the_head_and_stays_zero_based() {
    let p = probed();
    let out = out_file("seek_neg.mp4");
    let mut item = mode_off(&p.item_a);
    item.sync_offset_sec = -3.0;
    let (built, measured) = build_and_run("negative sync offset", &item, &base_session(), 0.0, &out).await;
    assert!(
        measured.format_start.abs() < 0.6 && (measured.content_sec - 17.0).abs() < 1.2,
        "content={:.2}s (expected 17s), start={}, copyts={}",
        measured.content_sec,
        measured.format_start,
        built.args.iter().any(|a| a == "-copyts")
    );
}

#[tokio::test]
async fn seek_to_8s_with_burn_in_yields_about_12s() {
    let p = probed();
    let out = out_file("seek_burn.mp4");
    let (_, measured) = build_and_run("seek with burn-in", &p.item_a, &base_session(), 8.0, &out).await;
    assert!((measured.content_sec - 12.0).abs() < 1.2, "content={:.2}s", measured.content_sec);
}

#[tokio::test]
async fn a_seeked_pass_reports_progress_rebased_to_zero() {
    let p = probed();
    let out = out_file("probe_seek_pts.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_a, &mode_off(&p.item_a), &base_session(), 12.0, Some(out.clone())))
        .expect("build_stream_command");
    let res = run(&ffmpeg_bin(), &built.args, 180_000).await;
    assert!(res.code == 0 && Path::new(&out).exists(), "exit {}; {}", res.code, stderr_tail(&res.stderr, 2));
    let re = regex::Regex::new(r"^out_time_us=(\d+)$").unwrap();
    let times: Vec<f64> = res
        .stdout
        .lines()
        .filter_map(|l| re.captures(l).and_then(|c| c[1].parse::<f64>().ok()))
        .map(|v| v / 1e6)
        .collect();
    let last = times.last().copied().unwrap_or(0.0);
    let expected = p.info_a.duration_sec - 12.0;
    assert!(
        !times.is_empty() && last > expected - 1.5 && last < expected + 1.5,
        "last out_time={last:.2}s for a {}s clip seeked to 12s (expected ~{expected:.1}s)",
        p.info_a.duration_sec
    );
}

/* ------------------------------------------------------------------ *
 * 11. stand-in tracks executed and inspected on the output
 * ------------------------------------------------------------------ */

#[tokio::test]
async fn a_video_only_file_publishes_generated_silence_as_long_as_the_picture() {
    let p = probed();
    let out = out_file("out_standin_audio_run.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_d, &mode_off(&p.item_d), &base_session(), 0.0, Some(out.clone())))
        .expect("build_stream_command");
    execute(&built.args, Some(&out)).await;
    let inv = inspect(&out).await;
    assert!(
        !inv.video.is_null() && !inv.audio.is_null(),
        "video={} {}x{}, audio={} {}Hz {}ch",
        str_field(&inv.video, "codec_name"),
        inv.video.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        inv.video.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        str_field(&inv.audio, "codec_name"),
        str_field(&inv.audio, "sample_rate"),
        inv.audio.get("channels").and_then(|v| v.as_i64()).unwrap_or(0)
    );
    let db = mean_volume_db(&out).await;
    assert!(
        db <= -60.0 && (inv.audio_end_sec - p.info_d.duration_sec).abs() < 0.6 && (inv.audio_end_sec - inv.video_end_sec).abs() < 0.6,
        "mean volume {db} dB, audio ends {:.2}s, video ends {:.2}s, source {}s",
        inv.audio_end_sec,
        inv.video_end_sec,
        p.info_d.duration_sec
    );
}

#[tokio::test]
async fn an_audio_only_file_publishes_a_black_picture_as_long_as_the_sound() {
    let p = probed();
    let out = out_file("out_standin_video_run.mp4");
    let _ = std::fs::remove_file(&out);
    let built = build_stream_command(&build_request(&p.info_e, &mode_off(&p.item_e), &base_session(), 0.0, Some(out.clone())))
        .expect("build_stream_command");
    execute(&built.args, Some(&out)).await;
    let inv = inspect(&out).await;
    assert!(
        !inv.video.is_null() && !inv.audio.is_null() && inv.video.get("width").and_then(|v| v.as_i64()) == Some(1280) && inv.video.get("height").and_then(|v| v.as_i64()) == Some(720),
        "video={} {}x{}, audio={} {}Hz",
        str_field(&inv.video, "codec_name"),
        inv.video.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        inv.video.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
        str_field(&inv.audio, "codec_name"),
        str_field(&inv.audio, "sample_rate")
    );
    let luma = frame_luma(&out, 2.0).await;
    assert!(
        luma < 40.0 && (inv.video_end_sec - p.info_e.duration_sec).abs() < 0.6 && (inv.video_end_sec - inv.audio_end_sec).abs() < 0.6,
        "YAVG={luma}, video ends {:.2}s, audio ends {:.2}s, source {}s",
        inv.video_end_sec,
        inv.audio_end_sec,
        p.info_e.duration_sec
    );
}

#[tokio::test]
async fn the_buffered_encoder_pass_publishes_the_generated_track_too() {
    let p = probed();
    let enc = build_encoder_args(&build_request(&p.info_d, &mode_off(&p.item_d), &base_session(), 0.0, None))
        .expect("build_encoder_args");
    let out = out_file("out_standin_pass.ts");
    let _ = std::fs::remove_file(&out);
    let mut args = str_args(&["-hide_banner", "-nostdin", "-loglevel", "error", "-fflags", "+genpts", "-i"]);
    args.push(fixtures().clip_d.clone());
    args.extend(enc.inputs.clone());
    args.extend(enc.args.clone());
    args.extend(str_args(&["-f", "mpegts"]));
    args.push(out.clone());
    let res = run(&ffmpeg_bin(), &args, 180_000).await;
    assert!(res.code == 0 && Path::new(&out).exists(), "exit {}; {}", res.code, stderr_tail(&res.stderr, 2));
    let inv = inspect(&out).await;
    assert!(
        enc.silent_audio && !enc.inputs.is_empty() && !inv.video.is_null() && !inv.audio.is_null(),
        "inputs=[{}] -> video={}, audio={} (exit {})",
        enc.inputs.join(" "),
        str_field(&inv.video, "codec_name"),
        str_field(&inv.audio, "codec_name"),
        res.code
    );
}
