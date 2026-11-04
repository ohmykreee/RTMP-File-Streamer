//! Stream protocol support: detection from the address, the ffmpeg muxer each
//! protocol needs, and how the stream key is carried per protocol.
//! Port of `src/shared/protocol.ts` + `src/shared/rtmp.ts`.
//!
//! One address field, one key field — no extra UI per protocol. The key field's
//! MEANING follows the protocol:
//!  - RTMP/RTMPS: appended directly to the address (see `rtmp.rs`)
//!  - SRT: appended directly to the address too — no `passphrase` parameter is
//!    built for it, so an encryption passphrase belongs in the address itself
//!  - RTSP: appended directly to the address path; full user:pass authentication
//!    can be written into the address itself
//!  - WHIP: sent as the muxer's Bearer token (`-authorization`, a JWT)

use crate::shared::types::{ContainerName, StreamNetwork, StreamProtocol};

pub const STREAM_PROTOCOLS: [&str; 4] = ["rtmp", "srt", "rtsp", "whip"];
pub const DEFAULT_STREAM_PROTOCOL: &str = "rtmp";

/// The ffmpeg output muxer each protocol pushes with.
pub fn protocol_muxer(protocol: &str) -> &'static str {
    match protocol {
        "srt" => "mpegts",
        "rtsp" => "rtsp",
        "whip" => "whip",
        _ => "flv", // rtmp and anything unknown fall back to the default
    }
}

/// The container each protocol effectively carries; RTSP/WHIP map to none.
pub fn protocol_container(protocol: &str) -> Option<&'static str> {
    match protocol {
        "srt" => Some("mpegts"),
        "rtsp" | "whip" => None,
        _ => Some("flv"),
    }
}

/// Network transports each protocol's media actually travels over. SRT is
/// UDP-only and RTMP is TCP-only; RTSP is the one protocol with a real choice.
///
/// WHIP is the easy one to get wrong: only its HTTP(S) signalling (the SDP
/// POST/PATCH and the DELETE) goes over TCP. The media itself is WebRTC — ICE,
/// DTLS and SRTP datagrams — so it rides UDP. ffmpeg's `whip` muxer has no
/// transport option and keeps the first UDP ICE candidate only, so there is
/// nothing to choose here: do not "restore" TCP because the endpoint is http(s).
fn protocol_networks(protocol: &str) -> &'static [&'static str] {
    match protocol {
        "srt" => &["udp"],
        "rtsp" => &["tcp", "udp"],
        "whip" => &["udp"],
        _ => &["tcp"], // rtmp
    }
}

/// Clamps a network choice to what the protocol allows.
pub fn network_for_protocol(protocol: Option<&str>, network: Option<&str>) -> StreamNetwork {
    let allowed = protocol_networks(protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL));
    if let Some(n) = network {
        if allowed.contains(&n) {
            return n.to_string();
        }
    }
    allowed[0].to_string()
}

/// Detects the protocol from the address scheme. Unknown or missing schemes fall
/// back to RTMP rather than guessing from the host or port.
pub fn detect_stream_protocol(address: &str) -> StreamProtocol {
    let url = address.trim().to_ascii_lowercase();
    if url.starts_with("rtmp://") || url.starts_with("rtmps://") {
        return "rtmp".into();
    }
    if url.starts_with("srt://") {
        return "srt".into();
    }
    if url.starts_with("rtsp://") || url.starts_with("rtsps://") {
        return "rtsp".into();
    }
    // WHIP is an HTTP(S) handshake; `webrtc://` is deliberately not detected.
    if url.starts_with("http://") || url.starts_with("https://") {
        return "whip".into();
    }
    DEFAULT_STREAM_PROTOCOL.into()
}

/// The address schemes each protocol accepts, for validation messages.
pub fn protocol_schemes(protocol: &str) -> &'static str {
    match protocol {
        "srt" => "srt://",
        "rtsp" => "rtsp:// · rtsps://",
        "whip" => "http:// · https://",
        _ => "rtmp:// · rtmps://",
    }
}

/// True when the address scheme matches the protocol.
pub fn address_matches_protocol(address: &str, protocol: Option<&str>) -> bool {
    let url = address.trim().to_ascii_lowercase();
    let p = protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL);
    // A hand-edited settings file can carry an unknown protocol; treating it as
    // rtmp here would print a wrong scheme list and let a bad value through.
    if !STREAM_PROTOCOLS.contains(&p) {
        return false;
    }
    match p {
        "rtmp" => url.starts_with("rtmp://") || url.starts_with("rtmps://"),
        "srt" => url.starts_with("srt://"),
        "rtsp" => url.starts_with("rtsp://") || url.starts_with("rtsps://"),
        "whip" => url.starts_with("http://") || url.starts_with("https://"),
        _ => false,
    }
}

/// The ffmpeg muxer for a protocol, tolerating settings objects from older schemas.
pub fn muxer_for_protocol(protocol: Option<&str>) -> String {
    protocol_muxer(protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL)).to_string()
}

/// The effective container for a protocol, tolerating settings from older
/// schemas. RTSP and WHIP legitimately map to `None`.
pub fn container_for_protocol(protocol: Option<&str>) -> Option<ContainerName> {
    protocol_container(protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL)).map(|c| c.to_string())
}

/// Builds the ffmpeg push target for a protocol.
///
/// RTMP/RTMPS, SRT and RTSP carry the key IN the address — appended directly, the
/// rule `build_rtmp_target` implements, with no separator and no query parameter
/// of its own (an SRT passphrase, if one is needed, has to be written into the
/// address). WHIP does not carry it in the address at all: the key rides in the
/// muxer's own `-authorization` option (see `protocol_key_args`).
pub fn build_push_target(address: &str, stream_key: &str, protocol: Option<&str>) -> String {
    let base = address.trim();
    let key = stream_key.trim();
    if base.is_empty() {
        return String::new();
    }
    let p = protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL);
    if p == "whip" {
        return base.to_string();
    }
    build_rtmp_target(base, key)
}

/// RTMP target composition: the stream key is appended **directly** to the
/// address — the app never inserts a separator. The only normalisation is
/// whitespace trimming and collapsing a doubled separator when the user typed
/// BOTH a trailing `/` on the address and a leading `/` on the key.
pub fn build_rtmp_target(address: &str, stream_key: &str) -> String {
    let base = address.trim();
    let key = stream_key.trim();
    if base.is_empty() {
        return String::new();
    }
    if key.is_empty() {
        return base.to_string();
    }
    if base.ends_with('/') && key.starts_with('/') {
        return format!("{base}{}", &key[1..]);
    }
    format!("{base}{key}")
}

/// Output arguments carrying the stream key for protocols whose key does NOT
/// ride in the address. WHIP's muxer takes the Bearer token via its own
/// `-authorization` option.
pub fn protocol_key_args(protocol: Option<&str>, stream_key: &str) -> Vec<String> {
    let key = stream_key.trim();
    if key.is_empty() {
        return vec![];
    }
    if protocol.unwrap_or(DEFAULT_STREAM_PROTOCOL) == "whip" {
        return vec!["-authorization".into(), key.to_string()];
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtmp_target_appends_key_directly() {
        assert_eq!(build_rtmp_target("rtmp://127.0.0.1/live/", "abc"), "rtmp://127.0.0.1/live/abc");
        assert_eq!(build_rtmp_target("rtmp://127.0.0.1/live", "abc"), "rtmp://127.0.0.1/liveabc");
        assert_eq!(build_rtmp_target("rtmp://127.0.0.1/live/", "/abc"), "rtmp://127.0.0.1/live/abc");
        assert_eq!(build_rtmp_target("rtmp://127.0.0.1/live/", ""), "rtmp://127.0.0.1/live/");
        assert_eq!(build_rtmp_target("", "abc"), "");
    }

    #[test]
    fn push_target_per_protocol() {
        assert_eq!(build_push_target("rtmp://h/live/", "k", Some("rtmp")), "rtmp://h/live/k");
        assert_eq!(build_push_target("srt://h:9000", "k", Some("srt")), "srt://h:9000k");
        assert_eq!(build_push_target("srt://h:9000/live/", "k", Some("srt")), "srt://h:9000/live/k");
        assert_eq!(build_push_target("https://w/h", "k", Some("whip")), "https://w/h");
        assert_eq!(build_push_target("rtsp://h/live", "k", Some("rtsp")), "rtsp://h/livek");
    }

    #[test]
    fn protocol_detection() {
        assert_eq!(detect_stream_protocol("RTMP://x"), "rtmp");
        assert_eq!(detect_stream_protocol("rtmps://x"), "rtmp");
        assert_eq!(detect_stream_protocol("srt://x"), "srt");
        assert_eq!(detect_stream_protocol("rtsps://x"), "rtsp");
        assert_eq!(detect_stream_protocol("https://x"), "whip");
        assert_eq!(detect_stream_protocol("webrtc://x"), "rtmp");
        assert_eq!(detect_stream_protocol(""), "rtmp");
    }

    #[test]
    fn network_clamping() {
        assert_eq!(network_for_protocol(Some("rtmp"), Some("udp")), "tcp");
        assert_eq!(network_for_protocol(Some("rtsp"), Some("udp")), "udp");
        assert_eq!(network_for_protocol(Some("srt"), Some("tcp")), "udp");
        assert_eq!(network_for_protocol(Some("whip"), Some("udp")), "udp");
        assert_eq!(network_for_protocol(None, None), "tcp");
    }

    #[test]
    fn whip_key_args() {
        assert_eq!(protocol_key_args(Some("whip"), "tok"), vec!["-authorization", "tok"]);
        assert_eq!(protocol_key_args(Some("rtmp"), "tok"), Vec::<String>::new());
        assert_eq!(protocol_key_args(Some("whip"), ""), Vec::<String>::new());
    }
}
