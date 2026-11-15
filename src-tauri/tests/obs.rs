//! obs-websocket endpoint integration test: real TCP, real framing. Ports the
//! checks of `test/obs-websocket.mjs` (section 9 of the TS harness): HTTP
//! upgrade + handshake, HELLO shape, challenge/response auth (success and
//! failure), the request dispatch (GetVersion / SetStreamServiceSettings /
//! StartStream / StopStream), the generic success for unknown requests and the
//! 403 for unidentified ones.

use futures_util::{SinkExt, StreamExt};
use rtmp_file_streamer::obs::websocket::{obs_auth_string, ObsWebSocketDeps, ObsWebSocketServer};
use rtmp_file_streamer::shared::types::ObsWebSocketSettings;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// The settings port goes through the same normalisation the app uses
/// (0 -> 4455), so two tests running in parallel would race for that port.
/// Hold this for the whole test body to serialise them.
static PORT_LOCK: Mutex<()> = Mutex::new(());

struct DepsState {
    settings: ObsWebSocketSettings,
    target: (String, String),
    applied: Vec<(Option<String>, Option<String>)>,
    starts: u32,
    stops: u32,
    logs: Vec<(String, String)>,
}

fn make_deps(state: Arc<Mutex<DepsState>>) -> ObsWebSocketDeps {
    ObsWebSocketDeps {
        settings: Arc::new({
            let state = Arc::clone(&state);
            move || state.lock().expect("deps state").settings.clone()
        }),
        stream_target: Arc::new({
            let state = Arc::clone(&state);
            move || state.lock().expect("deps state").target.clone()
        }),
        apply_stream_target: Arc::new({
            let state = Arc::clone(&state);
            move |server, key| {
                let mut s = state.lock().expect("deps state");
                s.applied.push((server, key));
                Ok(())
            }
        }),
        engine_state: Arc::new(|| "idle".to_string()),
        start_stream: Arc::new({
            let state = Arc::clone(&state);
            move || {
                if let Ok(mut s) = state.lock() {
                    s.starts += 1;
                }
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = tx.send(());
                rx
            }
        }),
        stop_stream: Arc::new({
            let state = Arc::clone(&state);
            move || {
                if let Ok(mut s) = state.lock() {
                    s.stops += 1;
                }
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = tx.send(());
                rx
            }
        }),
        log: Arc::new({
            let state = Arc::clone(&state);
            move |level, message| {
                if let Ok(mut s) = state.lock() {
                    s.logs.push((level.to_string(), message));
                }
            }
        }),
        t: Arc::new(|key, _| key.to_string()),
    }
}

/// A minimal websocket client on tokio-tungstenite, just enough for the checks.
struct WsClient {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

impl WsClient {
    async fn connect(port: u16) -> Self {
        let (ws, _response) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .expect("ws connect");
        Self { ws }
    }

    async fn send_json(&mut self, value: serde_json::Value) {
        self.ws.send(Message::Text(value.to_string().into())).await.expect("send");
    }

    /// Reads the next text message. A server-initiated close is reported as
    /// `(8, "<close code> <reason>")` so callers can assert on WHY.
    async fn read_frame(&mut self) -> (u8, String) {
        loop {
            let msg = self.ws.next().await.expect("stream ended").expect("ws error");
            match msg {
                Message::Text(text) => {
                    let text: String = text.as_str().to_owned();
                    let parsed: serde_json::Value = serde_json::from_str(&text).expect("json frame");
                    let op = parsed["op"].as_u64().unwrap_or(u64::MAX) as u8;
                    return (op, text);
                }
                Message::Close(frame) => {
                    let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((0, String::new()));
                    return (8, format!("{code} {reason}"));
                }
                _ => continue,
            }
        }
    }

    /// Sends a request and reads the matching response (skipping anything else).
    async fn request(&mut self, request_type: &str, request_data: serde_json::Value) -> serde_json::Value {
        self.send_json(serde_json::json!({
            "op": 6,
            "d": { "requestType": request_type, "requestId": "test-1", "requestData": request_data },
        }))
        .await;
        loop {
            let (op, text) = self.read_frame().await;
            let _ = op;
            let msg: serde_json::Value = serde_json::from_str(&text).expect("json frame");
            if msg["op"].as_u64() == Some(7) {
                return msg;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn obs_endpoint_handshake_auth_and_dispatch() {
    let _serial = PORT_LOCK.lock().expect("port lock");
    let port = free_port();
    let state = Arc::new(Mutex::new(DepsState {
        settings: ObsWebSocketSettings {
            enabled: true,
            host: "127.0.0.1".into(),
            port: port as f64,
            password: "sesame".into(),
        },
        target: ("rtmp://127.0.0.1/live".into(), "key".into()),
        applied: Vec::new(),
        starts: 0,
        stops: 0,
        logs: Vec::new(),
    }));
    let server = ObsWebSocketServer::new(make_deps(Arc::clone(&state)));
    let status = server.apply().await;
    assert!(status.running, "server did not start: {}", status.error);

    // --- HELLO carries the auth challenge ---
    let mut client = WsClient::connect(port).await;
    let (opcode, hello_text) = client.read_frame().await;
    assert_eq!(opcode, 0, "op 0 = Hello");
    let hello: serde_json::Value = serde_json::from_str(&hello_text).expect("hello json");
    assert_eq!(hello["op"].as_u64(), Some(0), "op 0 = Hello");
    assert_eq!(hello["d"]["rpcVersion"].as_u64(), Some(1));
    assert_eq!(hello["d"]["obsWebSocketVersion"].as_str(), Some("5.5.2"));
    assert_eq!(hello["d"]["publisher"].as_str(), Some("RTMP File Streamer"));
    let auth = &hello["d"]["authentication"];
    let salt = auth["salt"].as_str().expect("salt").to_string();
    let challenge = auth["challenge"].as_str().expect("challenge").to_string();

    // --- wrong password is refused with 4009 + a close carrying the reason ---
    client
        .send_json(serde_json::json!({
            "op": 1,
            "d": { "rpcVersion": 1, "authentication": obs_auth_string("wrong", &salt, &challenge) },
        }))
        .await;
    let (op, close_text) = client.read_frame().await;
    assert_eq!(op, 8, "expected a close frame, got: {close_text}");
    assert!(close_text.contains("4009") && close_text.contains("authentication failed"), "{close_text}");
    drop(client);

    // --- correct password identifies ---
    let mut client = WsClient::connect(port).await;
    let (_, hello_text) = client.read_frame().await;
    let hello: serde_json::Value = serde_json::from_str(&hello_text).expect("hello json");
    let salt = hello["d"]["authentication"]["salt"].as_str().expect("salt").to_string();
    let challenge = hello["d"]["authentication"]["challenge"].as_str().expect("challenge").to_string();
    client
        .send_json(serde_json::json!({
            "op": 1,
            "d": { "rpcVersion": 1, "authentication": obs_auth_string("sesame", &salt, &challenge) },
        }))
        .await;
    let (_, identified_text) = client.read_frame().await;
    let identified: serde_json::Value = serde_json::from_str(&identified_text).expect("identified json");
    assert_eq!(identified["op"].as_u64(), Some(2), "op 2 = Identified");
    assert_eq!(identified["d"]["negotiatedRpcVersion"].as_u64(), Some(1));

    let status = server.status();
    assert_eq!(status.clients, 1, "one identified client");

    // --- GetVersion ---
    let response = client.request("GetVersion", serde_json::json!({})).await;
    assert_eq!(response["d"]["requestStatus"]["result"].as_bool(), Some(true));
    assert_eq!(response["d"]["responseData"]["rpcVersion"].as_u64(), Some(1));
    assert_eq!(response["d"]["responseData"]["platformDescription"].as_str(), Some("RTMP File Streamer"));

    // --- SetStreamServiceSettings writes through to the deps ---
    let response = client
        .request(
            "SetStreamServiceSettings",
            serde_json::json!({ "streamServiceSettings": { "server": "rtmp://elsewhere/live", "streamKey": "k2" } }),
        )
        .await;
    assert_eq!(response["d"]["requestStatus"]["result"].as_bool(), Some(true));
    let deps_state = state.lock().expect("deps state");
    assert_eq!(deps_state.applied.len(), 1);
    assert_eq!(deps_state.applied[0].0.as_deref(), Some("rtmp://elsewhere/live"));
    assert_eq!(deps_state.applied[0].1.as_deref(), Some("k2"));
    drop(deps_state);

    // --- empty server is invalidData ---
    let response = client
        .request(
            "SetStreamServiceSettings",
            serde_json::json!({ "streamServiceSettings": { "server": "" } }),
        )
        .await;
    assert_eq!(response["d"]["requestStatus"]["code"].as_u64(), Some(400));

    // --- StartStream / StopStream reach the engine bridge ---
    let response = client.request("StartStream", serde_json::json!({})).await;
    assert_eq!(response["d"]["requestStatus"]["result"].as_bool(), Some(true));
    let response = client.request("StopStream", serde_json::json!({})).await;
    assert_eq!(response["d"]["requestStatus"]["result"].as_bool(), Some(true));
    let deps_state = state.lock().expect("deps state");
    assert_eq!(deps_state.starts, 1);
    assert_eq!(deps_state.stops, 1);
    drop(deps_state);

    // --- an unknown request is a generic success (the OBS-compat contract) ---
    let response = client.request("SetRecordDirectory", serde_json::json!({})).await;
    assert_eq!(response["d"]["requestStatus"]["result"].as_bool(), Some(true));

    // --- GetStreamStatus mirrors the engine state ---
    let response = client.request("GetStreamStatus", serde_json::json!({})).await;
    assert_eq!(response["d"]["responseData"]["outputActive"].as_bool(), Some(false));

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn obs_endpoint_requires_identification() {
    let _serial = PORT_LOCK.lock().expect("port lock");
    let port = free_port();
    let state = Arc::new(Mutex::new(DepsState {
        settings: ObsWebSocketSettings {
            enabled: true,
            host: "127.0.0.1".into(),
            port: port as f64,
            password: String::new(), // auth disabled
        },
        target: ("rtmp://127.0.0.1/live".into(), String::new()),
        applied: Vec::new(),
        starts: 0,
        stops: 0,
        logs: Vec::new(),
    }));
    let server = ObsWebSocketServer::new(make_deps(Arc::clone(&state)));
    let status = server.apply().await;
    assert!(status.running, "{}", status.error);

    let mut client = WsClient::connect(port).await;
    let (_, hello_text) = client.read_frame().await;
    let hello: serde_json::Value = serde_json::from_str(&hello_text).expect("hello json");
    // No password configured: the Hello carries no authentication block.
    assert!(hello["d"]["authentication"].is_null(), "{hello}");

    // An unidentified request is answered 403, not silently served.
    let response = client.request("GetVersion", serde_json::json!({})).await;
    assert_eq!(response["d"]["requestStatus"]["code"].as_u64(), Some(403));

    // Identify without a password, then the same request succeeds.
    client.send_json(serde_json::json!({ "op": 1, "d": { "rpcVersion": 1 } })).await;
    let (_, identified_text) = client.read_frame().await;
    let identified: serde_json::Value = serde_json::from_str(&identified_text).expect("identified json");
    assert_eq!(identified["op"].as_u64(), Some(2));
    let response = client.request("GetVersion", serde_json::json!({})).await;
    assert_eq!(response["d"]["requestStatus"]["result"].as_bool(), Some(true));

    server.stop().await;
    let _ = AtomicU32::new(0).load(Ordering::SeqCst); // keep the import honest
}

/// Probes an ephemeral port. The probe listener is dropped before the server
/// binds; the PORT_LOCK keeps the two tests from probing the same instant.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind for port")
        .local_addr()
        .expect("local addr")
        .port()
}
