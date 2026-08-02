use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde_json::Value;

const DEFAULT_PROCESSING_MODE: &str = "inject-important";

#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub(crate) enum GlossaryProcessingMode {
    InjectAll,
    #[default]
    InjectImportant,
    PostCalibrate,
}

impl GlossaryProcessingMode {
    fn from_value(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str).unwrap_or(DEFAULT_PROCESSING_MODE) {
            "inject-all" => Self::InjectAll,
            "post-calibrate" => Self::PostCalibrate,
            _ => Self::InjectImportant,
        }
    }
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct GlossaryEntry {
    source_lang: String,
    target_lang: String,
    source_term: String,
    target_term: String,
    strategy: String,
    important: bool,
    case_sensitive: bool,
    whole_word: bool,
    aliases: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct GlossaryCatalog {
    processing_mode: GlossaryProcessingMode,
    entries: Vec<GlossaryEntry>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct GlossaryContext {
    processing_mode: GlossaryProcessingMode,
    entries: Vec<GlossaryEntry>,
    prompt: Option<String>,
    signature: u64,
}

impl GlossaryCatalog {
    pub(crate) fn from_config(config: &Value) -> Self {
        let mut libraries = config
            .pointer("/glossary/libraries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        libraries.sort_by_key(|library| {
            library
                .get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX)
        });

        let entries = libraries
            .iter()
            .filter(|library| library.get("enabled").and_then(Value::as_bool).unwrap_or(false))
            .flat_map(|library| {
                library
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(parse_entry)
            })
            .collect();
        let processing_mode = GlossaryProcessingMode::from_value(
            config.pointer("/glossary/processingMode"),
        );

        Self {
            processing_mode,
            entries,
        }
    }

    pub(crate) fn for_languages(
        &self,
        source_language: &str,
        target_language: &str,
    ) -> GlossaryContext {
        let entries = self
            .entries
            .iter()
            .filter(|entry| {
                language_matches(&entry.source_lang, source_language)
                    && language_matches(&entry.target_lang, target_language)
            })
            .cloned()
            .collect::<Vec<_>>();
        GlossaryContext::new(self.processing_mode, entries)
    }

    #[cfg(test)]
    fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

impl GlossaryContext {
    fn new(processing_mode: GlossaryProcessingMode, entries: Vec<GlossaryEntry>) -> Self {
        let prompt = build_prompt(processing_mode, &entries);
        let mut hasher = DefaultHasher::new();
        processing_mode.hash(&mut hasher);
        entries.hash(&mut hasher);
        Self {
            processing_mode,
            entries,
            prompt,
            signature: hasher.finish(),
        }
    }

    #[cfg(test)]
    fn processing_mode(&self) -> GlossaryProcessingMode {
        self.processing_mode
    }

    pub(crate) fn prompt(&self) -> Option<&str> {
        self.prompt.as_deref()
    }

    pub(crate) fn signature(&self) -> u64 {
        self.signature
    }

    #[cfg(test)]
    fn has_entries(&self) -> bool {
        !self.entries.is_empty()
    }

    /// Adds the glossary instructions to a realtime session's system prompt.
    /// Post-calibration deliberately does not add a prompt: its contract is to
    /// apply deterministic replacements after the provider returns text.
    pub(crate) fn with_instructions(&self, instructions: &str) -> String {
        match self.prompt() {
            Some(prompt) if !instructions.trim().is_empty() => {
                format!("{instructions}\n\n{prompt}")
            }
            Some(prompt) => prompt.to_string(),
            None => instructions.to_string(),
        }
    }

    /// Applies the deterministic part of the glossary contract to completed
    /// output. Force entries are also checked after prompt injection so a
    /// provider cannot silently ignore a mandatory term. In post-calibrate
    /// mode, suggested entries are checked too; keep entries are never
    /// replaced.
    pub(crate) fn calibrate(&self, source_text: &str, translated_text: &str) -> String {
        if translated_text.trim().is_empty() {
            return translated_text.to_string();
        }

        let should_calibrate_suggestions = self.processing_mode == GlossaryProcessingMode::PostCalibrate;
        let mut calibrated = translated_text.to_string();
        for entry in &self.entries {
            if (self.processing_mode == GlossaryProcessingMode::InjectImportant && !entry.important)
                || entry.strategy == "keep"
                || (entry.strategy != "force" && !should_calibrate_suggestions)
            {
                continue;
            }

            let mut needles = std::iter::once(entry.source_term.as_str())
                .chain(entry.aliases.iter().map(String::as_str))
                .filter(|term| !term.trim().is_empty())
                .collect::<Vec<_>>();
            needles.sort_by_key(|term| std::cmp::Reverse(term.chars().count()));
            for needle in needles {
                if contains_match(source_text, needle, entry.case_sensitive, entry.whole_word) {
                    calibrated = replace_matches(
                        &calibrated,
                        needle,
                        &entry.target_term,
                        entry.case_sensitive,
                        entry.whole_word,
                    );
                }
            }
        }
        calibrated
    }
}

fn parse_entry(value: &Value) -> Option<GlossaryEntry> {
    let source_term = value
        .get("sourceTerm")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|term| !term.is_empty())?
        .to_string();
    let target_term = value
        .get("targetTerm")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|term| !term.is_empty())?
        .to_string();
    let aliases = value
        .get("aliases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect();

    Some(GlossaryEntry {
        source_lang: value
            .get("sourceLang")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim()
            .to_string(),
        target_lang: value
            .get("targetLang")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim()
            .to_string(),
        source_term,
        target_term,
        strategy: value
            .get("strategy")
            .and_then(Value::as_str)
            .unwrap_or("suggest")
            .trim()
            .to_string(),
        important: value
            .get("important")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        case_sensitive: value
            .get("caseSensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        whole_word: value
            .get("wholeWord")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        aliases,
    })
}

fn language_matches(configured: &str, requested: &str) -> bool {
    let configured = configured.trim().to_ascii_lowercase();
    let requested = requested.trim().to_ascii_lowercase();
    if configured.is_empty() || configured == "auto" || requested.is_empty() || requested == "auto" {
        return true;
    }
    configured == requested
        || configured
            .split(['-', '_'])
            .next()
            .is_some_and(|base| requested.split(['-', '_']).next() == Some(base))
}

fn build_prompt(
    processing_mode: GlossaryProcessingMode,
    entries: &[GlossaryEntry],
) -> Option<String> {
    let selected = entries.iter().filter(|entry| match processing_mode {
        GlossaryProcessingMode::InjectAll => true,
        GlossaryProcessingMode::InjectImportant => entry.important,
        GlossaryProcessingMode::PostCalibrate => false,
    });
    let selected = selected.collect::<Vec<_>>();
    if selected.is_empty() {
        return None;
    }

    let mut prompt = String::from(
        "Glossary rules (apply these to the source text; never mention the glossary and output only the translation):",
    );
    for entry in selected {
        let strategy = match entry.strategy.as_str() {
            "force" => "FORCE",
            "keep" => "KEEP",
            _ => "SUGGEST",
        };
        let matching = if entry.whole_word {
            "whole-word matching"
        } else {
            "phrase matching"
        };
        let case = if entry.case_sensitive {
            "case-sensitive"
        } else {
            "case-insensitive"
        };
        let aliases = if entry.aliases.is_empty() {
            String::new()
        } else {
            format!("; aliases: {}", entry.aliases.iter().map(|a| quote(a)).collect::<Vec<_>>().join(", "))
        };
        prompt.push_str(&format!(
            "\n- [{strategy}] {} -> {} ({}, {}{}; {} -> {})",
            quote(&entry.source_term),
            quote(&entry.target_term),
            matching,
            case,
            aliases,
            entry.source_lang,
            entry.target_lang,
        ));
    }
    Some(prompt)
}

fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('"', "\\\"")
    )
}

fn is_word_char(value: Option<char>) -> bool {
    value.is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
}

fn match_len_at(text: &str, start: usize, needle: &str, case_sensitive: bool) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let mut cursor = start;
    for expected in needle.chars() {
        let actual = text.get(cursor..)?.chars().next()?;
        if case_sensitive && actual != expected
            || !case_sensitive && !actual.eq_ignore_ascii_case(&expected)
        {
            return None;
        }
        cursor += actual.len_utf8();
    }
    Some(cursor - start)
}

fn is_match_at(text: &str, start: usize, needle: &str, case_sensitive: bool, whole_word: bool) -> Option<usize> {
    let length = match_len_at(text, start, needle, case_sensitive)?;
    if whole_word {
        let end = start + length;
        if is_word_char(text[..start].chars().next_back())
            || is_word_char(text[end..].chars().next())
        {
            return None;
        }
    }
    Some(length)
}

fn contains_match(text: &str, needle: &str, case_sensitive: bool, whole_word: bool) -> bool {
    if needle.is_empty() {
        return false;
    }
    text.char_indices()
        .any(|(start, _)| is_match_at(text, start, needle, case_sensitive, whole_word).is_some())
}

fn replace_matches(
    text: &str,
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        if let Some(length) = is_match_at(text, cursor, needle, case_sensitive, whole_word) {
            output.push_str(replacement);
            cursor += length;
        } else {
            let ch = text[cursor..]
                .chars()
                .next()
                .expect("cursor must remain on a character boundary");
            output.push(ch);
            cursor += ch.len_utf8();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(mode: &str) -> Value {
        json!({
            "glossary": {
                "processingMode": mode,
                "libraries": [
                    {
                        "id": "disabled",
                        "enabled": false,
                        "priority": 0,
                        "entries": [{
                            "sourceLang": "en-US", "targetLang": "zh-CN",
                            "sourceTerm": "ignored", "targetTerm": "忽略",
                            "strategy": "force", "important": true
                        }]
                    },
                    {
                        "id": "main",
                        "enabled": true,
                        "priority": 1,
                        "entries": [
                            {
                                "sourceLang": "en-US", "targetLang": "zh-CN",
                                "sourceTerm": "GG", "targetTerm": "好局",
                                "strategy": "force", "important": true,
                                "caseSensitive": false, "wholeWord": true
                            },
                            {
                                "sourceLang": "en-US", "targetLang": "zh-CN",
                                "sourceTerm": "NPC", "targetTerm": "角色",
                                "strategy": "suggest", "important": false
                            },
                            {
                                "sourceLang": "en-US", "targetLang": "zh-CN",
                                "sourceTerm": "OVA", "targetTerm": "OVA",
                                "strategy": "keep", "important": true
                            }
                        ]
                    }
                ]
            }
        })
    }

    #[test]
    fn parses_enabled_entries_and_filters_language_pair() {
        let catalog = GlossaryCatalog::from_config(&config("inject-important"));
        assert_eq!(catalog.entry_count(), 3);
        let context = catalog.for_languages("en-US", "zh-CN");
        assert_eq!(context.processing_mode(), GlossaryProcessingMode::InjectImportant);
        assert!(context.prompt().expect("important prompt should exist").contains("GG"));
        assert!(!context.prompt().unwrap().contains("NPC"));
        assert!(!catalog.for_languages("en-US", "ja-JP").has_entries());
    }

    #[test]
    fn post_calibration_replaces_force_and_suggest_but_not_keep() {
        let catalog = GlossaryCatalog::from_config(&config("post-calibrate"));
        let context = catalog.for_languages("en-US", "zh-CN");
        assert!(context.prompt().is_none());
        assert_eq!(
            context.calibrate("GG and NPC, but not OVA", "gg 与 NPC，还有 OVA"),
            "好局 与 角色，还有 OVA"
        );
    }

    #[test]
    fn whole_word_and_alias_matching_are_respected() {
        let value = json!({
            "glossary": {
                "processingMode": "inject-all",
                "libraries": [{
                    "enabled": true,
                    "entries": [{
                        "sourceLang": "auto", "targetLang": "zh-CN",
                        "sourceTerm": "LFG", "targetTerm": "找队友",
                        "aliases": ["looking for group"], "strategy": "force",
                        "caseSensitive": true, "wholeWord": true
                    }]
                }]
            }
        });
        let context = GlossaryCatalog::from_config(&value).for_languages("en-US", "zh-CN");
        assert_eq!(
            context.calibrate("LFG and looking for group", "LFG looking for group"),
            "找队友 找队友"
        );
        assert_eq!(context.calibrate("LFGs", "LFGs"), "LFGs");
    }
}
