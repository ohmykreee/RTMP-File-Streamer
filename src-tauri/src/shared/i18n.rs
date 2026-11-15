//! Internationalization core for the backend. Port of `src/shared/i18n/core.ts`.
//!
//! The translated text itself lives in `resources/i18n/{en,zh,ja}.json`, dumped
//! from `src/shared/i18n/messages.ts` at build time — TypeScript remains the
//! source of truth so the renderer and this code cannot disagree.

use std::collections::HashMap;
use std::sync::LazyLock;

pub const LANGUAGES: [&str; 3] = ["zh", "ja", "en"];
pub const FALLBACK_LANGUAGE: &str = "en";

pub(crate) static EN: LazyLock<HashMap<String, String>> = LazyLock::new(|| load("en"));
pub(crate) static ZH: LazyLock<HashMap<String, String>> = LazyLock::new(|| load("zh"));
pub(crate) static JA: LazyLock<HashMap<String, String>> = LazyLock::new(|| load("ja"));

fn load(lang: &str) -> HashMap<String, String> {
    let raw = match lang {
        "zh" => include_str!("../../resources/i18n/zh.json"),
        "ja" => include_str!("../../resources/i18n/ja.json"),
        _ => include_str!("../../resources/i18n/en.json"),
    };
    serde_json::from_str(raw).unwrap_or_else(|e| panic!("generated {lang}.json must parse: {e}"))
}

pub fn catalog(language: &str) -> &'static HashMap<String, String> {
    match language {
        "zh" => &ZH,
        "ja" => &JA,
        _ => &EN,
    }
}

/// Narrowing test for persisted / incoming values: anything else is rejected
/// rather than coerced, so a bad value falls back to detection.
pub fn is_language(value: &str) -> bool {
    LANGUAGES.contains(&value)
}

/// True for every Chinese variant a locale tag can carry.
fn is_chinese_tag(tag: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    let stem = |prefixes: &[&str]| {
        prefixes
            .iter()
            .any(|p| lower == *p || lower.starts_with(&format!("{p}-")) || lower.starts_with(&format!("{p}_")))
    };
    stem(&["zh", "chi", "zho", "chs", "cht", "hans", "hant", "cmn", "yue"])
}

/// Picks the UI language for a system locale tag: Chinese (any variant) → zh,
/// Japanese → ja, everything else → en.
pub fn detect_language(system_locale: Option<&str>) -> &'static str {
    let tag = system_locale.unwrap_or("").trim();
    if tag.is_empty() {
        return FALLBACK_LANGUAGE;
    }
    if is_chinese_tag(tag) {
        return "zh";
    }
    let lower = tag.to_ascii_lowercase();
    if lower == "ja" || lower.starts_with("ja-") || lower.starts_with("ja_") {
        return "ja";
    }
    FALLBACK_LANGUAGE
}

/// The language to run with: the saved one when it is valid, otherwise whatever
/// the system asks for.
pub fn resolve_language(stored: &str, system_locale: Option<&str>) -> &'static str {
    if is_language(stored) {
        // Return the stored value as a 'static leak-free mapping: the stored value
        // is one of the three known languages by is_language.
        match stored {
            "zh" => "zh",
            "ja" => "ja",
            _ => "en",
        }
    } else {
        detect_language(system_locale)
    }
}

/// Fills `{name}` holes. Unknown placeholders are left untouched for diagnosis.
pub fn interpolate(template: &str, params: &[(&str, String)]) -> String {
    if params.is_empty() {
        return template.to_string();
    }
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            // Find the closing brace and check the name is a \w+ run.
            if let Some(end) = template[i + 1..].find('}') {
                let name = &template[i + 1..i + 1 + end];
                if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    if let Some((_, value)) = params.iter().find(|(k, _)| *k == name) {
                        out.push_str(value);
                        i += 1 + end + 1;
                        continue;
                    }
                }
            }
        }
        // Advance one full UTF-8 character.
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&template[i..i + ch_len]);
        i += ch_len;
    }
    out
}

fn utf8_len(first_byte: u8) -> usize {
    match first_byte {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

/// Looks up one message. Fallback chain: the requested table → the key itself.
pub fn t(language: &str, key: &str) -> String {
    catalog(language).get(key).cloned().unwrap_or_else(|| key.to_string())
}

/// `t` with placeholder parameters.
pub fn t_params(language: &str, key: &str, params: &[(&str, String)]) -> String {
    let template = catalog(language).get(key).cloned().unwrap_or_else(|| key.to_string());
    interpolate(&template, params)
}

/// Reports keys a translation is missing, or defines without the reference
/// having them (startup-time report + test assertion).
pub fn catalog_problems() -> Vec<String> {
    let mut problems = Vec::new();
    let reference_keys: Vec<&String> = EN.keys().collect();
    for (lang, cat) in [("zh", &ZH), ("ja", &JA)] {
        for key in &reference_keys {
            if !cat.contains_key(*key) {
                problems.push(format!("{lang}: missing key \"{key}\""));
            }
        }
        for key in cat.keys() {
            if !EN.contains_key(key) {
                problems.push(format!("{lang}: unknown key \"{key}\" (not in the reference table)"));
            }
        }
    }
    problems.sort();
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_catalogs_are_complete_and_consistent() {
        assert_eq!(EN.len(), 589);
        assert_eq!(ZH.len(), 589);
        assert_eq!(JA.len(), 589);
        assert_eq!(catalog_problems(), Vec::<String>::new());
    }

    #[test]
    fn language_detection_rules() {
        assert_eq!(detect_language(Some("zh-CN")), "zh");
        assert_eq!(detect_language(Some("zh_TW")), "zh");
        assert_eq!(detect_language(Some("zho")), "zh");
        assert_eq!(detect_language(Some("ja-JP")), "ja");
        assert_eq!(detect_language(Some("en-US")), "en");
        assert_eq!(detect_language(Some("")), "en");
        assert_eq!(detect_language(None), "en");
        assert!(is_language("zh"));
        assert!(!is_language("zh-CN"));
    }

    #[test]
    fn interpolation_leaves_unknown_placeholders() {
        assert_eq!(interpolate("已添加 {n} 个文件", &[("n", "3".to_string())]), "已添加 3 个文件");
        assert_eq!(interpolate("no params {x}", &[]), "no params {x}");
        assert_eq!(interpolate("missing {gone}", &[("n", "1".to_string())]), "missing {gone}");
    }
}
