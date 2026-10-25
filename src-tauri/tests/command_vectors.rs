//! Cheap command/vector checks ported from `test/harness.mjs`:
//! section 1b (credential redaction), the language seam, section 2 (media
//! probing), section 3 (command generation, including the protocol and
//! stand-in-track vectors), section 3b (byte-rate metering) and section 7
//! (connection-test command shape). One test per harness `record`.

mod common;

use std::collections::HashSet;

use common::*;
use rtmp_file_streamer::ffmpeg::capabilities::encoder_arg_for;
use rtmp_file_streamer::ffmpeg::command::{
    build_encoder_args, build_stream_command, build_test_command, even_dimension,
    escape_filter_path, split_output_args, BuiltCommand,
};
use rtmp_file_streamer::log_redact::{collect_secrets, mask_target, redact_text};
use rtmp_file_streamer::shared::i18n;
use rtmp_file_streamer::shared::protocol::{
    address_matches_protocol, build_rtmp_target, build_push_target, container_for_protocol,
    detect_stream_protocol, muxer_for_protocol, network_for_protocol, protocol_key_args,
};
use rtmp_file_streamer::shared::types::{MediaInfo, MediaStreamInfo, SubtitleTrackRef};
use rtmp_file_streamer::stream::byte_rate::ByteRateMeter;

/// Fixed fake endpoint the vector tests compose targets against (no connection
/// is ever made).
const TEST_HOST: &str = "rtmp://127.0.0.1:11935/live";

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

fn build_with_override(
    media: &MediaInfo,
    item: &rtmp_file_streamer::shared::types::PlaylistItem,
    settings: &rtmp_file_streamer::shared::types::SessionSettings,
    out: &str,
) -> BuiltCommand {
    build_stream_command(&build_request(media, item, settings, 0.0, Some(out.to_string()))).expect("build_stream_command")
}

fn build_to_target(
    media: &MediaInfo,
    item: &rtmp_file_streamer::shared::types::PlaylistItem,
    settings: &rtmp_file_streamer::shared::types::SessionSettings,
) -> BuiltCommand {
    build_stream_command(&build_request(media, item, settings, 0.0, None)).expect("build_stream_command")
}

fn encoder_args(
    media: &MediaInfo,
    item: &rtmp_file_streamer::shared::types::PlaylistItem,
    settings: &rtmp_file_streamer::shared::types::SessionSettings,
) -> rtmp_file_streamer::ffmpeg::command::BuiltEncoderArgs {
    build_encoder_args(&build_request(media, item, settings, 0.0, None)).expect("build_encoder_args")
}

fn test_cmd(tweak: impl FnOnce(&mut rtmp_file_streamer::shared::types::SessionSettings)) -> rtmp_file_streamer::ffmpeg::command::TestCommand {
    test_cmd_at(TEST_HOST, "key123", tweak)
}

fn test_cmd_at(
    url: &str,
    key: &str,
    tweak: impl FnOnce(&mut rtmp_file_streamer::shared::types::SessionSettings),
) -> rtmp_file_streamer::ffmpeg::command::TestCommand {
    let _guard = builder_lock();
    let mut session = base_session();
    tweak(&mut session);
    build_test_command(&session, url, key, "zh")
}

fn sub_stream(index: i64) -> MediaStreamInfo {
    MediaStreamInfo {
        index,
        stream_type: "subtitle".into(),
        codec: "subrip".into(),
        subtitle_family: Some("text".into()),
        ..Default::default()
    }
}

fn video_stream(index: i64, codec: &str, attached_pic: bool, width: i64, fps: f64) -> MediaStreamInfo {
    MediaStreamInfo {
        index,
        stream_type: "video".into(),
        codec: codec.into(),
        width: Some(width),
        height: Some(720),
        fps: Some(fps),
        attached_pic: if attached_pic { Some(true) } else { None },
        ..Default::default()
    }
}

fn audio_stream(index: i64, codec: &str) -> MediaStreamInfo {
    MediaStreamInfo {
        index,
        stream_type: "audio".into(),
        codec: codec.into(),
        channels: Some(2),
        sample_rate: Some(44100.0),
        ..Default::default()
    }
}

/// The fabricated cover-art media of harness section 2e-bis, derived from clip_b.
fn cover_art_media(cover_only: bool) -> MediaInfo {
    let p = probed();
    let mut media = p.info_b.clone();
    let mjpeg = video_stream(0, "mjpeg", true, 0, 0.0);
    let h264 = video_stream(1, "h264", false, 1280, 30.0);
    let aac = audio_stream(2, "aac");
    if cover_only {
        media.streams = vec![mjpeg.clone(), aac.clone()];
        media.video_streams = vec![mjpeg];
        media.audio_streams = vec![aac];
    } else {
        media.streams = vec![mjpeg.clone(), h264.clone(), aac.clone()];
        media.video_streams = vec![mjpeg, h264];
        media.audio_streams = vec![aac];
    }
    media.subtitle_streams = Vec::new();
    media
}

fn item_without_subtitles() -> rtmp_file_streamer::shared::types::PlaylistItem {
    let mut item = mode_off(&probed().item_b);
    item.subtitle_tracks = Vec::new();
    item.selected_subtitle_id = None;
    item
}

/* ------------------------------------------------------------------ *
 * 1b. credential redaction
 * ------------------------------------------------------------------ */

#[test]
fn the_rtmp_key_is_replaced_whole_with_stars_in_the_masked_target() {
    assert_eq!(
        mask_target("rtmp://relay.example:1935/live/", "vrochat", Some("rtmp")),
        "rtmp://relay.example:1935/live/*****"
    );
}

#[test]
fn the_srt_passphrase_becomes_stars_as_a_query_parameter() {
    assert_eq!(
        mask_target("srt://relay.example:9000", "secret123", Some("srt")),
        "srt://relay.example:9000?passphrase=*****"
    );
}

#[test]
fn whip_keeps_the_key_out_of_the_address_entirely() {
    assert_eq!(
        mask_target("https://relay.example/whip", "jwt-token", Some("whip")),
        "https://relay.example/whip"
    );
}

#[test]
fn redaction_replaces_the_composed_target_with_the_stars_form() {
    let secrets = collect_secrets(Some(&output_settings("rtmp://relay.example/live/", "streamkey", "rtmp")));
    let output = redact_text("Output #0, flv, to 'rtmp://relay.example/live/streamkey'", &secrets);
    assert_eq!(output, "Output #0, flv, to 'rtmp://relay.example/live/*****'");
}

#[test]
fn the_whip_authorization_token_is_redacted_wherever_it_is_printed() {
    let secrets = collect_secrets(Some(&output_settings("https://relay.example/whip", "JWT.X.Y", "whip")));
    let output = redact_text("handshake failed for -authorization JWT.X.Y", &secrets);
    assert_eq!(output, "handshake failed for -authorization *****");
}

/* ------------------------------------------------------------------ *
 * 1. language seam (the builder's diagnostics follow the language)
 * ------------------------------------------------------------------ */

#[test]
fn the_command_builder_writes_its_summary_in_the_requested_language() {
    let _guard = builder_lock();
    let mut session = base_session();
    session.video.codec = "h264".into();
    session.video.encoder = "x264".into();
    session.video.bitrate_kbps = 4000.0;
    session.video.max_bitrate_kbps = 4000.0;
    session.video.buffer_size_kbps = 8000.0;
    session.video.crf = 22.0;
    session.video.preset = "veryfast".into();
    session.video.tune = "".into();
    session.video.profile = "high".into();
    session.video.fps = 30.0;
    session.subtitles.mode = "off".into();
    session.output.server = "rtmp://127.0.0.1:1/live/".into();
    session.output.stream_key = "k".into();
    session.output.realtime_pacing = true;
    session.output.max_reconnect_attempts = 10.0;
    let zh = build_test_command(&session, "rtmp://127.0.0.1:1/live", "k", "zh").summary.join(" / ");
    let en = build_test_command(&session, "rtmp://127.0.0.1:1/live", "k", "en").summary.join(" / ");
    assert!(!zh.is_empty() && !en.is_empty() && zh != en, "zh=`{zh}` en=`{en}`");
}

/* ------------------------------------------------------------------ *
 * 2. media probing
 * ------------------------------------------------------------------ */

#[test]
fn probe_clip_a_reports_one_video_one_audio_and_full_duration() {
    let p = probed();
    let detail = format!(
        "{}x{} @ {}fps, {}s, audio={}",
        p.info_a.video_streams[0].width.unwrap_or(0),
        p.info_a.video_streams[0].height.unwrap_or(0),
        p.info_a.video_streams[0].fps.unwrap_or(0.0),
        p.info_a.duration_sec,
        p.info_a.audio_streams[0].codec
    );
    assert!(
        p.info_a.video_streams.len() == 1 && p.info_a.audio_streams.len() == 1 && p.info_a.duration_sec > 19.0,
        "{detail}"
    );
}

#[test]
fn sidecar_subtitle_auto_discovery() {
    let p = probed();
    let tracks = &p.item_a.subtitle_tracks;
    let detail = tracks
        .iter()
        .map(|t| format!("{}:{}:{}", t.source, t.codec, t.family))
        .collect::<Vec<_>>()
        .join(",");
    assert!(tracks.len() == 1 && tracks[0].source == "external", "{detail}");
}

#[test]
fn selected_subtitle_defaults_to_the_text_track() {
    let p = probed();
    assert_eq!(p.item_a.selected_subtitle_id.as_deref(), Some(p.item_a.subtitle_tracks[0].id.as_str()));
}

#[test]
fn embedded_subtitle_track_is_probed_as_an_internal_track() {
    let p = probed();
    let streams = &p.info_emb.subtitle_streams;
    let selected = p.item_emb.selected_subtitle_id.clone().unwrap_or_default();
    let detail = format!(
        "subtitleStreams={:?} selected={selected}",
        streams.iter().map(|s| format!("#{}:{}", s.index, s.codec)).collect::<Vec<_>>()
    );
    assert!(
        streams.len() == 1 && streams[0].index == 2 && p.item_emb.subtitle_tracks[0].source == "embedded",
        "{detail}"
    );
}

#[test]
fn the_audio_only_fixture_really_has_no_video_stream() {
    let p = probed();
    let detail = format!(
        "{}s, audio={}, video streams={}",
        p.info_e.duration_sec,
        p.info_e.audio_streams.iter().map(|s| format!("{} {}ch", s.codec, s.channels.unwrap_or(0))).collect::<Vec<_>>().join(","),
        p.info_e.video_streams.len()
    );
    assert!(
        p.info_e.audio_streams.len() == 1 && p.info_e.video_streams.is_empty() && p.info_e.duration_sec > 11.0,
        "{detail}"
    );
}

/* ------------------------------------------------------------------ *
 * 2a. H.264 CBR + burn-in + scaling + fps
 * ------------------------------------------------------------------ */

#[test]
fn burn_in_command_contains_subtitles_filter() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_a, &p.item_a, &burn_session(), &out_file("out_burn.mp4"));
    let vf = vf_of(&built.args);
    let sub = sub_filter_of(&vf);
    assert!(sub.is_some(), "vf={vf}");
}

#[test]
fn subtitles_filter_points_libass_at_the_real_sidecar_path() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_a, &p.item_a, &burn_session(), &out_file("out_burn.mp4"));
    let vf = vf_of(&built.args);
    let sub = sub_filter_of(&vf).unwrap_or_default();
    assert!(
        sub.contains("clip_a.srt") && sub.contains("filename='") && !sub.contains("filename=1"),
        "{sub}"
    );
}

#[test]
fn scale_filter_applied() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_a, &p.item_a, &burn_session(), &out_file("out_burn.mp4"));
    let found = built.args.iter().find(|a| a.contains("scale="));
    assert!(built.args.iter().any(|a| a.contains("scale=1280:-2")), "{:?}", found);
}

#[test]
fn subtitle_application_reported_as_burn_text() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_a, &p.item_a, &burn_session(), &out_file("out_burn.mp4"));
    assert_eq!(built.subtitle_applied, "burn-text");
}

#[test]
fn cbr_rate_control_flags() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_a, &p.item_a, &burn_session(), &out_file("out_burn.mp4"));
    assert!(built.args.iter().any(|a| a == "-maxrate") && built.args.iter().any(|a| a == "-minrate") && built.args.iter().any(|a| a == "-bufsize"));
}

/* ------------------------------------------------------------------ *
 * 2a-ter. burn-in from an EMBEDDED track
 * ------------------------------------------------------------------ */

fn embedded_burn_command() -> BuiltCommand {
    let p = probed();
    build_with_override(&p.info_emb, &p.item_emb, &burn_session(), &out_file("out_burn_emb.mp4"))
}

#[test]
fn embedded_burn_in_points_libass_at_the_media_file_not_at_input_0() {
    let _guard = builder_lock();
    let built = embedded_burn_command();
    let vf = vf_of(&built.args);
    let sub = sub_filter_of(&vf).unwrap_or_default();
    assert!(
        sub.contains("clip_emb.mkv") && !sub.contains("filename='0'"),
        "{sub}"
    );
}

#[test]
fn embedded_burn_in_addresses_the_track_by_subtitle_stream_position() {
    let _guard = builder_lock();
    let built = embedded_burn_command();
    let vf = vf_of(&built.args);
    let sub = sub_filter_of(&vf).unwrap_or_default();
    assert!(sub.contains("si=0") && !sub.contains("si=2"), "{sub}");
}

#[test]
fn selected_second_embedded_track_maps_to_si_1() {
    let _guard = builder_lock();
    let p = probed();
    let mut media_two = p.info_emb.clone();
    media_two.subtitle_streams = vec![sub_stream(2), sub_stream(3)];
    let mut item_two = p.item_emb.clone();
    item_two.subtitle_tracks = vec![SubtitleTrackRef {
        id: "emb:3".into(),
        source: "embedded".into(),
        path: None,
        stream_index: Some(3),
        codec: "subrip".into(),
        family: "text".into(),
        language: None,
        title: None,
        is_default: None,
        is_forced: None,
    }];
    item_two.selected_subtitle_id = Some("emb:3".into());
    let built = build_with_override(&media_two, &item_two, &burn_session(), &out_file("out_burn_two.mp4"));
    let vf = vf_of(&built.args);
    assert!(vf.contains("si=1") && !vf.contains("si=0"), "{vf}");
}

#[test]
fn an_embedded_track_missing_from_the_probe_is_skipped_with_a_warning() {
    let _guard = builder_lock();
    let p = probed();
    let mut item_gone = p.item_emb.clone();
    item_gone.subtitle_tracks = vec![SubtitleTrackRef {
        id: "emb:9".into(),
        source: "embedded".into(),
        path: None,
        stream_index: Some(9),
        codec: "subrip".into(),
        family: "text".into(),
        language: None,
        title: None,
        is_default: None,
        is_forced: None,
    }];
    item_gone.selected_subtitle_id = Some("emb:9".into());
    let built = build_with_override(&p.info_emb, &item_gone, &burn_session(), &out_file("out_burn_gone.mp4"));
    let vf = vf_of(&built.args);
    let expected = i18n::t_params("zh", "main.cmd.burnSourceMissingEmbedded", &[("n", "9".to_string())]);
    assert!(
        !vf.contains("subtitles=") && built.subtitle_applied == "none" && built.warnings.iter().any(|w| w.contains("内嵌字幕") && *w == expected),
        "{:?}",
        built.warnings
    );
}

#[test]
fn buffered_encoder_pass_burns_embedded_subtitles_the_same_way() {
    let _guard = builder_lock();
    let p = probed();
    let enc = encoder_args(&p.info_emb, &p.item_emb, &burn_session());
    let vf = vf_of(&enc.args);
    assert!(vf.contains("subtitles=filename='") && vf.contains("si=0"), "{vf}");
}

/* ------------------------------------------------------------------ *
 * 2a-bis. resolution controls: off / auto height / explicit height
 * ------------------------------------------------------------------ */

#[test]
fn resolution_off_emits_no_scale_filter() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_a, &p.item_a, &base_session(), &out_file("out_scale_off.mp4"));
    let vf = vf_of(&built.args);
    assert!(!vf.contains("scale="), "{vf}");
}

#[test]
fn explicit_width_x_height_reaches_the_filter() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.scale = "1600:900".into();
    settings.video.scale_width = 1600.0;
    settings.video.scale_height = 900.0;
    settings.video.scale_auto = false;
    let built = build_with_override(&p.info_a, &p.item_a, &settings, &out_file("out_scale_explicit.mp4"));
    let vf = vf_of(&built.args);
    assert!(vf.contains("scale=1600:900"), "{}", vf.split(',').next().unwrap_or(""));
}

#[test]
fn auto_height_uses_the_minus_2_placeholder() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.scale = "1600:-2".into();
    settings.video.scale_width = 1600.0;
    settings.video.scale_height = 900.0;
    settings.video.scale_auto = true;
    let built = build_with_override(&p.info_a, &p.item_a, &settings, &out_file("out_scale_auto.mp4"));
    let vf = vf_of(&built.args);
    assert!(vf.contains("scale=1600:-2"), "{}", vf.split(',').next().unwrap_or(""));
}

#[test]
fn zero_geometry_falls_back_to_a_valid_scale() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.scale = "1280:-2".into();
    settings.video.scale_width = 0.0;
    settings.video.scale_height = 0.0;
    settings.video.scale_auto = true;
    let built = build_with_override(&p.info_a, &p.item_a, &settings, &out_file("out_scale_legacy.mp4"));
    let vf = vf_of(&built.args);
    assert!(vf.contains("scale=1920:-2"), "{}", vf.split(',').next().unwrap_or(""));
}

/* ------------------------------------------------------------------ *
 * 2b. seek + itsoffset
 * ------------------------------------------------------------------ */

fn seek_command() -> BuiltCommand {
    let p = probed();
    let mut item = p.item_a.clone();
    item.sync_offset_sec = 0.5;
    item.subtitle_delay_sec = 0.5;
    build_stream_command(&build_request(&p.info_a, &item, &base_session(), 5.0, Some(out_file("out_seek.mp4"))))
        .expect("build_stream_command")
}

#[test]
fn input_seek_applied_before_i() {
    let _guard = builder_lock();
    let built = seek_command();
    let ss = built.args.iter().position(|a| a == "-ss");
    let i = built.args.iter().position(|a| a == "-i");
    assert!(ss.is_some() && i.is_some() && ss.unwrap() < i.unwrap(), "-ss {:?}", arg_after(&built.args, "-ss"));
}

#[test]
fn av_delay_shifts_the_source_input_and_subtitle_delay_compensates_inside_the_filter_chain() {
    let _guard = builder_lock();
    let built = seek_command();
    let offset = arg_after(&built.args, "-itsoffset").unwrap_or("");
    let vf = vf_of(&built.args);
    assert!(
        offset == "0.5" && vf.contains("setpts=PTS-1/TB") && vf.contains("setpts=PTS+1/TB") && vf.contains("subtitles="),
        "-itsoffset {offset}; {vf}"
    );
}

#[test]
fn remaining_duration_reported() {
    let _guard = builder_lock();
    let built = seek_command();
    assert!(
        built.remaining_duration_sec > 14.0 && built.remaining_duration_sec < 15.1,
        "{}s",
        built.remaining_duration_sec
    );
}

/* ------------------------------------------------------------------ *
 * 2b2. libx265 must not receive the H.264 profile name or x264's private options
 * ------------------------------------------------------------------ */

fn hevc_command() -> BuiltCommand {
    let p = probed();
    let mut settings = base_session();
    settings.video.codec = "hevc".into();
    settings.video.encoder = "x265".into();
    settings.video.profile = "high".into();
    settings.video.preset = "p4".into();
    settings.video.bitrate_kbps = 1200.0;
    settings.video.max_bitrate_kbps = 1200.0;
    settings.video.buffer_size_kbps = 2400.0;
    build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_hevc.mp4"))
}

#[test]
fn h264_profile_high_is_normalised_to_an_hevc_profile_for_libx265() {
    let _guard = builder_lock();
    let built = hevc_command();
    assert_eq!(arg_after(&built.args, "-profile:v"), Some("main"));
}

#[test]
fn libx265_receives_its_own_private_options_instead_of_x264_params() {
    let _guard = builder_lock();
    let built = hevc_command();
    let x265_params = arg_after(&built.args, "-x265-params").unwrap_or("");
    assert!(
        !built.args.iter().any(|a| a == "-x264-params") && x265_params.contains("bframes=") && x265_params.contains("keyint="),
        "{x265_params}"
    );
}

#[test]
fn an_nvenc_preset_is_mapped_to_a_legal_libx265_preset() {
    let _guard = builder_lock();
    let built = hevc_command();
    assert_eq!(arg_after(&built.args, "-preset"), Some("faster"));
}

/* ------------------------------------------------------------------ *
 * 2c / 2d. copy video, subtitle copy
 * ------------------------------------------------------------------ */

#[test]
fn copy_mode_emits_c_v_copy() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.codec = "copy".into();
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_copy.flv"));
    assert_eq!(arg_after(&built.args, "-c:v"), Some("copy"));
}

#[test]
fn external_subtitle_copy_is_refused_with_a_warning() {
    let _guard = builder_lock();
    let p = probed();
    let mut item = p.item_a.clone();
    item.mode = "copy".into();
    let built = build_with_override(&p.info_a, &item, &base_session(), &out_file("out_subcopy.flv"));
    let expected = i18n::t("zh", "main.cmd.externalSubNoTrack");
    assert!(
        built.subtitle_applied == "none" && built.warnings.iter().any(|w| w.contains("外部字幕") && *w == expected),
        "{:?}",
        built.warnings
    );
}

/* ------------------------------------------------------------------ *
 * 2e. RTMP target composition
 * ------------------------------------------------------------------ */

fn rtmp_composition_command() -> BuiltCommand {
    let p = probed();
    let mut settings = base_session();
    settings.output.server = "rtmp://a.example.com/live/".into();
    settings.output.stream_key = "KEY-123".into();
    build_to_target(&p.info_b, &mode_off(&p.item_b), &settings)
}

#[test]
fn address_with_trailing_slash_plus_key_stays_a_single_slash() {
    let _guard = builder_lock();
    let built = rtmp_composition_command();
    assert_eq!(built.args.last().map(|s| s.as_str()), Some("rtmp://a.example.com/live/KEY-123"));
}

#[test]
fn flv_muxer_selected() {
    let _guard = builder_lock();
    let built = rtmp_composition_command();
    assert_eq!(arg_after(&built.args, "-f"), Some("flv"));
}

#[test]
fn reconnect_flags_present_for_rtmp() {
    let _guard = builder_lock();
    let built = rtmp_composition_command();
    assert!(built.args.iter().any(|a| a == "-reconnect"));
}

#[test]
fn build_rtmp_target_concatenates_the_key_directly_no_slash_inserted() {
    assert_eq!(build_rtmp_target("rtmp://h/live", "abc"), "rtmp://h/liveabc");
}

#[test]
fn build_rtmp_target_keeps_the_slash_the_user_typed() {
    assert_eq!(build_rtmp_target("rtmp://h/live/", "abc"), "rtmp://h/live/abc");
}

#[test]
fn build_rtmp_target_tolerates_whitespace_and_slashes_in_the_key() {
    assert_eq!(build_rtmp_target("rtmp://h/live/", "/abc?x=1"), "rtmp://h/live/abc?x=1");
}

#[test]
fn build_rtmp_target_without_a_key_returns_the_address_only() {
    assert_eq!(build_rtmp_target("rtmp://h/live/", ""), "rtmp://h/live/");
    assert_eq!(build_rtmp_target("rtmp://h/live", ""), "rtmp://h/live");
}

#[test]
fn build_rtmp_target_with_an_empty_address_is_empty() {
    assert_eq!(build_rtmp_target("", "abc"), "");
}

/* ------------------------------------------------------------------ *
 * 2f. stream protocols: detection, target composition, per-protocol output args
 * ------------------------------------------------------------------ */

#[test]
fn detection_rtmp_rtmps_srt_rtsp_rtsps_whip_schemes() {
    assert_eq!(detect_stream_protocol("rtmp://h/live"), "rtmp");
    assert_eq!(detect_stream_protocol("rtmps://h/live"), "rtmp");
    assert_eq!(detect_stream_protocol("srt://h:9000"), "srt");
    assert_eq!(detect_stream_protocol("rtsp://h:554/a"), "rtsp");
    assert_eq!(detect_stream_protocol("rtsps://h/a"), "rtsp");
    assert_eq!(detect_stream_protocol("https://h/whip"), "whip");
}

#[test]
fn detection_unknown_or_bare_addresses_fall_back_to_rtmp() {
    assert_eq!(detect_stream_protocol("h/live"), "rtmp");
    assert_eq!(detect_stream_protocol(""), "rtmp");
    assert_eq!(detect_stream_protocol("webrtc://h/x"), "rtmp");
}

#[test]
fn webrtc_is_not_accepted_as_a_whip_target() {
    assert!(!address_matches_protocol("webrtc://h/x", Some("whip")));
    assert!(address_matches_protocol("https://h/whip", Some("whip")));
}

#[test]
fn srt_key_rides_as_a_passphrase_query_parameter() {
    assert_eq!(build_push_target("srt://h:9000", "secret123", Some("srt")), "srt://h:9000?passphrase=secret123");
}

#[test]
fn srt_passphrase_joins_with_ampersand_when_the_address_already_has_a_query() {
    assert_eq!(
        build_push_target("srt://h:9000?mode=caller", "secret123", Some("srt")),
        "srt://h:9000?mode=caller&passphrase=secret123"
    );
}

#[test]
fn srt_passphrase_is_percent_encoded_and_never_duplicated() {
    assert_eq!(build_push_target("srt://h:9000", "a&b=c", Some("srt")), "srt://h:9000?passphrase=a%26b%3Dc");
    assert_eq!(build_push_target("srt://h:9000?passphrase=x", "y", Some("srt")), "srt://h:9000?passphrase=x");
}

#[test]
fn whip_target_keeps_the_address_only_key_travels_separately() {
    assert_eq!(build_push_target("https://h/whip", "JWT.X.Y", Some("whip")), "https://h/whip");
}

#[test]
fn rtsp_key_appends_to_the_path_like_rtmp() {
    assert_eq!(build_push_target("rtsp://h:8554/live", "key", Some("rtsp")), "rtsp://h:8554/livekey");
}

#[test]
fn protocol_key_args_whip_carries_the_key_via_authorization() {
    assert_eq!(protocol_key_args(Some("whip"), "tok"), vec!["-authorization".to_string(), "tok".to_string()]);
}

#[test]
fn protocol_key_args_address_carried_protocols_add_none() {
    assert!(protocol_key_args(Some("rtmp"), "k").is_empty());
    assert!(protocol_key_args(Some("srt"), "k").is_empty());
    assert!(protocol_key_args(Some("rtsp"), "k").is_empty());
    assert!(protocol_key_args(Some("whip"), "").is_empty());
}

#[test]
fn scheme_validation_matches_its_protocol_only() {
    assert!(address_matches_protocol("srt://h", Some("srt")));
    assert!(!address_matches_protocol("rtmp://h", Some("srt")));
    assert!(address_matches_protocol("rtmps://h", Some("rtmp")));
    assert!(address_matches_protocol("http://h/x", Some("whip")));
}

#[test]
fn network_clamps_to_what_the_protocol_runs_over() {
    assert_eq!(network_for_protocol(Some("rtmp"), Some("udp")), "tcp");
    assert_eq!(network_for_protocol(Some("srt"), Some("tcp")), "udp");
    assert_eq!(network_for_protocol(Some("whip"), Some("udp")), "tcp");
    assert_eq!(network_for_protocol(Some("rtsp"), Some("udp")), "udp");
}

#[test]
fn muxer_container_derivation_per_protocol() {
    assert_eq!(muxer_for_protocol(Some("rtmp")), "flv");
    assert_eq!(muxer_for_protocol(Some("srt")), "mpegts");
    assert_eq!(muxer_for_protocol(Some("rtsp")), "rtsp");
    assert_eq!(muxer_for_protocol(Some("whip")), "whip");
    assert_eq!(container_for_protocol(Some("rtmp")).as_deref(), Some("flv"));
    assert_eq!(container_for_protocol(Some("srt")).as_deref(), Some("mpegts"));
    assert_eq!(container_for_protocol(Some("rtsp")), None);
    assert_eq!(container_for_protocol(Some("whip")), None);
}

#[test]
fn derivation_tolerates_settings_from_older_schemas_no_protocol() {
    assert_eq!(muxer_for_protocol(None), "flv");
    assert_eq!(muxer_for_protocol(Some("")), "flv");
    assert_eq!(container_for_protocol(None).as_deref(), Some("flv"));
    assert_eq!(container_for_protocol(Some("")).as_deref(), Some("flv"));
}

fn protocol_stream_command(tweak: impl FnOnce(&mut rtmp_file_streamer::shared::types::OutputSettings)) -> BuiltCommand {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    tweak(&mut settings.output);
    build_to_target(&p.info_b, &mode_off(&p.item_b), &settings)
}

#[test]
fn srt_stream_uses_mpegts_muxer_passphrase_target_and_no_flv_flags() {
    let built = protocol_stream_command(|o| {
        o.protocol = "srt".into();
        o.network = "udp".into();
        o.server = "srt://a.example.com:9000".into();
        o.stream_key = "pass12345".into();
    });
    assert_eq!(built.args.last().map(|s| s.as_str()), Some("srt://a.example.com:9000?passphrase=pass12345"));
    assert_eq!(arg_after(&built.args, "-f"), Some("mpegts"));
    assert!(!built.args.iter().any(|a| a == "-flvflags") && !built.args.iter().any(|a| a == "-reconnect"));
}

#[test]
fn rtsp_stream_uses_rtsp_muxer_and_chosen_transport() {
    let tcp = protocol_stream_command(|o| {
        o.protocol = "rtsp".into();
        o.network = "tcp".into();
        o.server = "rtsp://a.example.com:8554/push".into();
        o.stream_key = "".into();
    });
    let udp = protocol_stream_command(|o| {
        o.protocol = "rtsp".into();
        o.network = "udp".into();
        o.server = "rtsp://a.example.com:8554/push".into();
        o.stream_key = "".into();
    });
    assert_eq!(tcp.args.last().map(|s| s.as_str()), Some("rtsp://a.example.com:8554/push"));
    assert_eq!(arg_after(&tcp.args, "-f"), Some("rtsp"));
    assert_eq!(arg_after(&tcp.args, "-rtsp_transport"), Some("tcp"));
    assert_eq!(arg_after(&udp.args, "-rtsp_transport"), Some("udp"));
}

#[test]
fn whip_stream_uses_whip_muxer_and_bearer_token_via_authorization() {
    let built = protocol_stream_command(|o| {
        o.protocol = "whip".into();
        o.network = "tcp".into();
        o.server = "https://a.example.com/whip/endpoint".into();
        o.stream_key = "jwt-token".into();
    });
    assert_eq!(built.args.last().map(|s| s.as_str()), Some("https://a.example.com/whip/endpoint"));
    assert_eq!(arg_after(&built.args, "-f"), Some("whip"));
    assert_eq!(arg_after(&built.args, "-authorization"), Some("jwt-token"));
}

#[test]
fn whip_plus_aac_audio_produces_the_opus_requirement_warning() {
    let built = protocol_stream_command(|o| {
        o.protocol = "whip".into();
        o.server = "https://a.example.com/whip/endpoint".into();
        o.stream_key = "jwt-token".into();
    });
    assert!(built.warnings.iter().any(|w| w.contains("Opus")), "{:?}", built.warnings);
}

#[test]
fn whip_plus_hevc_produces_the_h264_requirement_warning() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.output.protocol = "whip".into();
    settings.output.server = "https://a.example.com/whip/endpoint".into();
    settings.output.stream_key = "jwt-token".into();
    settings.video.codec = "hevc".into();
    let built = build_to_target(&p.info_b, &mode_off(&p.item_b), &settings);
    assert!(built.warnings.iter().any(|w| w.contains("H.264")), "{:?}", built.warnings);
}

#[test]
fn connection_test_follows_the_protocol_srt() {
    let _guard = builder_lock();
    let mut session = base_session();
    session.output.protocol = "srt".into();
    session.output.server = "srt://127.0.0.1:9000".into();
    session.output.stream_key = "pass12345".into();
    let built = build_test_command(&session, "srt://127.0.0.1:9000", "pass12345", "zh");
    assert_eq!(built.args.last().map(|s| s.as_str()), Some("srt://127.0.0.1:9000?passphrase=pass12345"));
    assert_eq!(last_arg_after(&built.args, "-f"), Some("mpegts"));
}

/* ------------------------------------------------------------------ *
 * 2e-bis. cover art must never be mapped instead of the real video
 * ------------------------------------------------------------------ */

#[test]
fn attached_pic_cover_art_is_not_selected_as_the_video_stream() {
    let _guard = builder_lock();
    let media = cover_art_media(false);
    let built = build_with_override(&media, &item_without_subtitles(), &base_session(), &out_file("out_cover.mp4"));
    assert_eq!(built.video_stream_index, 1, "mapped {:?}", arg_after(&built.args, "-map"));
}

#[test]
fn real_video_stream_mapped_by_absolute_index() {
    let _guard = builder_lock();
    let media = cover_art_media(false);
    let built = build_with_override(&media, &item_without_subtitles(), &base_session(), &out_file("out_cover.mp4"));
    assert_eq!(arg_after(&built.args, "-map"), Some("0:1"));
}

#[test]
fn audio_stream_mapped_by_absolute_index() {
    let _guard = builder_lock();
    let media = cover_art_media(false);
    let built = build_with_override(&media, &item_without_subtitles(), &base_session(), &out_file("out_cover.mp4"));
    assert_eq!(last_arg_after(&built.args, "-map"), Some("0:2"));
}

#[test]
fn a_file_with_only_cover_art_gets_a_generated_picture_instead_of_the_cover() {
    let _guard = builder_lock();
    let media = cover_art_media(true);
    let built = build_with_override(&media, &item_without_subtitles(), &base_session(), &out_file("out_cover_only.mp4"));
    let expected = i18n::t("zh", "main.cmd.noVideoTrack");
    assert!(
        built.video_stream_index == -1
            && built.black_video
            && built.args.iter().any(|a| a.starts_with("color=c=black"))
            && built.warnings.iter().any(|w| *w == expected),
        "{:?}",
        built.warnings
    );
}

#[test]
fn cover_art_only_plus_video_copy_warns_that_the_stream_is_audio_only() {
    let _guard = builder_lock();
    let media = cover_art_media(true);
    let mut settings = base_session();
    settings.video.codec = "copy".into();
    let built = build_with_override(&media, &item_without_subtitles(), &settings, &out_file("out_cover_copy.mp4"));
    let expected = i18n::t("zh", "main.cmd.noVideoTrackCopy");
    assert!(!built.black_video && built.warnings.iter().any(|w| *w == expected), "{:?}", built.warnings);
}

/* ------------------------------------------------------------------ *
 * 2f. hardware encoder selection + synthetic available-set mappings
 * ------------------------------------------------------------------ */

#[test]
fn hardware_encoder_requested_is_honoured_when_available() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.encoder = "h264_amf".into();
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_hw.mp4"));
    // With the default capability set only libx264 is confirmed, so the AMF
    // request resolves through the auto preference; the resolution is what the
    // record documents.
    assert!(
        built.venc_name == "h264_amf" || built.venc_name == "libx264",
        "resolved to {}",
        built.venc_name
    );
}

#[test]
fn amf_pixel_format_switched_to_nv12_when_the_request_is_honoured() {
    let _guard = builder_lock();
    let _override = EncoderOverride::set(&["libx264", "h264_amf"]);
    let p = probed();
    let mut settings = base_session();
    settings.video.encoder = "h264_amf".into();
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_hw_amf.mp4"));
    assert_eq!(built.venc_name, "h264_amf");
    assert_eq!(arg_after(&built.args, "-pix_fmt"), Some("nv12"));
    // AMF preset/tune normalisation: 'ultrafast' maps to the speed quality, and
    // zerolatency maps to the low-latency usage.
    assert_eq!(arg_after(&built.args, "-quality"), Some("speed"));
    assert_eq!(arg_after(&built.args, "-usage"), Some("lowlatency"));
}

#[test]
fn nvenc_receives_the_nvenc_preset_namespace_and_cbr_flags() {
    let _guard = builder_lock();
    let _override = EncoderOverride::set(&["libx264", "h264_nvenc"]);
    let p = probed();
    let mut settings = base_session();
    settings.video.encoder = "h264_nvenc".into();
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_hw_nvenc.mp4"));
    assert_eq!(built.venc_name, "h264_nvenc");
    assert_eq!(arg_after(&built.args, "-preset"), Some("p4"));
    assert_eq!(arg_after(&built.args, "-tune"), Some("ull"));
    assert_eq!(arg_after(&built.args, "-rc"), Some("cbr"));
    assert_eq!(arg_after(&built.args, "-nal-hrd"), Some("cbr"));
    assert_eq!(arg_after(&built.args, "-pix_fmt"), Some("yuv420p"));
    assert!(!built.args.iter().any(|a| a == "-x264-params"));
}

#[test]
fn qsv_pixel_format_switched_to_nv12_with_medium_preset() {
    let _guard = builder_lock();
    let _override = EncoderOverride::set(&["libx264", "h264_qsv"]);
    let p = probed();
    let mut settings = base_session();
    settings.video.encoder = "h264_qsv".into();
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_hw_qsv.mp4"));
    assert_eq!(built.venc_name, "h264_qsv");
    assert_eq!(arg_after(&built.args, "-pix_fmt"), Some("nv12"));
    assert_eq!(arg_after(&built.args, "-preset"), Some("medium"));
    assert_eq!(arg_after(&built.args, "-look_ahead"), Some("0"));
}

#[test]
fn svt_av1_uses_its_own_preset_and_rate_control_without_a_tune() {
    let _guard = builder_lock();
    let _override = EncoderOverride::set(&["libx264", "libsvtav1"]);
    let p = probed();
    let mut settings = base_session();
    settings.video.codec = "av1".into();
    settings.video.encoder = "svt-av1".into();
    settings.video.rate_control = "crf".into();
    settings.video.crf = 30.0;
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_svtav1.flv"));
    assert_eq!(built.venc_name, "libsvtav1");
    assert_eq!(arg_after(&built.args, "-preset"), Some("8"));
    assert_eq!(arg_after(&built.args, "-crf"), Some("30"));
    assert_eq!(arg_after(&built.args, "-b:v"), Some("0"));
    assert!(!built.args.iter().any(|a| a == "-tune"));
}

#[test]
fn aom_av1_on_flv_opts_into_experimental_and_uses_cpu_used() {
    let _guard = builder_lock();
    let _override = EncoderOverride::set(&["libx264", "libaom-av1"]);
    let p = probed();
    let mut settings = base_session();
    settings.video.codec = "av1".into();
    settings.video.encoder = "aom-av1".into();
    settings.video.rate_control = "crf".into();
    settings.video.crf = 30.0;
    let built = build_with_override(&p.info_b, &mode_off(&p.item_b), &settings, &out_file("out_aomav1.flv"));
    assert_eq!(built.venc_name, "libaom-av1");
    assert_eq!(arg_after(&built.args, "-cpu-used"), Some("8"));
    assert_eq!(arg_after(&built.args, "-usage"), Some("realtime"));
    assert_eq!(arg_after(&built.args, "-lag-in-frames"), Some("0"));
    // The FLV muxer treats AV1 as experimental; libaom opts in explicitly.
    assert_eq!(arg_after(&built.args, "-strict"), Some("experimental"));
}

#[test]
fn encoder_arg_for_maps_via_a_synthetic_available_set() {
    let available: HashSet<String> = ["libx264", "h264_amf"].iter().map(|s| s.to_string()).collect();
    assert_eq!(encoder_arg_for("h264_amf", "h264", &available), ("h264_amf".to_string(), "amf".to_string()));
    // 'auto' walks the hardware-first preference order.
    assert_eq!(encoder_arg_for("auto", "h264", &available), ("h264_amf".to_string(), "amf".to_string()));
    // A requested encoder that is not available falls through to the auto order.
    assert_eq!(encoder_arg_for("h264_nvenc", "h264", &available), ("h264_amf".to_string(), "amf".to_string()));
    let only_x264: HashSet<String> = ["libx264".to_string()].into_iter().collect();
    assert_eq!(encoder_arg_for("auto", "h264", &only_x264), ("libx264".to_string(), "software".to_string()));
    // Last resort: the software encoder of the requested codec even unlisted.
    assert_eq!(encoder_arg_for("auto", "av1", &HashSet::new()), ("libsvtav1".to_string(), "software".to_string()));
    // A copy codec resolves to copy before anything else is consulted.
    assert_eq!(encoder_arg_for("x264", "copy", &available), ("copy".to_string(), "copy".to_string()));
}

/* ------------------------------------------------------------------ *
 * 3b. network send-rate metering
 * ------------------------------------------------------------------ */

#[test]
fn a_steady_1mbit_counter_reads_back_as_1000_kbps() {
    let t0 = 1_000_000.0;
    let mut steady = ByteRateMeter::new();
    let mut bytes = 0.0;
    for i in 0..=20 {
        steady.add(bytes, t0 + i as f64 * 500.0);
        bytes += 62_500.0;
    }
    let kbps = steady.kbps(t0 + 10_000.0);
    assert!((kbps - 1000.0).abs() < 20.0, "{kbps:.0} kbit/s");
}

#[test]
fn one_sample_is_not_a_rate() {
    let t0 = 1_000_000.0;
    let mut meter = ByteRateMeter::new();
    meter.add(125_000.0, t0 + 500.0);
    assert_eq!(meter.kbps(t0 + 500.0), 0.0);
}

#[test]
fn the_startup_burst_is_not_published_as_a_rate() {
    let t0 = 1_000_000.0;
    let mut bursting = ByteRateMeter::new();
    bursting.add(400_000.0, t0 + 300.0);
    bursting.add(600_000.0, t0 + 800.0);
    assert_eq!(bursting.kbps(t0 + 800.0), 0.0);
}

#[test]
fn a_counter_reset_does_not_produce_a_negative_rate() {
    let t0 = 1_000_000.0;
    let mut bursting = ByteRateMeter::new();
    bursting.add(400_000.0, t0 + 300.0);
    bursting.add(600_000.0, t0 + 800.0);
    bursting.add(2_000.0, t0 + 1300.0);
    let after = bursting.kbps(t0 + 1300.0);
    assert!(after >= 0.0 && after < 4000.0, "{after:.0} kbit/s after a reset");
}

#[test]
fn a_stalled_counter_reads_zero_rather_than_a_stale_rate() {
    let t0 = 1_000_000.0;
    let mut idle = ByteRateMeter::new();
    idle.add(50_000.0, t0);
    idle.add(50_000.0, t0 + 5000.0);
    assert_eq!(idle.kbps(t0 + 5000.0), 0.0);
}

#[test]
fn the_figure_follows_the_recent_window_not_the_session_average() {
    let t0 = 1_000_000.0;
    let mut changing = ByteRateMeter::new();
    let mut moving = 0.0;
    for i in 0..=8 {
        changing.add(moving, t0 + i as f64 * 500.0);
        moving += if i < 4 { 62_500.0 } else { 250_000.0 };
    }
    let fast = changing.kbps(t0 + 4000.0);
    assert!(fast > 1500.0, "{fast:.0} kbit/s after the rate quadrupled");
}

#[test]
fn a_reset_meter_reports_nothing_until_it_has_history_again() {
    let t0 = 1_000_000.0;
    let mut cleared = ByteRateMeter::new();
    cleared.add(100_000.0, t0);
    cleared.add(200_000.0, t0 + 2000.0);
    cleared.reset();
    cleared.add(100_000.0, t0 + 3000.0);
    assert_eq!(cleared.kbps(t0 + 5000.0), 0.0);
}

/* ------------------------------------------------------------------ *
 * 11. stand-in tracks: command vectors
 * ------------------------------------------------------------------ */

#[test]
fn a_video_only_file_generates_a_silent_audio_track() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_d, &mode_off(&p.item_d), &base_session(), &out_file("out_standin_audio.mp4"));
    assert!(
        built.silent_audio && !built.black_video && built.aenc_name == "aac" && built.audio_stream_index == -1,
        "silentAudio={} aenc={} sourceAudioIndex={}",
        built.silent_audio,
        built.aenc_name,
        built.audio_stream_index
    );
}

#[test]
fn the_silence_is_generated_with_the_configured_codec_rate_and_layout_and_mapped_as_its_own_input() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_d, &mode_off(&p.item_d), &base_session(), &out_file("out_standin_audio.mp4"));
    let re = regex::Regex::new(r"^anullsrc=channel_layout=stereo:sample_rate=44100:d=\d").unwrap();
    assert!(
        built.args.iter().any(|a| re.is_match(a))
            && built.args.iter().any(|a| a == "-shortest")
            && has_map(&built.args, "1:a:0"),
        "{:?}",
        built.args.iter().filter(|a| a.starts_with("anullsrc")).collect::<Vec<_>>()
    );
}

#[test]
fn an_audio_only_file_generates_a_black_video_track() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_e, &mode_off(&p.item_e), &base_session(), &out_file("out_standin_video.mp4"));
    assert!(
        built.black_video && !built.silent_audio && built.video_stream_index == -1 && built.venc_name != "copy",
        "blackVideo={} venc={} sourceVideoIndex={}",
        built.black_video,
        built.venc_name,
        built.video_stream_index
    );
}

#[test]
fn the_black_picture_is_generated_at_the_default_geometry_with_the_session_frame_rate() {
    let _guard = builder_lock();
    let p = probed();
    let built = build_with_override(&p.info_e, &mode_off(&p.item_e), &base_session(), &out_file("out_standin_video.mp4"));
    let re = regex::Regex::new(r"^color=c=black:s=1280x720:r=30:d=\d").unwrap();
    assert!(
        built.args.iter().any(|a| re.is_match(a)) && built.args.iter().any(|a| a == "-shortest"),
        "{:?}",
        built.args.iter().filter(|a| a.starts_with("color=")).collect::<Vec<_>>()
    );
}

#[test]
fn a_configured_resolution_is_what_the_black_picture_is_generated_at() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.scale = "640:360".into();
    settings.video.scale_width = 640.0;
    settings.video.scale_height = 360.0;
    settings.video.scale_auto = false;
    let built = build_with_override(&p.info_e, &mode_off(&p.item_e), &settings, &out_file("out_standin_scaled.mp4"));
    let re = regex::Regex::new(r"^color=c=black:s=640x360:r=30:d=\d").unwrap();
    assert!(built.args.iter().any(|a| re.is_match(a)));
}

#[test]
fn a_burned_sidecar_is_read_by_libass_not_added_as_an_input_that_shifts_the_generated_track() {
    let _guard = builder_lock();
    let p = probed();
    let srt_ref = p
        .item_a
        .subtitle_tracks
        .iter()
        .find(|t| t.source == "external")
        .expect("clip_a sidecar")
        .clone();
    let mut item = p.item_e.clone();
    item.subtitle_tracks = vec![srt_ref.clone()];
    item.selected_subtitle_id = Some(srt_ref.id);
    item.mode = "burn".into();
    let built = build_with_override(&p.info_e, &item, &base_session(), &out_file("out_standin_subs.mp4"));
    let mut inputs: Vec<String> = Vec::new();
    for i in 1..built.args.len() {
        if built.args[i - 1] == "-i" {
            inputs.push(built.args[i].clone());
        }
    }
    let vf = vf_of(&built.args);
    assert!(
        inputs.len() == 2 && !inputs.iter().any(|p| p.ends_with(".srt")) && has_map(&built.args, "1:v:0") && vf.contains("subtitles="),
        "inputs={inputs:?}, vf={vf}"
    );
}

#[test]
fn audio_copy_on_a_file_with_no_audio_invents_nothing_and_says_so() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.audio.codec = "copy".into();
    let built = build_with_override(&p.info_d, &mode_off(&p.item_d), &settings, &out_file("out_standin_copy.mp4"));
    let expected = i18n::t("zh", "main.cmd.noAudioTrackCopy");
    assert!(
        !built.silent_audio && !built.args.iter().any(|a| a == "-shortest") && built.warnings.iter().any(|w| *w == expected),
        "{:?}",
        built.warnings
    );
}

#[test]
fn audio_none_leaves_the_stream_video_only_without_generating_anything() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.audio.codec = "none".into();
    let built = build_with_override(&p.info_d, &mode_off(&p.item_d), &settings, &out_file("out_standin_none.mp4"));
    let maps = built.args.iter().filter(|a| a.as_str() == "-map").count();
    assert!(!built.silent_audio && !built.args.iter().any(|a| a == "-shortest") && maps == 1, "maps={maps}");
}

#[test]
fn video_copy_on_a_file_with_no_video_pushes_audio_only_and_says_so() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.video.codec = "copy".into();
    let built = build_with_override(&p.info_e, &mode_off(&p.item_e), &settings, &out_file("out_standin_copyv.mp4"));
    let expected = i18n::t("zh", "main.cmd.noVideoTrackCopy");
    assert!(
        !built.black_video
            && !built.args.iter().any(|a| a == "-shortest")
            && built.venc_name == "copy"
            && built.warnings.iter().any(|w| *w == expected),
        "{:?}",
        built.warnings
    );
}

#[test]
fn realtime_pacing_adds_re_before_the_input() {
    let _guard = builder_lock();
    let p = probed();
    let mut settings = base_session();
    settings.output.realtime_pacing = true;
    let built = build_to_target(&p.info_b, &mode_off(&p.item_b), &settings);
    let re = built.args.iter().position(|a| a == "-re");
    let i = built.args.iter().position(|a| a == "-i");
    assert!(re.is_some() && i.is_some() && re.unwrap() < i.unwrap());
}

/* ------------------------------------------------------------------ *
 * 7. connection test command (used by the UI button)
 * ------------------------------------------------------------------ */

#[test]
fn test_command_builds_lavfi_sources() {
    let built = test_cmd(|_| {});
    assert!(
        built.args.iter().any(|a| a.contains("testsrc2=size=640x360:rate=30:duration=5")),
        "{:?}",
        arg_after(&built.args, "-i")
    );
}

#[test]
fn test_command_targets_the_address_plus_key_with_the_flv_muxer() {
    let built = test_cmd(|_| {});
    assert_eq!(built.args.last().map(|s| s.as_str()), Some("rtmp://127.0.0.1:11935/livekey123"));
    assert_eq!(last_arg_after(&built.args, "-f"), Some("flv"));
}

#[test]
fn test_honours_the_audio_codec() {
    let built = test_cmd(|s| {
        s.audio.codec = "libmp3lame".into();
        s.audio.rate_control = "vbr".into();
        s.audio.bitrate_kbps = 320.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
    });
    assert_eq!(arg_after(&built.args, "-c:a"), Some("libmp3lame"));
}

#[test]
fn test_honours_the_audio_sample_rate() {
    let built = test_cmd(|s| {
        s.audio.codec = "libmp3lame".into();
        s.audio.rate_control = "vbr".into();
        s.audio.bitrate_kbps = 320.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
    });
    assert_eq!(arg_after(&built.args, "-ar"), Some("22050"));
}

#[test]
fn test_honours_the_audio_channel_count() {
    let built = test_cmd(|s| {
        s.audio.codec = "libmp3lame".into();
        s.audio.rate_control = "vbr".into();
        s.audio.bitrate_kbps = 320.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
    });
    assert_eq!(arg_after(&built.args, "-ac"), Some("1"));
}

#[test]
fn test_honours_audio_vbr_no_ba_qa_instead() {
    let built = test_cmd(|s| {
        s.audio.codec = "libmp3lame".into();
        s.audio.rate_control = "vbr".into();
        s.audio.bitrate_kbps = 320.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
    });
    assert!(
        built.args.iter().any(|a| a == "-q:a") && !built.args.iter().any(|a| a == "-b:a"),
        "-q:a {:?}",
        arg_after(&built.args, "-q:a")
    );
}

#[test]
fn test_honours_loudnorm() {
    let built = test_cmd(|s| {
        s.audio.codec = "libmp3lame".into();
        s.audio.rate_control = "vbr".into();
        s.audio.bitrate_kbps = 320.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
    });
    let af = arg_after(&built.args, "-af").unwrap_or("");
    assert!(af.contains("loudnorm=I=-16"), "{af}");
}

#[test]
fn test_keeps_the_resample_format_filters_the_real_command_uses() {
    let built = test_cmd(|s| {
        s.audio.codec = "libmp3lame".into();
        s.audio.rate_control = "vbr".into();
        s.audio.bitrate_kbps = 320.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 1.0;
        s.audio.loudnorm = true;
    });
    let af = arg_after(&built.args, "-af").unwrap_or("");
    assert!(af.contains("aresample=22050") && af.contains("channel_layouts=mono"), "{af}");
}

#[test]
fn test_honours_the_audio_bitrate_for_cbr() {
    let built = test_cmd(|s| {
        s.audio.codec = "aac".into();
        s.audio.rate_control = "cbr".into();
        s.audio.bitrate_kbps = 96.0;
        s.audio.sample_rate = 48000.0;
        s.audio.channels = 2.0;
    });
    assert_eq!(arg_after(&built.args, "-b:a"), Some("96k"));
}

#[test]
fn test_omits_loudnorm_when_it_is_off() {
    let built = test_cmd(|s| {
        s.audio.codec = "aac".into();
        s.audio.rate_control = "cbr".into();
        s.audio.bitrate_kbps = 96.0;
        s.audio.sample_rate = 48000.0;
        s.audio.channels = 2.0;
    });
    assert!(!built.args.iter().any(|a| a.contains("loudnorm")));
}

#[test]
fn test_forces_48khz_for_opus_but_keeps_its_bitrate() {
    let built = test_cmd(|s| {
        s.audio.codec = "libopus".into();
        s.audio.bitrate_kbps = 64.0;
        s.audio.sample_rate = 22050.0;
        s.audio.channels = 2.0;
    });
    assert_eq!(arg_after(&built.args, "-ar"), Some("48000"));
    assert_eq!(arg_after(&built.args, "-b:a"), Some("64k"));
}

#[test]
fn audio_none_pushes_video_only() {
    let built = test_cmd(|s| {
        s.audio.codec = "none".into();
    });
    let joined = built.args.join(" ");
    assert!(
        !built.args.iter().any(|a| a == "-an") && !built.args.iter().any(|a| a == "-c:a") && joined.contains("-map 0:v:0"),
        "{}",
        built.summary.join(" · ")
    );
}

#[test]
fn audio_copy_is_reported_instead_of_silently_tested_as_a_copy() {
    let built = test_cmd(|s| {
        s.audio.codec = "copy".into();
    });
    let expected = i18n::t("zh", "main.cmd.testCopyAudioNote");
    assert!(
        arg_after(&built.args, "-c:a") == Some("aac") && built.notes.iter().any(|n| n.contains("复制源音频") && *n == expected),
        "{:?}",
        built.notes
    );
}

#[test]
fn test_honours_the_video_codec() {
    let built = test_cmd(|s| {
        s.video.codec = "hevc".into();
        s.video.encoder = "x265".into();
        s.video.bitrate_kbps = 3000.0;
        s.video.fps = 25.0;
        s.video.scale = "1280:720".into();
        s.video.scale_width = 1280.0;
        s.video.scale_height = 720.0;
        s.video.scale_auto = false;
        s.video.keyframe_interval_sec = 1.0;
    });
    assert_eq!(arg_after(&built.args, "-c:v"), Some("libx265"));
}

#[test]
fn test_generates_the_pattern_at_the_configured_resolution() {
    let built = test_cmd(|s| {
        s.video.codec = "hevc".into();
        s.video.encoder = "x265".into();
        s.video.bitrate_kbps = 3000.0;
        s.video.fps = 25.0;
        s.video.scale = "1280:720".into();
        s.video.scale_width = 1280.0;
        s.video.scale_height = 720.0;
        s.video.scale_auto = false;
        s.video.keyframe_interval_sec = 1.0;
    });
    assert!(built.args.iter().any(|a| a.contains("testsrc2=size=1280x720:rate=25:duration=5")));
}

#[test]
fn test_honours_the_configured_cbr_bitrate() {
    let built = test_cmd(|s| {
        s.video.codec = "hevc".into();
        s.video.encoder = "x265".into();
        s.video.bitrate_kbps = 3000.0;
        s.video.fps = 25.0;
        s.video.scale = "1280:720".into();
        s.video.scale_width = 1280.0;
        s.video.scale_height = 720.0;
        s.video.scale_auto = false;
        s.video.keyframe_interval_sec = 1.0;
    });
    assert_eq!(arg_after(&built.args, "-b:v"), Some("3000k"));
    assert_eq!(arg_after(&built.args, "-minrate"), Some("3000k"));
}

#[test]
fn test_derives_the_gop_from_the_configured_keyframe_interval() {
    let built = test_cmd(|s| {
        s.video.codec = "hevc".into();
        s.video.encoder = "x265".into();
        s.video.bitrate_kbps = 3000.0;
        s.video.fps = 25.0;
        s.video.scale = "1280:720".into();
        s.video.scale_width = 1280.0;
        s.video.scale_height = 720.0;
        s.video.scale_auto = false;
        s.video.keyframe_interval_sec = 1.0;
    });
    assert_eq!(arg_after(&built.args, "-g"), Some("25"));
}

#[test]
fn an_oversized_output_is_capped_so_the_test_stays_quick() {
    let built = test_cmd(|s| {
        s.video.scale = "3840:-2".into();
        s.video.scale_width = 3840.0;
        s.video.scale_height = 2160.0;
        s.video.scale_auto = true;
    });
    assert!(
        built.args.iter().any(|a| a.contains("testsrc2=size=1280x720:rate=30:duration=5")),
        "{:?}",
        built.args.iter().find(|a| a.starts_with("testsrc2="))
    );
}

#[test]
fn video_copy_is_reported_instead_of_silently_tested_as_a_copy() {
    let built = test_cmd(|s| {
        s.video.codec = "copy".into();
    });
    let expected = i18n::t("zh", "main.cmd.testCopyVideoNote");
    assert!(
        arg_after(&built.args, "-c:v") == Some("libx264") && built.notes.iter().any(|n| n.contains("直接复制") && *n == expected),
        "{:?}",
        built.notes
    );
}

#[test]
fn test_appends_the_custom_output_arguments_exactly_once() {
    let built = test_cmd(|s| {
        s.output.extra_output_args = "-flvflags no_duration_filesize -metadata comment=x".into();
        s.output.drop_late_frames = true;
    });
    let flv_flags_count = built.args.iter().filter(|a| a.as_str() == "-flvflags").count();
    assert!(
        built.args.iter().any(|a| a == "-metadata") && flv_flags_count == 1,
        "-flvflags x{flv_flags_count}"
    );
}

#[test]
fn test_honours_drop_late_frames() {
    let built = test_cmd(|s| {
        s.output.extra_output_args = "-flvflags no_duration_filesize -metadata comment=x".into();
        s.output.drop_late_frames = true;
    });
    assert_eq!(arg_after(&built.args, "-fflags"), Some("+genpts+igndts"));
    assert_eq!(arg_after(&built.args, "-max_delay"), Some("0"));
}

#[test]
fn test_applies_the_always_on_flv_flag_by_default() {
    let built = test_cmd(|_| {});
    let count = built.args.iter().filter(|a| a.as_str() == "-flvflags").count();
    assert_eq!(count, 1, "-flvflags {:?}", arg_after(&built.args, "-flvflags"));
}

#[test]
fn test_follows_the_protocol_derived_container() {
    let built = test_cmd_at("srt://127.0.0.1:9000/live", "key123", |s| {
        s.output.protocol = "srt".into();
        s.output.network = "udp".into();
        s.output.server = "srt://127.0.0.1:9000/live".into();
        s.output.extra_output_args = "".into();
    });
    assert_eq!(last_arg_after(&built.args, "-f"), Some("mpegts"));
    assert!(!built.args.iter().any(|a| a == "-flvflags"));
    assert_eq!(built.args.last().map(|s| s.as_str()), Some("srt://127.0.0.1:9000/live?passphrase=key123"));
}

#[test]
fn test_result_summarises_the_settings_it_used() {
    let built = test_cmd(|s| {
        s.audio.bitrate_kbps = 192.0;
        s.video.bitrate_kbps = 4500.0;
    });
    let summary = built.summary.join(" · ");
    assert!(summary.contains("4500kbps") && summary.contains("192kbps") && summary.contains("aac"), "{summary}");
}

#[test]
fn an_flv_opus_combination_warns_before_the_connection_is_blamed() {
    let built = test_cmd(|s| {
        s.audio.codec = "libopus".into();
    });
    let notes = built.notes.join(" | ");
    assert!(notes.contains("Opus"), "{notes}");
}

/* ------------------------------------------------------------------ *
 * Small public helpers the vectors lean on (split_output_args quoting,
 * even-dimension rounding, filter-path escaping).
 * ------------------------------------------------------------------ */

#[test]
fn split_output_args_splits_plain_flags() {
    assert_eq!(
        split_output_args("  -flvflags no_duration_filesize -metadata comment=x  "),
        vec!["-flvflags", "no_duration_filesize", "-metadata", "comment=x"]
    );
    assert!(split_output_args("   ").is_empty());
}

#[test]
fn split_output_args_keeps_quoted_values_and_honours_escapes() {
    assert_eq!(split_output_args("-metadata title='my stream'"), vec!["-metadata", "title=my stream"]);
    assert_eq!(split_output_args(r#"-metadata "two words""#), vec!["-metadata", "two words"]);
    assert_eq!(split_output_args("a\\ b"), vec!["a b"]);
}

#[test]
fn even_dimension_rounds_to_the_smallest_legal_even_value() {
    assert_eq!(even_dimension(853.0, 1920.0), 854.0);
    assert_eq!(even_dimension(1080.4, 0.0), 1080.0);
    assert_eq!(even_dimension(1919.0, 1920.0), 1920.0);
    assert_eq!(even_dimension(1.0, 640.0), 640.0, "below the floor the fallback wins");
    assert_eq!(even_dimension(f64::NAN, 1280.0), 1280.0);
}

#[test]
fn escape_filter_path_escapes_the_filter_metacharacters() {
    let escaped = escape_filter_path("a'b[0];c d\\e");
    assert!(escaped.contains("\\'") && escaped.contains("\\[0\\]") && escaped.contains("\\;"), "{escaped}");
    // Backslashes in the path itself become forward slashes.
    assert!(escaped.ends_with("d/e"), "{escaped}");
    #[cfg(windows)]
    {
        let win = escape_filter_path("C:\\some dir\\clip_a.srt");
        assert!(win.contains("C\\:/some dir/clip_a.srt"), "{win}");
    }
}
