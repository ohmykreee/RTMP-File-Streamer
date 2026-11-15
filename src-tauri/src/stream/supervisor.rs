//! Owns one spawned child process: kills it on request, reports its exit.
//! Shared by the playout (pusher/encoder) and the engine's single-process path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::{mpsc, watch};

pub struct Supervisor {
    kill_tx: mpsc::UnboundedSender<()>,
    exited: Arc<AtomicBool>,
    exited_rx: watch::Receiver<bool>,
}

pub fn spawn_supervised(child: Child, on_exit: impl FnOnce(Option<i32>) + Send + 'static) -> Supervisor {
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel();
    let (exited_tx, exited_rx) = watch::channel(false);
    let exited = Arc::new(AtomicBool::new(false));
    let exited2 = exited.clone();
    tokio::spawn(async move {
        let mut child = child;
        let status = loop {
            tokio::select! {
                s = child.wait() => break s,
                _ = kill_rx.recv() => {
                    let _ = child.start_kill();
                }
            }
        };
        let code = status.ok().and_then(|s| s.code());
        exited2.store(true, Ordering::SeqCst);
        let _ = exited_tx.send(true);
        on_exit(code);
    });
    Supervisor { kill_tx, exited, exited_rx }
}

impl Supervisor {
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub fn kill(&self) {
        let _ = self.kill_tx.send(());
    }

    /// Resolves when the process is gone, or `None` after `timeout_ms`.
    pub async fn wait_exited(&self, timeout_ms: u64) -> Option<()> {
        let mut rx = self.exited_rx.clone();
        tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
            while !*rx.borrow_and_update() {
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
        .await
        .ok()
    }
}
