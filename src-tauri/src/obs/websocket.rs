//! A minimal obs-websocket v5 compatible control endpoint. Port of
//! `src/main/obs/websocket.ts`, including the hand-rolled RFC 6455 framing
//! (the original avoided a websocket library for bundle reasons; keeping the
//! same framing here preserves its exact wire behaviour, close codes included).

use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// obs-websocket 5.x reports its own version in the version object.
pub const OBS_WS_VERSION: &str = "5.5.2";
pub const OBS_WS_RPC_VERSION: u32 = 1;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SUBPROTOCOL: &str = "obswebsocket.json";
/// Requests larger than this are refused outright (protects against garbage).
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// How long a socket may sit in the HTTP upgrade phase before it is dropped.
const HANDSHAKE_TIMEOUT_MS: u64 = 5000;

/// obs-websocket opcodes.
const OP_HELLO: u8 = 0;
const OP_IDENTIFY: u8 = 1;
const OP_IDENTIFIED: u8 = 2;
const OP_REIDENTIFY: u8 = 3;
const OP_REQUEST: u8 = 6;
const OP_REQUEST_RESPONSE: u8 = 7;

/// obs-websocket `RequestStatus` codes.
const REQUEST_STATUS_SUCCESS: u32 = 100;
const REQUEST_STATUS_INVALID_DATA: u32 = 400;
const REQUEST_STATUS_NOT_IDENTIFIED: u32 = 403;

use crate::shared::defaults::{OBS_PORT_MAX, OBS_PORT_MIN};
use crate::shared::types::ObsWebSocketSettings;

/// Message lookup for the log lines this server produces (injected like the TS
/// `t` dep; defaults to the reference language).
pub type ObsTranslateFn = Arc<dyn Fn(&str, Vec<(&'static str, String)>) -> String + Send + Sync>;

pub struct ObsWebSocketDeps {
    pub settings: Arc<dyn Fn() -> ObsWebSocketSettings + Send + Sync>,
    /// RTMP destination currently configured (address + stream key).
    pub stream_target: Arc<dyn Fn() -> (String, String) + Send + Sync>,
    /// Writes address/key back into the session settings. Errors are the
    /// validation messages the protocol reports as `invalidData`.
    pub apply_stream_target:
        Arc<dyn Fn(Option<String>, Option<String>) -> Result<(), String> + Send + Sync>,
    pub engine_state: Arc<dyn Fn() -> String + Send + Sync>,
    pub start_stream: Arc<dyn Fn() -> tokio::sync::oneshot::Receiver<()> + Send + Sync>,
    pub stop_stream: Arc<dyn Fn() -> tokio::sync::oneshot::Receiver<()> + Send + Sync>,
    pub log: Arc<dyn Fn(&str, String) + Send + Sync>,
    pub t: ObsTranslateFn,
}

impl ObsWebSocketDeps {
    fn tr(&self, key: &str, params: Vec<(&'static str, String)>) -> String {
        (self.t)(key, params)
    }
}

struct ServerInner {
    /// The accept-loop task; taken and aborted on stop.
    accept_task: Option<tokio::task::AbortHandle>,
    bound_host: String,
    bound_port: u16,
    running_key: String,
    generation: u64,
    last_error: String,
}

pub struct ObsWebSocketServer {
    deps: ObsWebSocketDeps,
    inner: Mutex<ServerInner>,
    identified: Arc<AtomicUsize>,
    /// Bumped by every start/stop; client tasks exit when it moves on.
    shared_generation: Arc<std::sync::atomic::AtomicU64>,
    /// Serializes `apply()`: the bind is async, and two applies arriving inside
    /// that window both pass the de-duplication check and race for the port —
    /// the loser's listener publish is skipped by the generation check while
    /// its socket keeps the port held, and the status lands on "port in use".
    /// The Electron original was synchronous, so this restores that ordering.
    apply_chain: tokio::sync::Mutex<()>,
}

fn sha256_base64(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(digest)
}

/// The obs-websocket challenge-response: `base64(sha256(base64(sha256(pass+salt)) + challenge))`.
pub fn obs_auth_string(password: &str, salt: &str, challenge: &str) -> String {
    let secret = sha256_base64(&format!("{password}{salt}"));
    sha256_base64(&format!("{secret}{challenge}"))
}

fn random_base64_16() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn normalize_port(value: f64) -> u16 {
    let n = value.round();
    if !n.is_finite() || n < OBS_PORT_MIN {
        return 4455;
    }
    (OBS_PORT_MAX.min(n)) as u16
}

/// Loopback addresses either stack can report.
fn is_loopback(host: &str) -> bool {
    host == "127.0.0.1" || host == "::1" || host == "localhost"
}

/// Browsers send `Origin`; native obs-websocket clients do not. Only the app's
/// own page (`tauri://` / `file://`) and a local dev server may connect from a
/// browser context.
fn is_allowed_origin(origin: &str) -> bool {
    if origin == "null" || origin == "file://" || origin.starts_with("tauri://") || origin.starts_with("http://tauri.localhost") {
        return true;
    }
    // The `new URL(origin)` port: scheme://host[:port]/…; parse minimally.
    let Some((scheme, rest)) = origin.split_once("://") else { return false };
    let scheme = scheme.to_ascii_lowercase();
    let host_part = rest.split('/').next().unwrap_or("");
    let host = host_part.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_part);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (scheme == "http" || scheme == "https")
        && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

/// Encodes one unmasked server -> client frame.
fn encode_frame(payload: &[u8], opcode: u8) -> Vec<u8> {
    let len = payload.len();
    let mut header: Vec<u8> = Vec::with_capacity(10 + len);
    header.push(0x80 | opcode);
    if len < 126 {
        header.push(len as u8);
    } else if len < 65536 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    header.extend_from_slice(payload);
    header
}

#[derive(Debug)]
enum DecodeOutcome {
    /// A complete frame: bytes consumed, fin, opcode, payload.
    Frame(usize, bool, u8, Vec<u8>),
    /// Not enough bytes yet.
    Incomplete,
    /// Protocol violation (unmasked or oversized frame).
    Violation,
}

/// Decodes the next complete frame. Client frames are always masked; an
/// unmasked one is a protocol error, so the connection is torn down instead of
/// guessing.
fn decode_frame(buf: &[u8]) -> DecodeOutcome {
    if buf.len() < 2 {
        return DecodeOutcome::Incomplete;
    }
    let b0 = buf[0];
    let b1 = buf[1];
    let fin = b0 & 0x80 != 0;
    let opcode = b0 & 0x0f;
    let masked = b1 & 0x80 != 0;
    let mut len = (b1 & 0x7f) as usize;
    let mut offset = 2usize;
    if len == 126 {
        if buf.len() < offset + 2 {
            return DecodeOutcome::Incomplete;
        }
        len = u16::from_be_bytes([buf[offset], buf[offset + 1]]) as usize;
        offset += 2;
    } else if len == 127 {
        if buf.len() < offset + 8 {
            return DecodeOutcome::Incomplete;
        }
        let big = u64::from_be_bytes(buf[offset..offset + 8].try_into().expect("8 bytes"));
        if big > MAX_FRAME_BYTES as u64 {
            return DecodeOutcome::Violation;
        }
        len = big as usize;
        offset += 8;
    }
    if len > MAX_FRAME_BYTES {
        return DecodeOutcome::Violation;
    }
    if !masked {
        return DecodeOutcome::Violation;
    }
    if buf.len() < offset + 4 + len {
        return DecodeOutcome::Incomplete;
    }
    let mask = &buf[offset..offset + 4];
    offset += 4;
    let mut payload = vec![0u8; len];
    for (i, byte) in payload.iter_mut().enumerate() {
        *byte = buf[offset + i] ^ mask[i & 3];
    }
    DecodeOutcome::Frame(offset + len, fin, opcode, payload)
}

/* ------------------------------------------------------------------ *
 * Per-connection state
 * ------------------------------------------------------------------ */

struct ClientState {
    id: u64,
    buffer: Vec<u8>,
    fragment: Option<Vec<u8>>,
    fragment_opcode: u8,
    upgraded: bool,
    identified: bool,
    session_id: String,
    remote: String,
    auth_salt: Option<String>,
    auth_challenge: Option<String>,
}

impl ClientState {
    fn new(id: u64, remote: String) -> Self {
        Self {
            id,
            buffer: Vec::new(),
            fragment: None,
            fragment_opcode: 0,
            upgraded: false,
            identified: false,
            session_id: String::new(),
            remote,
            auth_salt: None,
            auth_challenge: None,
        }
    }
}

impl ObsWebSocketServer {
    pub fn new(deps: ObsWebSocketDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            inner: Mutex::new(ServerInner {
                accept_task: None,
                bound_host: String::new(),
                bound_port: 0,
                running_key: String::new(),
                generation: 0,
                last_error: String::new(),
            }),
            identified: Arc::new(AtomicUsize::new(0)),
            shared_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            apply_chain: tokio::sync::Mutex::new(()),
        })
    }

    pub fn status(&self) -> crate::shared::types::ObsWebSocketStatus {
        let inner = self.inner.lock().expect("obs inner lock");
        let configured = (self.deps.settings)();
        let host = if inner.accept_task.is_some() {
            inner.bound_host.clone()
        } else if !configured.host.is_empty() {
            configured.host.clone()
        } else {
            "127.0.0.1".into()
        };
        let port = if inner.accept_task.is_some() {
            inner.bound_port as f64
        } else {
            configured.port
        };
        // `0.0.0.0` is a bind address, not something a client can connect to;
        // show the loopback equivalent instead.
        let connect_host = match host.as_str() {
            "0.0.0.0" => "127.0.0.1",
            "::" => "::1",
            other => other,
        };
        let running = inner.accept_task.is_some();
        let error = inner.last_error.clone();
        drop(inner);
        let url = format!("ws://{}:{port}", if connect_host.contains(':') { format!("[{connect_host}]") } else { connect_host.to_string() });
        crate::shared::types::ObsWebSocketStatus {
            running,
            host,
            port,
            url,
            clients: self.identified.load(Ordering::SeqCst) as u32,
            error,
        }
    }

    /// Applies the current settings; safe to call on every settings change.
    pub async fn apply(self: &Arc<Self>) -> crate::shared::types::ObsWebSocketStatus {
        // One apply at a time: a second caller waits here and then hits the
        // de-duplication check below instead of starting a second listener.
        let _serial = self.apply_chain.lock().await;
        let cfg = (self.deps.settings)();
        if !cfg.enabled {
            let was_running = {
                let mut inner = self.inner.lock().expect("obs inner lock");
                let was = inner.accept_task.is_some();
                Self::stop_locked(&mut inner);
                inner.last_error = String::new();
                was
            };
            if was_running {
                (self.deps.log)("info", self.deps.tr("main.engine.obsStopped", vec![]));
            }
            return self.status();
        }

        let host = if cfg.host.trim().is_empty() { "127.0.0.1".to_string() } else { cfg.host.trim().to_string() };
        let port = normalize_port(cfg.port);
        // The password is part of the identity: changing it must drop existing
        // connections, which were authorised against the old one.
        let key = format!("{host}|{port}|{}", cfg.password);
        // `status()` takes the same lock, so the guard must be dropped before
        // calling it — a std Mutex is not reentrant and this branch deadlocked
        // the whole command queue once applies were serialized.
        let already_running = {
            let inner = self.inner.lock().expect("obs inner lock");
            inner.accept_task.is_some() && inner.running_key == key
        };
        if already_running {
            return self.status();
        }

        self.stop().await;
        self.start(host, port, key).await;
        self.status()
    }

    fn stop_locked(inner: &mut ServerInner) {
        inner.generation += 1;
        inner.running_key = String::new();
        if let Some(task) = inner.accept_task.take() {
            task.abort();
        }
    }

    pub async fn stop(self: &Arc<Self>) {
        // Clients are owned by their own tasks; aborting the accept loop plus
        // dropping the listener (it is owned by that task) starves them, and
        // each client task exits when its socket dies. A full stop also kills
        // them via the generation check below.
        {
            let mut inner = self.inner.lock().expect("obs inner lock");
            Self::stop_locked(&mut inner);
        }
        // Drop every existing client (matching the TS dropClient loop) and
        // reset the identified count: client tasks observe the generation bump
        // on their next loop iteration and close.
        self.shared_generation.fetch_add(1, Ordering::SeqCst);
        self.identified.store(0, Ordering::SeqCst);
    }

    async fn start(self: &Arc<Self>, host: String, port: u16, key: String) {
        {
            let mut inner = self.inner.lock().expect("obs inner lock");
            inner.last_error = String::new();
            inner.generation += 1;
        }
        let generation = self.inner.lock().expect("obs inner lock").generation;
        let listener = TcpListener::bind((host.as_str(), port)).await;
        let listener = match listener {
            Ok(l) => l,
            Err(err) => {
                let message = if err.kind() == std::io::ErrorKind::AddrInUse {
                    self.deps.tr("main.engine.obsPortInUse", vec![("port", port.to_string())])
                } else {
                    err.to_string()
                };
                (self.deps.log)(
                    "error",
                    self.deps.tr("main.engine.obsStartFailed", vec![("host", host.clone()), ("port", port.to_string()), ("error", message.clone())]),
                );
                let mut inner = self.inner.lock().expect("obs inner lock");
                if inner.generation == generation {
                    inner.last_error = message;
                }
                return;
            }
        };
        // Read the ACTUAL bound port back: a configured port of 0 (the tests
        // use it to avoid the bind→drop→rebind race of a probe port) lets the
        // OS pick, and status() must report what is really listening.
        let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
        {
            let mut inner = self.inner.lock().expect("obs inner lock");
            inner.accept_task = None; // set below once spawned
            inner.running_key = key;
            inner.bound_host = host.clone();
            inner.bound_port = bound_port;
        }
        // Publish the listener synchronously: apply()'s de-duplication reads
        // this state, and two applies inside the listen window each started a
        // listener in the original.
        self.inner.lock().expect("obs inner lock").accept_task = None;

        let this = Arc::clone(self);
        let accept_handle = tokio::spawn(async move {
            let this = this;
            loop {
                match listener.accept().await {
                    Ok((stream, peer)) => {
                        let remote = format!("{}:{}", peer.ip(), peer.port());
                        tokio::spawn(this.clone().serve_connection(stream, remote));
                    }
                    Err(_) => {
                        // Listener dead: update state like the TS 'error' path.
                        let mut inner = this.inner.lock().expect("obs inner lock");
                        if inner.generation == generation {
                            inner.accept_task = None;
                            inner.running_key = String::new();
                        }
                        return;
                    }
                }
            }
        })
        .abort_handle();
        {
            let mut inner = self.inner.lock().expect("obs inner lock");
            // A newer apply()/stop() superseded this listener while it bound.
            if inner.generation == generation {
                inner.accept_task = Some(accept_handle);
            }
        }
        {
            let status = self.status();
            let auth = if (self.deps.settings)().password.is_empty() {
                self.deps.tr("main.engine.obsNoPassword", vec![])
            } else {
                self.deps.tr("main.engine.obsNeedsPassword", vec![])
            };
            (self.deps.log)(
                "info",
                self.deps.tr("main.engine.obsStarted", vec![("url", status.url), ("auth", auth)]),
            );
            let password = (self.deps.settings)().password;
            if password.is_empty() && !is_loopback(&host) {
                (self.deps.log)(
                    "warn",
                    self.deps.tr("main.engine.obsExposedNoPassword", vec![("host", host)]),
                );
            }
        }
    }

    async fn serve_connection(self: Arc<Self>, stream: TcpStream, remote: String) {
        let connection_generation = self.shared_generation.load(Ordering::SeqCst);
        let mut client = ClientState::new(self.next_client_id(), remote);
        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);

        // Handshake timeout: a socket that never completes the upgrade is dropped.
        let upgraded = tokio::time::timeout(
            std::time::Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            self.run_handshake(&mut client, &mut reader, &mut writer),
        )
        .await
        .unwrap_or(Ok(false));
        match upgraded {
            Ok(true) => {}
            _ => return,
        }
        // Undo the identified count when this connection ends. A stop() resets
        // the counter to zero first, so the decrement saturates at zero.
        let identified_counter = Arc::clone(&self.identified);
        let was_identified = client.identified;
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = done_rx.await;
            if was_identified {
                loop {
                    let current = identified_counter.load(Ordering::SeqCst);
                    if current == 0 {
                        break;
                    }
                    if identified_counter
                        .compare_exchange(current, current - 1, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        break;
                    }
                }
            }
        });
        // `done_tx` is sent when the frame loop exits (see below).
        // Frame loop. Each iteration re-checks the server generation, so a
        // stop() drops existing clients the way the TS dropClient loop did.
        let mut buf = [0u8; 65_536];
        let frame_loop = async {
            loop {
                if self.shared_generation.load(Ordering::SeqCst) != connection_generation {
                    return;
                }
                // Drain complete frames from the buffer first.
                loop {
                    match decode_frame(&client.buffer) {
                        DecodeOutcome::Incomplete => break,
                        DecodeOutcome::Violation => {
                            self.close_with(&mut writer, 1002, "protocol error").await;
                            return;
                        }
                        DecodeOutcome::Frame(consumed, fin, opcode, payload) => {
                            client.buffer.drain(..consumed);
                            match self.handle_frame(&mut client, &mut writer, fin, opcode, payload).await {
                                Flow::Continue => {}
                                Flow::Close => return,
                            }
                        }
                    }
                }
                match reader.read(&mut buf).await {
                    Ok(0) => return,
                    Ok(n) => {
                        client.buffer.extend_from_slice(&buf[..n]);
                        if !client.upgraded && client.buffer.len() > 16 * 1024 {
                            // Oversized HTTP head: the handshake timeout handles a
                            // socket that sends nothing, this one that sends garbage.
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        };
        let _ = frame_loop.await;
        let _ = done_tx.send(());
    }

    async fn run_handshake(
        self: &Arc<Self>,
        client: &mut ClientState,
        reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
    ) -> std::io::Result<bool> {
        // Read until \r\n\r\n.
        loop {
            if let Some(end) = find_double_crlf(&client.buffer) {
                let head = String::from_utf8_lossy(&client.buffer[..end]).into_owned();
                client.buffer.drain(..end + 4);
                let accepted = self.upgrade(client, writer, &head).await;
                return Ok(accepted);
            }
            let mut chunk = [0u8; 4096];
            let n = reader.read(&mut chunk).await?;
            if n == 0 {
                return Ok(false);
            }
            client.buffer.extend_from_slice(&chunk[..n]);
        }
    }

    /// Answers the HTTP upgrade. Returns false when the request was rejected.
    async fn upgrade(
        self: &Arc<Self>,
        client: &mut ClientState,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
        head: &str,
    ) -> bool {
        let mut lines = head.split("\r\n");
        let request_line = lines.next().unwrap_or("");
        let mut headers: HashMap<String, String> = HashMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let key = headers.get("sec-websocket-key").cloned();
        let upgrade = headers.get("upgrade").cloned().unwrap_or_default().to_ascii_lowercase();
        let version = headers.get("sec-websocket-version").cloned().unwrap_or_default();
        let connection = headers.get("connection").cloned().unwrap_or_default().to_ascii_lowercase();
        let origin = headers.get("origin").cloned();
        // Browsers do not apply the same-origin policy to WebSocket handshakes,
        // so any page the user visits can reach a loopback listener (see TS).
        if let Some(origin) = &origin {
            if !is_allowed_origin(origin) {
                let _ = writer.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n").await;
                let _ = writer.flush().await;
                (self.deps.log)(
                    "warn",
                    self.deps.tr("main.engine.obsOriginRejected", vec![("origin", origin.clone())]),
                );
                return false;
            }
        }
        let key_ok = key.as_deref().map(|k| !k.is_empty()).unwrap_or(false);
        if !request_line.to_ascii_uppercase().starts_with("GET")
            || upgrade != "websocket"
            || !key_ok
            || version != "13"
            || !connection.contains("upgrade")
        {
            let _ = writer.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n").await;
            let _ = writer.flush().await;
            return false;
        }
        // sha1(key + WS_GUID), base64.
        use sha1::{Digest as _, Sha1 as Sha1Hash};
        let mut hasher = Sha1Hash::new();
        hasher.update(format!("{}{WS_GUID}", key.expect("checked")));
        let accept = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
        // The subprotocol is echoed ONLY when the client requested it: RFC 6455
        // §4.2.2 forbids answering with one the client never asked for, and
        // strict clients (tungstenite among them) reject the response outright.
        let subprotocol_header = match headers.get("sec-websocket-protocol") {
            Some(requested)
                if requested
                    .to_ascii_lowercase()
                    .split(',')
                    .any(|p| p.trim() == SUBPROTOCOL) =>
            {
                format!("\r\nSec-WebSocket-Protocol: {SUBPROTOCOL}")
            }
            _ => String::new(),
        };
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}{subprotocol_header}\r\n\r\n"
        );
        if writer.write_all(response.as_bytes()).await.is_err() {
            return false;
        }
        let _ = writer.flush().await;
        client.upgraded = true;
        self.send(writer, &self.hello(client)).await;
        true
    }

    fn next_client_id(&self) -> u64 {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        NEXT.fetch_add(1, Ordering::SeqCst) as u64
    }

    fn hello(&self, client: &mut ClientState) -> serde_json::Value {
        let cfg = (self.deps.settings)();
        let mut data = serde_json::json!({
            "obsWebSocketVersion": OBS_WS_VERSION,
            "rpcVersion": OBS_WS_RPC_VERSION,
            "publisher": "RTMP File Streamer",
        });
        if !cfg.password.is_empty() {
            // The challenge is minted per connection and remembered until
            // Identify, because the answer can only be verified against it.
            let salt = random_base64_16();
            let challenge = random_base64_16();
            data["authentication"] = serde_json::json!({ "salt": salt, "challenge": challenge });
            client.auth_salt = Some(salt);
            client.auth_challenge = Some(challenge);
        }
        serde_json::json!({ "op": OP_HELLO, "d": data })
    }

    async fn handle_frame(
        self: &Arc<Self>,
        client: &mut ClientState,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
        fin: bool,
        opcode: u8,
        payload: Vec<u8>,
    ) -> Flow {
        if opcode == 0x8 {
            // Close.
            let _ = writer.write_all(&encode_frame(&payload[..payload.len().min(2)], 0x8)).await;
            let _ = writer.flush().await;
            return Flow::Close;
        }
        if opcode == 0x9 {
            // Ping -> pong.
            let _ = writer.write_all(&encode_frame(&payload, 0xa)).await;
            let _ = writer.flush().await;
            return Flow::Continue;
        }
        if opcode == 0xa {
            return Flow::Continue; // pong
        }

        if opcode == 0x1 || opcode == 0x2 {
            client.fragment_opcode = opcode;
            client.fragment = Some(payload);
        } else if opcode == 0x0 {
            match &mut client.fragment {
                Some(fragment) => {
                    // The per-frame limit does not bound a continuation chain;
                    // cap the assembled message, not just one frame.
                    if fragment.len() + payload_len(&payload) > MAX_FRAME_BYTES {
                        self.close_with(writer, 1009, "message too large").await;
                        return Flow::Close;
                    }
                    fragment.extend_from_slice(&payload);
                }
                None => {
                    self.close_with(writer, 1002, "unexpected opcode").await;
                    return Flow::Close;
                }
            }
        } else {
            self.close_with(writer, 1002, "unexpected opcode").await;
            return Flow::Close;
        }
        if !fin {
            return Flow::Continue;
        }

        let message = client.fragment.take();
        let message_opcode = client.fragment_opcode;
        if let (Some(message), 0x1) = (message, message_opcode) {
            let text = String::from_utf8_lossy(&message).into_owned();
            return self.on_message(client, writer, &text).await;
        }
        Flow::Continue
    }

    async fn close_with(&self, writer: &mut tokio::net::tcp::OwnedWriteHalf, code: u16, reason: &str) {
        let mut payload = Vec::with_capacity(2 + reason.len());
        payload.extend_from_slice(&code.to_be_bytes());
        payload.extend_from_slice(reason.as_bytes());
        let _ = writer.write_all(&encode_frame(&payload, 0x8)).await;
        let _ = writer.flush().await;
        // Give the close frame a moment to reach the client (the TS grace).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    async fn send(&self, writer: &mut tokio::net::tcp::OwnedWriteHalf, payload: &serde_json::Value) {
        let frame = encode_frame(payload.to_string().as_bytes(), 0x1);
        let _ = writer.write_all(&frame).await;
        let _ = writer.flush().await;
    }

    async fn on_message(
        self: &Arc<Self>,
        client: &mut ClientState,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
        text: &str,
    ) -> Flow {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            self.close_with(writer, 1007, "invalid payload").await;
            return Flow::Close;
        };
        let op = msg.get("op").and_then(serde_json::Value::as_u64).unwrap_or(u64::MAX) as u8;
        let empty = serde_json::Map::new();
        let data = msg.get("d").and_then(serde_json::Value::as_object).unwrap_or(&empty);
        match op {
            OP_IDENTIFY => self.on_identify(client, writer, data).await,
            OP_REIDENTIFY => {
                if client.identified {
                    client.session_id = format!("rtmp-file-streamer-{}", client.id);
                    self.send(writer, &serde_json::json!({ "op": OP_IDENTIFIED, "d": { "negotiatedRpcVersion": OBS_WS_RPC_VERSION } })).await;
                } else {
                    self.close_with(writer, 1008, "not identified").await;
                    return Flow::Close;
                }
            }
            OP_REQUEST => {
                self.on_request(client, writer, data).await;
            }
            other => {
                self.close_with(writer, 1002, &format!("unexpected op {other}")).await;
                return Flow::Close;
            }
        }
        Flow::Continue
    }

    async fn on_identify(
        self: &Arc<Self>,
        client: &mut ClientState,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
        data: &serde_json::Map<String, serde_json::Value>,
    ) {
        let cfg = (self.deps.settings)();
        let rpc_version = data.get("rpcVersion").and_then(serde_json::Value::as_f64).unwrap_or(f64::NAN);
        if rpc_version.is_finite() && rpc_version > OBS_WS_RPC_VERSION as f64 {
            self.close_with(writer, 4009, "unsupported rpc version").await;
            return;
        }
        if !cfg.password.is_empty() {
            let authentication = data.get("authentication").and_then(serde_json::Value::as_str).unwrap_or("");
            let expected = match (&client.auth_salt, &client.auth_challenge) {
                (Some(salt), Some(challenge)) => obs_auth_string(&cfg.password, salt, challenge),
                _ => String::new(),
            };
            // Without the challenge pair sent in the Hello there is nothing to
            // verify against, so the connection is refused rather than trusted.
            if authentication.is_empty() || expected.is_empty() || !timing_safe_equal(authentication, &expected) {
                (self.deps.log)(
                    "warn",
                    self.deps.tr("main.engine.obsAuthFailed", vec![("remote", client.remote.clone())]),
                );
                self.close_with(writer, 4009, "authentication failed").await;
                return;
            }
        }
        client.auth_salt = None;
        client.auth_challenge = None;
        client.identified = true;
        client.session_id = format!("rtmp-file-streamer-{}", client.id);
        self.identified.fetch_add(1, Ordering::SeqCst);
        // A stop() resets the counter to zero, so the exit-time decrement below
        // must saturate instead of underflowing.
        self.send(writer, &serde_json::json!({ "op": OP_IDENTIFIED, "d": { "negotiatedRpcVersion": OBS_WS_RPC_VERSION } })).await;
        (self.deps.log)(
            "info",
            self.deps.tr("main.engine.obsClientConnected", vec![("remote", client.remote.clone())]),
        );
    }

    async fn on_request(
        self: &Arc<Self>,
        client: &mut ClientState,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
        data: &serde_json::Map<String, serde_json::Value>,
    ) {
        let request_type = data.get("requestType").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let request_id = data.get("requestId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let empty = serde_json::Map::new();
        let request_data = data.get("requestData").and_then(serde_json::Value::as_object).unwrap_or(&empty);

        if !client.identified {
            self.respond(writer, &request_id, REQUEST_STATUS_NOT_IDENTIFIED, "Not identified", &serde_json::json!({})).await;
            return;
        }
        let outcome = self.dispatch(&request_type, request_data).await;
        match outcome {
            Ok((status, comment, response)) => {
                self.respond(writer, &request_id, status, &comment, &response).await;
            }
            Err(message) => {
                (self.deps.log)(
                    "warn",
                    self.deps.tr("main.engine.obsRequestFailed", vec![("type", request_type.clone()), ("message", message.clone())]),
                );
                self.respond(writer, &request_id, REQUEST_STATUS_INVALID_DATA, &message, &serde_json::json!({})).await;
            }
        }
    }

    async fn respond(
        &self,
        writer: &mut tokio::net::tcp::OwnedWriteHalf,
        request_id: &str,
        code: u32,
        comment: &str,
        response: &serde_json::Value,
    ) {
        self.send(
            writer,
            &serde_json::json!({
                "op": OP_REQUEST_RESPONSE,
                "d": {
                    "requestId": request_id,
                    "requestStatus": {
                        "result": code == REQUEST_STATUS_SUCCESS,
                        "code": code,
                        "comment": if comment.is_empty() { serde_json::Value::Null } else { serde_json::json!(comment) },
                    },
                    "responseData": response,
                }
            }),
        )
        .await;
    }

    /// Maps one request to the OBS response shape.
    async fn dispatch(
        self: &Arc<Self>,
        request_type: &str,
        request_data: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(u32, String, serde_json::Value), String> {
        match request_type {
            /* ---------------- read: handshake-time questions ---------------- */
            "GetVersion" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({
                    "obsVersion": self.obs_version(),
                    "obsWebSocketVersion": OBS_WS_VERSION,
                    "rpcVersion": OBS_WS_RPC_VERSION,
                    // A recognisable platform name keeps clients from rejecting
                    // a "non-OBS" endpoint during their handshake.
                    "platform": match std::env::consts::OS {
                        "windows" => "windows",
                        "macos" => "macos",
                        _ => "linux",
                    },
                    "platformDescription": "RTMP File Streamer",
                }),
            )),
            "GetStreamStatus" => Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!(self.stream_status()))),
            "GetStreamServiceSettings" => {
                let (server, stream_key) = (self.deps.stream_target)();
                Ok((
                    REQUEST_STATUS_SUCCESS,
                    String::new(),
                    serde_json::json!({
                        "streamServiceType": "rtmp_custom",
                        "streamServiceSettings": {
                            "server": server,
                            "streamKey": stream_key,
                            "service": "rtmp_custom",
                            "useAuth": false,
                            "username": "",
                            "password": "",
                        },
                    }),
                ))
            }
            "GetSceneList" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({ "currentProgramSceneName": null, "currentPreviewSceneName": null, "scenes": [] }),
            )),
            "GetCurrentProgramScene" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({ "currentProgramSceneName": null, "sceneName": null }),
            )),
            "GetSceneCollectionList" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({ "currentSceneCollectionName": "rtmp-file-streamer", "sceneCollections": ["rtmp-file-streamer"] }),
            )),
            "GetProfileList" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({ "currentProfileName": "default", "profiles": ["default"] }),
            )),
            "GetVideoSettings" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({ "fpsNumerator": 30, "fpsDenominator": 1, "baseWidth": 1920, "baseHeight": 1080, "outputWidth": 1920, "outputHeight": 1080 }),
            )),
            "GetRecordStatus" => Ok((
                REQUEST_STATUS_SUCCESS,
                String::new(),
                serde_json::json!({ "outputActive": false, "outputPaused": false, "outputTimecode": "00:00:00.000", "outputDuration": 0, "outputBytes": 0 }),
            )),
            "GetReplayBufferStatus" => Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!({ "outputActive": false }))),
            "GetVirtualCamStatus" => Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!({ "outputActive": false }))),
            "GetStudioModeEnabled" => Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!({ "studioModeEnabled": false }))),

            /* ---------------- write: the real feature ---------------- */
            "SetStreamServiceSettings" => {
                let settings = request_data.get("streamServiceSettings").cloned().unwrap_or(serde_json::Value::Null);
                let server = settings.get("server").and_then(serde_json::Value::as_str).map(|s| s.trim().to_string());
                let stream_key = settings.get("streamKey").and_then(serde_json::Value::as_str).map(str::to_string);
                if server.is_none() && stream_key.is_none() {
                    return Err(self.deps.tr("main.engine.obsMissingTarget", vec![]));
                }
                if server.as_deref() == Some("") {
                    return Err(self.deps.tr("main.dialog.emptyServer", vec![]));
                }
                (self.deps.apply_stream_target)(server.clone(), stream_key.clone())?;
                let mut message = self.deps.tr("main.engine.obsTargetUpdated", vec![]);
                if let Some(server) = &server {
                    message.push_str(&self.deps.tr("main.engine.obsServerSet", vec![("server", server.clone())]));
                }
                if stream_key.is_some() {
                    message.push_str(&self.deps.tr("main.engine.obsKeySet", vec![]));
                }
                (self.deps.log)("info", message);
                Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!({})))
            }
            "StartStream" => {
                if self.engine_busy() {
                    return Ok((REQUEST_STATUS_SUCCESS, self.deps.tr("main.engine.obsAlreadyStreaming", vec![]), serde_json::json!({})));
                }
                let rx = (self.deps.start_stream)();
                let _ = rx.await;
                (self.deps.log)("info", self.deps.tr("main.engine.obsStartRequested", vec![]));
                Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!({})))
            }
            "StopStream" => {
                let rx = (self.deps.stop_stream)();
                let _ = rx.await;
                (self.deps.log)("info", self.deps.tr("main.engine.obsStopRequested", vec![]));
                Ok((REQUEST_STATUS_SUCCESS, String::new(), serde_json::json!({})))
            }

            /* ---------------- everything else: generic success ---------------- */
            other => Ok((
                REQUEST_STATUS_SUCCESS,
                format!("request {other} is not implemented; reported as success"),
                serde_json::json!({}),
            )),
        }
    }

    fn obs_version(&self) -> String {
        // The TS version derived it from Electron's version; the Rust backend
        // reports its own crate version with the same major.minor.patch shape.
        let v = env!("CARGO_PKG_VERSION");
        let major = v.split('.').next().unwrap_or("0");
        format!("{major}.0.0")
    }

    fn engine_busy(&self) -> bool {
        let state = (self.deps.engine_state)();
        state != "idle" && state != "error"
    }

    fn stream_status(&self) -> serde_json::Value {
        let state = (self.deps.engine_state)();
        let active = state == "live" || state == "draining" || state == "reconnecting";
        serde_json::json!({
            "outputActive": active,
            "outputReconnecting": state == "reconnecting",
            "outputTimecode": "00:00:00.000",
            "outputDuration": 0,
            "outputCongestion": 0,
            "outputBytes": 0,
            "outputSkippedFrames": 0,
            "outputTotalFrames": 0,
        })
    }
}

enum Flow {
    Continue,
    Close,
}

fn payload_len(payload: &[u8]) -> usize {
    payload.len()
}

/// Index of the `\r\n\r\n` terminator in an HTTP head.
fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Constant-time comparison for the two base64 authentication strings.
fn timing_safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}
