//! The stream key never reaches the screen or the log. Port of
//! `src/main/log-redact.ts`: every display form is built from the parts, never
//! parsed out of the composed string, and `redact_text` is plain literal
//! replacement of the known secret values.

use crate::shared::protocol::build_push_target;
use crate::shared::types::OutputSettings;

const MASK: &str = "*****";

#[derive(Debug, Clone, Default)]
pub struct RedactionSecrets {
    /// The composed push target (address + key) and its display form.
    pub targets: Vec<(String, String)>,
    /// The raw key, for diagnostics that print it outside the target.
    pub keys: Vec<String>,
}

/// The display form of a push target: the address with the key replaced whole
/// by `*****`. Rebuilding with `*****` needs no parsing of the composed string.
pub fn mask_target(address: &str, stream_key: &str, protocol: Option<&str>) -> String {
    let key = if stream_key.trim().is_empty() { "" } else { MASK };
    build_push_target(address, key, protocol)
}

/// Collects the values that must never appear in a log line or result message.
pub fn collect_secrets(output: Option<&OutputSettings>) -> RedactionSecrets {
    let Some(output) = output else {
        return RedactionSecrets::default();
    };
    let server = &output.server;
    let key = output.stream_key.trim().to_string();
    let target = build_push_target(server, &key, Some(&output.protocol));
    RedactionSecrets {
        targets: if !target.is_empty() && !key.is_empty() {
            vec![(target, mask_target(server, &key, Some(&output.protocol)))]
        } else {
            vec![]
        },
        // A very short key would match ordinary words and mangle the log; inside
        // the target it is still hidden, because the whole target is replaced.
        keys: if key.len() >= 4 { vec![key] } else { vec![] },
    }
}

/// Replaces every occurrence of the configured credentials with `*****`.
pub fn redact_text(text: &str, secrets: &RedactionSecrets) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    for (raw, masked) in &secrets.targets {
        if !raw.is_empty() {
            out = out.replace(raw, masked);
        }
    }
    for key in &secrets.keys {
        if !key.is_empty() {
            out = out.replace(key, MASK);
        }
    }
    out
}
