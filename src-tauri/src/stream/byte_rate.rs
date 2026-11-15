//! Bytes per second off a cumulative counter, over a short trailing window.
//! Port of `src/main/stream/byte-rate.ts`.

/// Samples older than this are dropped from the window.
const WINDOW_MS: f64 = 2000.0;
/// Shortest window a figure may be derived from.
const MIN_SPAN_MS: f64 = 1000.0;
/// Shortest life a meter may have before it reports anything.
const MIN_ELAPSED_MS: f64 = 1200.0;

#[derive(Default)]
pub struct ByteRateMeter {
    bytes: Vec<f64>,
    stamps: Vec<f64>,
    last: f64,
    started_at: f64,
}

impl ByteRateMeter {
    pub fn new() -> Self {
        Self { bytes: vec![], stamps: vec![], last: -1.0, started_at: 0.0 }
    }

    /// Records the counter's current value. A value at or below the previous one
    /// is ignored (a replaced process restarts its counter; carrying the old
    /// baseline forward kept the readout blank until it exceeded the previous
    /// file's total, so a lower value resets instead).
    pub fn add(&mut self, total_bytes: f64, now_ms: f64) {
        if !total_bytes.is_finite() || total_bytes <= 0.0 {
            return;
        }
        if self.last < 0.0 {
            self.started_at = now_ms;
        } else if total_bytes < self.last {
            self.reset();
            self.started_at = now_ms;
        } else if total_bytes == self.last {
            return;
        }
        self.last = total_bytes;
        self.bytes.push(total_bytes);
        self.stamps.push(now_ms);
        // Two samples are the minimum a rate can be computed from, so trimming
        // keeps them whatever the window says.
        while self.stamps.len() > 2 && now_ms - self.stamps[0] > WINDOW_MS {
            self.stamps.remove(0);
            self.bytes.remove(0);
        }
    }

    /// Current throughput in kbit/s, or 0 while there is not enough history.
    pub fn kbps(&self, now_ms: f64) -> f64 {
        if self.stamps.len() < 2 {
            return 0.0;
        }
        if now_ms - self.started_at < MIN_ELAPSED_MS {
            return 0.0;
        }
        let oldest = self.stamps[0];
        let newest = *self.stamps.last().expect("non-empty");
        // No sample inside the window means the counter stopped moving; "no
        // figure" is the honest answer rather than a stale rate.
        if now_ms - newest > WINDOW_MS {
            return 0.0;
        }
        let span_ms = newest - oldest;
        if span_ms < MIN_SPAN_MS {
            return 0.0;
        }
        let bytes = *self.bytes.last().expect("non-empty") - self.bytes[0];
        if bytes <= 0.0 {
            return 0.0;
        }
        // bytes/second -> kbit/s is ×8/1000.
        (bytes / (span_ms / 1000.0)) * 0.008
    }

    /// Forgets everything. Used when a new session opens.
    pub fn reset(&mut self) {
        self.bytes.clear();
        self.stamps.clear();
        self.last = -1.0;
        self.started_at = 0.0;
    }
}

/// `Date.now()` in milliseconds.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_over_window() {
        let mut m = ByteRateMeter::new();
        m.add(0.0, 0.0); // ignored: <= 0
        m.add(1000.0, 100.0);
        assert_eq!(m.kbps(200.0), 0.0); // one sample only
        m.add(3000.0, 1100.0); // 2000 bytes over 1000ms
        assert_eq!(m.kbps(100.0 + MIN_ELAPSED_MS - 1.0), 0.0); // before MIN_ELAPSED
        assert!((m.kbps(1400.0) - 16.0).abs() < 0.01, "{}", m.kbps(1400.0)); // 2000 B/s * 0.008
    }

    #[test]
    fn counter_restart_resets() {
        let mut m = ByteRateMeter::new();
        m.add(5_000_000.0, 1000.0);
        m.add(5_100_000.0, 1500.0);
        m.add(500.0, 2000.0); // new process counting from zero
        assert_eq!(m.kbps(2100.0), 0.0); // single sample after reset
        m.add(2500.0, 3000.0);
        assert_eq!(m.kbps(3000.0 + MIN_ELAPSED_MS - 1.0 - 2000.0), 0.0); // before MIN_ELAPSED
        assert!(m.kbps(3500.0) > 0.0);
    }
}
