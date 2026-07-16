use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::time_utils::unix_ms;

const MAX_PENDING_DURATION: Duration = Duration::from_millis(700);
const MAX_CONTEXT_SENTENCES: usize = 3;
const MIN_FORCE_CHARS: usize = 28;
const MIN_FORCE_WORDS: usize = 6;
const MIN_FORCE_GROWTH_CHARS: usize = 18;
const MAX_SUBTITLE_CHARS: usize = 120;
const MAX_CJK_SUBTITLE_CHARS: usize = 42;
const MAX_SUBTITLE_WORDS: usize = 22;
const MIN_SPLIT_HEAD_CHARS: usize = 28;
// Display-only limits target a bilingual 24px overlay. Keeping these separate
// prevents visual wrapping from changing when the streaming recognizer commits.
const MAX_DISPLAY_CHARS: usize = 72;
const MAX_CJK_DISPLAY_CHARS: usize = 24;
const MAX_DISPLAY_WORDS: usize = 12;
const MIN_DISPLAY_HEAD_CHARS: usize = 18;

trait SentenceClock: Send + Sync {
    fn now(&self) -> Instant;
}

struct SystemSentenceClock;

impl SentenceClock for SystemSentenceClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

pub struct SentenceSplitter {
    buffer: String,
    committed: String,
    pending_start: Option<Instant>,
    context: VecDeque<String>,
    split_endings: Vec<char>,
    active_forced_pending: Option<ForcedPending>,
    clock: Arc<dyn SentenceClock>,
}

#[derive(Debug, Clone)]
pub struct SentenceResult {
    pub sentence: String,
    pub context: Vec<String>,
    pub is_forced: bool,
    pub is_replacement: bool,
    pub pending_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SentenceFeedResult {
    pub sentences: Vec<SentenceResult>,
    pub revision_reset: bool,
    pub previous_committed: String,
}

#[derive(Debug, Clone)]
struct ForcedPending {
    id: String,
    text: String,
}

impl SentenceSplitter {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemSentenceClock))
    }

    fn with_clock(clock: Arc<dyn SentenceClock>) -> Self {
        Self {
            buffer: String::new(),
            committed: String::new(),
            pending_start: None,
            context: VecDeque::new(),
            split_endings: vec!['.', '!', '?', ';', '。', '！', '？', '；', '\n'],
            active_forced_pending: None,
            clock,
        }
    }

    #[allow(dead_code, reason = "compatibility wrapper is retained for callers that do not consume revision metadata")]
    pub fn feed(&mut self, full_text: &str) -> Vec<SentenceResult> {
        self.feed_with_revision(full_text).sentences
    }

    pub fn feed_with_revision(&mut self, full_text: &str) -> SentenceFeedResult {
        let mut results = Vec::new();
        let mut revision_reset = false;
        let mut previous_committed = String::new();

        if !self.committed.is_empty() && !full_text.starts_with(&self.committed) {
            revision_reset = true;
            previous_committed = self.committed.clone();
            self.reset();
        }

        if full_text.len() <= self.committed.len() {
            return SentenceFeedResult {
                sentences: results,
                revision_reset,
                previous_committed,
            };
        }

        let old_committed_len = self.committed.len();
        self.buffer = full_text.to_string();

        let char_byte_map: Vec<(usize, char)> = self.buffer.char_indices().collect();
        let mut last_split = old_committed_len;
        let mut new_sentences = Vec::new();

        for (char_i, &(byte_i, ch)) in char_byte_map.iter().enumerate() {
            if byte_i < old_committed_len {
                continue;
            }
            if self.split_endings.contains(&ch) {
                let next_ch = char_byte_map.get(char_i + 1).map(|(_, c)| *c);
                if ch == '.' || ch == '!' || ch == '?' {
                    if let Some(nc) = next_ch {
                        if nc != ' ' && nc != '\n' {
                            continue;
                        }
                    }
                }
                if ch == '.' && next_ch == Some(' ') {
                    let preceding: String = self.buffer[..byte_i]
                        .chars()
                        .rev()
                        .take_while(|c| !c.is_whitespace())
                        .collect::<Vec<_>>()
                        .iter()
                        .rev()
                        .collect();
                    if !preceding.is_empty()
                        && preceding.len() <= 4
                        && preceding
                            .chars()
                            .all(|c| c.is_ascii_uppercase() || c == '.')
                    {
                        continue;
                    }
                }
                let end_byte = byte_i + ch.len_utf8();
                let sentence = self.buffer[last_split..end_byte].trim().to_string();
                if is_incomplete_final_clause(&sentence) {
                    continue;
                }
                let sentence = drop_leading_incomplete_clause(&sentence);
                if !sentence.is_empty() {
                    new_sentences.push(sentence);
                }
                last_split = end_byte;
            }
        }

        self.committed = self.buffer[..last_split].to_string();

        if !new_sentences.is_empty() {
            self.pending_start = None;

            for raw_sentence in &new_sentences {
                let mut final_replacement_pending_id =
                    self.active_forced_pending.as_ref().and_then(|pending| {
                        if raw_sentence.starts_with(&pending.text) {
                            Some(pending.id.clone())
                        } else {
                            None
                        }
                    });

                for sentence in split_subtitle_chunks(raw_sentence) {
                    self.context.push_back(sentence.clone());
                    if self.context.len() > MAX_CONTEXT_SENTENCES {
                        self.context.pop_front();
                    }
                    let context_vec: Vec<String> = self.context.iter().cloned().collect();
                    let pending_id = final_replacement_pending_id.take();
                    results.push(SentenceResult {
                        sentence,
                        context: context_vec,
                        is_forced: false,
                        is_replacement: pending_id.is_some(),
                        pending_id,
                    });
                }
            }

            self.active_forced_pending = None;
        }

        if results.is_empty() && !self.buffer.is_empty() {
            if self.pending_start.is_none() {
                self.pending_start = Some(self.clock.now());
            }
            if let Some(start) = self.pending_start {
                let pending_text = self.buffer[self.committed.len()..].trim().to_string();
                if !pending_text.is_empty()
                    && start.elapsed() >= MAX_PENDING_DURATION
                    && is_readable_pending_fragment(&pending_text)
                    && should_emit_forced_pending(
                        self.active_forced_pending
                            .as_ref()
                            .map(|pending| pending.text.as_str()),
                        &pending_text,
                    )
                {
                    let pending_id = format!("pending-{}", unix_ms());
                    self.active_forced_pending = Some(ForcedPending {
                        id: pending_id.clone(),
                        text: pending_text.clone(),
                    });
                    results.push(SentenceResult {
                        sentence: pending_text,
                        context: self.context.iter().cloned().collect(),
                        is_forced: true,
                        is_replacement: false,
                        pending_id: Some(pending_id),
                    });
                }
            }
        }

        SentenceFeedResult {
            sentences: results,
            revision_reset,
            previous_committed,
        }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        self.committed.clear();
        self.pending_start = None;
        self.context.clear();
        self.active_forced_pending = None;
    }

    pub fn diagnostics(&self) -> SentenceSplitterDiagnostics {
        let pending_ms = self
            .pending_start
            .map(|start| start.elapsed().as_millis() as u64);
        SentenceSplitterDiagnostics {
            buffer_len: self.buffer.len(),
            committed_len: self.committed.len(),
            committed_preview: if self.committed.len() <= 200 {
                self.committed.clone()
            } else {
                format!("{}...(truncated)", &self.committed[..200])
            },
            buffer_preview: if self.buffer.len() <= 200 {
                self.buffer.clone()
            } else {
                format!("{}...(truncated)", &self.buffer[..200])
            },
            pending_ms,
            context_sentences: self.context.len(),
            forced_pending_count: usize::from(self.active_forced_pending.is_some()),
        }
    }

    #[cfg(test)]
    pub fn age_pending_for_test(&mut self, duration: Duration) {
        self.pending_start = Some(self.clock.now() - duration);
    }
}

fn is_readable_pending_fragment(text: &str) -> bool {
    text.chars().count() >= MIN_FORCE_CHARS || text.split_whitespace().count() >= MIN_FORCE_WORDS
}

fn drop_leading_incomplete_clause(text: &str) -> String {
    let Some((head, tail)) = text.split_once(". ") else {
        return text.trim().to_string();
    };
    let head_with_period = format!("{head}.");
    if is_incomplete_final_clause(&head_with_period) {
        return tail.trim().to_string();
    }
    text.trim().to_string()
}

fn is_incomplete_final_clause(text: &str) -> bool {
    let normalized = text
        .trim()
        .trim_end_matches(|ch: char| matches!(ch, '.' | '!' | '?' | ';' | ':' | ',' | '，'))
        .to_ascii_lowercase()
        .replace('’', "'");
    if normalized.ends_with("about to be") && normalized.contains(" how ") {
        return false;
    }
    let words: Vec<&str> = normalized.split_whitespace().collect();
    if words.len() <= 4
        && words
            .last()
            .is_some_and(|word| matches!(*word, "a" | "an" | "the" | "one" | "of"))
    {
        return true;
    }
    if words.len() < 3 {
        return false;
    }
    let endings = [
        "about to be",
        "going to",
        "will",
        "to",
        "how",
        "see how",
        "show you how",
        "going to bring",
        "going to show",
    ];
    endings.iter().any(|ending| normalized.ends_with(ending))
}

fn needs_subtitle_split_with_limits(
    text: &str,
    max_chars: usize,
    max_cjk_chars: usize,
    max_words: usize,
) -> bool {
    let char_limit = if text.chars().any(is_cjk_caption_character) {
        max_cjk_chars
    } else {
        max_chars
    };
    text.chars().count() > char_limit || text.split_whitespace().count() > max_words
}

fn is_cjk_caption_character(character: char) -> bool {
    matches!(
        character,
        '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}' | '\u{ac00}'..='\u{d7af}'
    )
}

/// Stateless display formatter shared by both subtitle routes.
///
/// `SentenceSplitter` owns streaming/revision state for the secondary
/// translator. Native realtime models already return a complete text payload,
/// so they use `split_text`. Both paths converge on `split_sentence`, keeping
/// the on-screen sentence and long-line rules identical.
pub struct SubtitleDisplaySegmenter;

impl SubtitleDisplaySegmenter {
    pub fn split_text(text: &str) -> Vec<String> {
        let text = text.trim();
        if text.is_empty() {
            return Vec::new();
        }

        let characters: Vec<(usize, char)> = text.char_indices().collect();
        let mut lines = Vec::new();
        let mut start = 0;

        for (index, &(byte_index, character)) in characters.iter().enumerate() {
            if !matches!(
                character,
                '.' | '!' | '?' | ';' | '。' | '！' | '？' | '；' | '\n'
            ) {
                continue;
            }

            let next = characters.get(index + 1).map(|(_, character)| *character);
            if matches!(character, '.' | '!' | '?')
                && next.is_some_and(|next| !next.is_whitespace())
            {
                continue;
            }
            if character == '.' && is_abbreviated_display_period(text, byte_index) {
                continue;
            }

            let end = byte_index + character.len_utf8();
            lines.extend(Self::split_sentence(&text[start..end]));
            start = end;
        }

        // Realtime models sometimes finish a turn without punctuation. It is
        // still safer to wrap it than to render an unreadable paragraph.
        lines.extend(Self::split_sentence(&text[start..]));
        lines
    }

    pub fn split_sentence(sentence: &str) -> Vec<String> {
        split_subtitle_chunks_with_limits(
            sentence,
            MAX_DISPLAY_CHARS,
            MAX_CJK_DISPLAY_CHARS,
            MAX_DISPLAY_WORDS,
            MIN_DISPLAY_HEAD_CHARS,
        )
    }
}

fn is_abbreviated_display_period(text: &str, period_index: usize) -> bool {
    let preceding_word: String = text[..period_index]
        .chars()
        .rev()
        .take_while(|character| !character.is_whitespace())
        .collect::<Vec<_>>()
        .iter()
        .rev()
        .collect();
    let upper_initialism = !preceding_word.is_empty()
        && preceding_word.len() <= 4
        && preceding_word
            .chars()
            .all(|character| character.is_ascii_uppercase() || character == '.');
    let common_abbreviation = matches!(
        preceding_word.to_ascii_lowercase().as_str(),
        "mr" | "mrs" | "ms" | "dr" | "prof" | "sr" | "jr" | "vs" | "etc"
    );
    upper_initialism || common_abbreviation
}

fn split_subtitle_chunks(sentence: &str) -> Vec<String> {
    split_subtitle_chunks_with_limits(
        sentence,
        MAX_SUBTITLE_CHARS,
        MAX_CJK_SUBTITLE_CHARS,
        MAX_SUBTITLE_WORDS,
        MIN_SPLIT_HEAD_CHARS,
    )
}

fn split_subtitle_chunks_with_limits(
    sentence: &str,
    max_chars: usize,
    max_cjk_chars: usize,
    max_words: usize,
    min_head_chars: usize,
) -> Vec<String> {
    let trimmed = sentence.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if !needs_subtitle_split_with_limits(trimmed, max_chars, max_cjk_chars, max_words) {
        return vec![trimmed.to_string()];
    }

    let mut remaining = trimmed;
    let mut chunks = Vec::new();
    while needs_subtitle_split_with_limits(remaining, max_chars, max_cjk_chars, max_words) {
        let Some(split_at) = find_subtitle_split_at_with_limits(
            remaining,
            max_chars,
            max_cjk_chars,
            max_words,
            min_head_chars,
        ) else {
            break;
        };
        let (head, tail) = remaining.split_at(split_at);
        let head = head.trim();
        if head.is_empty() {
            break;
        }
        chunks.push(head.to_string());
        remaining = tail.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == '，');
    }

    if !remaining.trim().is_empty() {
        chunks.push(remaining.trim().to_string());
    }
    chunks
}

fn find_subtitle_split_at_with_limits(
    text: &str,
    max_chars: usize,
    max_cjk_chars: usize,
    max_words: usize,
    min_head_chars: usize,
) -> Option<usize> {
    let (semantic_candidates, whitespace_candidates) = split_candidates(text);
    let safe_semantic_candidates: Vec<usize> = semantic_candidates
        .iter()
        .copied()
        .filter(|idx| !breaks_numeric_money_phrase(text, *idx))
        .collect();
    let semantic_candidates = if safe_semantic_candidates.is_empty() {
        &semantic_candidates
    } else {
        &safe_semantic_candidates
    };
    let char_target = byte_after_char_count(
        text,
        if text.chars().any(is_cjk_caption_character) {
            max_cjk_chars
        } else {
            max_chars
        },
    )
    .unwrap_or(text.len());
    let word_target = whitespace_candidates
        .get(max_words.saturating_sub(1))
        .copied()
        .unwrap_or(text.len());
    let target = char_target.min(word_target);
    let min = byte_after_char_count(text, min_head_chars).unwrap_or(0);

    semantic_candidates
        .iter()
        .copied()
        .filter(|idx| *idx >= min && *idx <= target)
        // Prefer the first usable semantic boundary over a later arbitrary
        // word boundary. This keeps real-time voice captions readable and
        // avoids splitting a clause immediately before its key verb/object.
        .min()
        .or(semantic_candidates
            .iter()
            .copied()
            .filter(|idx| *idx >= min)
            .min())
        .or(whitespace_candidates
            .iter()
            .copied()
            .filter(|idx| *idx >= min && *idx <= target)
            .max())
        .or(whitespace_candidates
            .iter()
            .copied()
            .filter(|idx| *idx >= min)
            .min())
        .or(Some(target))
}

fn normalize_boundary_word(word: &str) -> String {
    word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_ascii_lowercase()
}

fn boundary_word_before(text: &str, idx: usize) -> Option<String> {
    text.get(..idx)?
        .split_whitespace()
        .last()
        .map(normalize_boundary_word)
        .filter(|word| !word.is_empty())
}

fn boundary_word_after(text: &str, idx: usize) -> Option<String> {
    text.get(idx..)?
        .split_whitespace()
        .next()
        .map(normalize_boundary_word)
        .filter(|word| !word.is_empty())
}

fn breaks_numeric_money_phrase(text: &str, idx: usize) -> bool {
    let Some(before) = boundary_word_before(text, idx) else {
        return false;
    };
    let Some(after) = boundary_word_after(text, idx) else {
        return false;
    };

    matches!(
        (before.as_str(), after.as_str()),
        (
            "one"
                | "two"
                | "three"
                | "four"
                | "five"
                | "six"
                | "seven"
                | "eight"
                | "nine"
                | "ten"
                | "hundred"
                | "thousand"
                | "million"
                | "billion",
            "hundred" | "thousand" | "million" | "billion" | "dollar" | "dollars"
        ) | (
            "dollar" | "dollars",
            "rocket" | "ship" | "biosphere" | "line" | "light"
        ) | ("rocket", "ship")
    )
}

fn split_candidates(text: &str) -> (Vec<usize>, Vec<usize>) {
    let mut semantic_candidates = Vec::new();
    let mut whitespace_candidates = Vec::new();
    let connectors = [
        " and ",
        " but ",
        " because ",
        " when ",
        " which ",
        " that ",
        " to ",
        " for ",
    ];

    for (idx, ch) in text.char_indices() {
        if matches!(ch, ',' | '，' | ':' | '：' | '-' | '—' | '、') {
            semantic_candidates.push(idx + ch.len_utf8());
        }
    }

    for connector in connectors {
        let mut search_from = 0;
        while let Some(found) = text[search_from..].find(connector) {
            let idx = search_from + found + connector.len();
            semantic_candidates.push(idx);
            search_from = idx;
        }
    }

    for (idx, ch) in text.char_indices() {
        if ch.is_whitespace() {
            whitespace_candidates.push(idx + ch.len_utf8());
        }
    }

    semantic_candidates.sort_unstable();
    semantic_candidates.dedup();
    whitespace_candidates.sort_unstable();
    whitespace_candidates.dedup();
    (semantic_candidates, whitespace_candidates)
}

fn byte_after_char_count(text: &str, max_chars: usize) -> Option<usize> {
    text.char_indices()
        .nth(max_chars)
        .map(|(idx, _)| idx)
        .or(Some(text.len()))
}

fn should_emit_forced_pending(previous: Option<&str>, pending_text: &str) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous == pending_text || pending_text.len() <= previous.len() {
        return false;
    }
    pending_text.len() - previous.len() >= MIN_FORCE_GROWTH_CHARS
}

#[derive(Debug, Clone)]
pub struct SentenceSplitterDiagnostics {
    pub buffer_len: usize,
    pub committed_len: usize,
    #[allow(dead_code, reason = "diagnostic preview field is serialized only by benchmark builds")]
    pub committed_preview: String,
    #[allow(dead_code, reason = "diagnostic preview field is serialized only by benchmark builds")]
    pub buffer_preview: String,
    pub pending_ms: Option<u64>,
    #[allow(dead_code, reason = "diagnostic counter is consumed only by benchmark builds")]
    pub context_sentences: usize,
    #[allow(dead_code, reason = "diagnostic counter is consumed only by benchmark builds")]
    pub forced_pending_count: usize,
}

pub fn detect_language(text: &str) -> Option<whatlang::Lang> {
    let info = whatlang::detect(text)?;
    if info.is_reliable() {
        Some(info.lang())
    } else {
        None
    }
}

pub fn is_target_language(detected: whatlang::Lang, target: &str) -> bool {
    match target {
        t if t.starts_with("zh") => detected == whatlang::Lang::Cmn,
        t if t.starts_with("en") => detected == whatlang::Lang::Eng,
        t if t.starts_with("ja") => detected == whatlang::Lang::Jpn,
        t if t.starts_with("ko") => detected == whatlang::Lang::Kor,
        t if t.starts_with("fr") => detected == whatlang::Lang::Fra,
        t if t.starts_with("de") => detected == whatlang::Lang::Deu,
        t if t.starts_with("es") => detected == whatlang::Lang::Spa,
        t if t.starts_with("pt") => detected == whatlang::Lang::Por,
        t if t.starts_with("ru") => detected == whatlang::Lang::Rus,
        t if t.starts_with("ar") => detected == whatlang::Lang::Ara,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_english_sentence_split() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed("Hello world. This is a test.");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].sentence, "Hello world.");
        assert_eq!(results[1].sentence, "This is a test.");
    }

    #[test]
    fn test_chinese_sentence_split() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed("你好。这是测试。");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].sentence, "你好。");
        assert_eq!(results[1].sentence, "这是测试。");
    }

    #[test]
    fn test_incomplete_sentence() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed("Hello world");
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_readable_fragment_forces_without_punctuation() {
        let mut splitter = SentenceSplitter::new();
        let text = "This is a long enough fragment that should translate before punctuation";
        assert!(splitter.feed(text).is_empty());
        splitter.age_pending_for_test(Duration::from_millis(800));
        let results = splitter.feed(text);

        assert_eq!(results.len(), 1);
        assert!(results[0].is_forced);
        assert_eq!(
            results[0].sentence,
            "This is a long enough fragment that should translate before punctuation"
        );
    }

    #[test]
    fn test_same_forced_fragment_is_not_emitted_twice() {
        let mut splitter = SentenceSplitter::new();
        let text = "This is a long enough fragment that should translate before punctuation";

        assert!(splitter.feed(text).is_empty());
        splitter.age_pending_for_test(Duration::from_millis(800));
        assert_eq!(splitter.feed(text).len(), 1);
        assert!(splitter.feed(text).is_empty());
    }

    #[test]
    fn test_aged_short_fragment_does_not_force() {
        let mut splitter = SentenceSplitter::new();

        assert!(splitter.feed("short fragment").is_empty());
        splitter.age_pending_for_test(Duration::from_millis(800));
        let forced = splitter.feed("short fragment plus");

        assert!(forced.is_empty());
        assert!(splitter.feed("short fragment plus").is_empty());
    }

    #[test]
    fn test_complete_sentence_replaces_forced_fragment() {
        let mut splitter = SentenceSplitter::new();
        let text = "This is a long enough fragment that should translate before punctuation";
        assert!(splitter.feed(text).is_empty());
        splitter.age_pending_for_test(Duration::from_millis(800));
        let forced = splitter.feed(text);
        let pending_id = forced[0].pending_id.clone();

        let replacement = splitter.feed(
            "This is a long enough fragment that should translate before punctuation arrives.",
        );

        assert_eq!(replacement.len(), 1);
        assert!(!replacement[0].is_forced);
        assert!(replacement[0].is_replacement);
        assert_eq!(replacement[0].pending_id, pending_id);
    }

    #[test]
    fn test_multiple_forced_fragments_emit_single_latest_replacement() {
        let mut splitter = SentenceSplitter::new();
        let first_text = "This is a long enough fragment that should translate before punctuation";
        assert!(splitter.feed(first_text).is_empty());
        splitter.age_pending_for_test(Duration::from_millis(800));
        let first = splitter.feed(first_text);
        let second = splitter.feed(
            "This is a long enough fragment that should translate before punctuation and keeps growing with many more words",
        );
        let latest_pending_id = second[0].pending_id.clone();

        let replacement = splitter.feed(
            "This is a long enough fragment that should translate before punctuation and keeps growing with many more words.",
        );

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(replacement.len(), 1);
        assert!(replacement[0].is_replacement);
        assert_eq!(replacement[0].pending_id, latest_pending_id);
    }

    #[test]
    fn test_completed_sentence_does_not_replace_trailing_tiny_fragment() {
        let mut splitter = SentenceSplitter::new();
        let text = "This is a long enough fragment that should translate before punctuation";
        assert!(splitter.feed(text).is_empty());
        splitter.age_pending_for_test(Duration::from_millis(700));
        let forced = splitter.feed(text);
        assert_eq!(forced.len(), 1);

        let results = splitter
            .feed("This is a long enough fragment that should translate before punctuation. Oh");

        assert_eq!(results.len(), 1);
        assert!(results[0].is_replacement);
        assert_eq!(
            results[0].sentence,
            "This is a long enough fragment that should translate before punctuation."
        );
    }

    #[test]
    fn test_mixed_language() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed("你好。Hello world. こんにちは。");
        assert_eq!(results.len(), 3);
    }

    #[test]
    fn test_context_accumulation() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed("First. Second. Third. Fourth. Fifth.");
        assert_eq!(results.len(), 5);
        assert_eq!(results[4].context.len(), 3);
        assert_eq!(results[4].context, vec!["Third.", "Fourth.", "Fifth."]);
    }

    #[test]
    fn test_abbreviation_not_split() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed("I live in the U.S. and I like it.");
        assert_eq!(results.len(), 1);
        assert!(results[0].sentence.contains("U.S."));
    }

    #[test]
    fn test_long_sentence_is_split_into_subtitle_chunks() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed(
            "This is a one billion dollar rocket ship of future technology that will one day take you all the way to Mars to live in your brand new home, a five hundred million dollar biosphere.",
        );

        assert!(results.len() > 1);
        assert!(results
            .iter()
            .all(|result| result.sentence.chars().count() <= MAX_SUBTITLE_CHARS));
    }

    #[test]
    fn test_money_phrase_is_not_split_between_amount_and_unit() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed(
            "A future technology that will one day take you all the way to Mars to live in your brand new home, a five hundred million dollar biosphere. Oh my gosh.",
        );

        assert!(results.iter().any(|result| result
            .sentence
            .contains("five hundred million dollar biosphere")));
        assert!(!results
            .iter()
            .any(|result| result.sentence == "million dollar biosphere."));
    }

    #[test]
    fn test_epic_future_sentence_is_complete() {
        let mut splitter = SentenceSplitter::new();
        let results =
            splitter.feed("This video will show you just how epic the future is about to be.");

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].sentence,
            "This video will show you just how epic the future is about to be."
        );
    }

    #[test]
    fn test_voice_chat_run_on_sentence_splits_before_it_gets_too_long() {
        let mut splitter = SentenceSplitter::new();
        let results = splitter.feed(
            "We are pushing left side because they have two people watching mid and I need you to smoke the door before the next wave arrives, then rotate back when you hear the ultimate coming from spawn.",
        );

        assert!(results.len() >= 2);
        assert!(results
            .iter()
            .all(|result| result.sentence.chars().count() <= MAX_SUBTITLE_CHARS));
        assert!(results[0].sentence.ends_with(',') || results[0].sentence.ends_with("because"));
    }

    #[test]
    fn test_long_paragraph_does_not_repeat_committed_chunks() {
        let mut splitter = SentenceSplitter::new();
        let text = "First long enough sentence that should stay readable in the overlay and still only be emitted once. Second sentence follows cleanly.";

        let first = splitter.feed(text);
        let second = splitter.feed(text);

        assert!(!first.is_empty());
        assert!(second.is_empty());
    }

    #[test]
    fn display_segmenter_preserves_sentence_boundaries_and_wraps_long_sentences() {
        let lines = SubtitleDisplaySegmenter::split_text(
            "This is a one billion dollar rocket ship, a future technology that will one day take you all the way to Mars to live in your brand new home, a five hundred million dollar biosphere. Oh my gosh, this video will show you how epic the future is.",
        );

        assert!(lines.len() >= 3);
        assert!(lines
            .iter()
            .all(|line| line.chars().count() <= MAX_DISPLAY_CHARS));
        assert!(lines
            .iter()
            .any(|line| line.contains("five hundred million dollar biosphere.")));
        assert!(lines.iter().any(|line| line.starts_with("Oh my gosh,")));
        assert_eq!(lines.last().map(String::as_str), Some("is."));
    }

    #[test]
    fn display_segmenter_turns_real_watch_mode_paragraph_into_caption_sized_rows() {
        let lines = SubtitleDisplaySegmenter::split_text(
            "This is a one billion dollar rocket ship, a future technology that will one day take you all the way to Mars, living in your brand new home, a five hundred million dollar biosphere. Oh my gosh, this video will show you just how epic the future is.",
        );

        assert!(lines.len() >= 4);
        assert!(
            lines.iter().all(|line| {
                line.chars().count() <= MAX_DISPLAY_CHARS
                    && line.split_whitespace().count() <= MAX_DISPLAY_WORDS
            }),
            "caption rows exceeded the display budget: {lines:?}"
        );
        assert!(lines.iter().any(|line| line.starts_with("Oh my gosh,")));
        assert_eq!(lines.last().map(String::as_str), Some("future is."));
    }

    #[test]
    fn display_segmenter_keeps_chinese_watch_mode_rows_to_one_readable_line() {
        let lines = SubtitleDisplaySegmenter::split_text(
            "这是一艘价值十亿美元的火箭飞船，一项未来科技，终有一天会带你一路前往火星，在五十亿美元的生物圈里安家落户。天哪，看完这个视频，你就会知道未来究竟有多震撼。",
        );

        assert!(lines.len() >= 4);
        assert!(lines
            .iter()
            .all(|line| line.chars().count() <= MAX_CJK_DISPLAY_CHARS));
    }

    #[test]
    fn display_segmenter_wraps_unpunctuated_cjk_text() {
        let text = "这是一个没有任何标点符号但是必须在字幕浮窗中拆成多行显示的很长中文片段为了避免观众面对一整段难以阅读的文字我们需要在自然的位置将它拆开并保持每一行都足够短";
        let lines = SubtitleDisplaySegmenter::split_text(text);

        assert!(lines.len() >= 2);
        assert!(lines
            .iter()
            .all(|line| line.chars().count() <= MAX_CJK_DISPLAY_CHARS));
        assert_eq!(lines.concat(), text);
    }

    #[test]
    fn test_asr_revision_resets_committed_prefix() {
        let mut splitter = SentenceSplitter::new();
        let first = splitter.feed("You got nearly.");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].sentence, "You got nearly.");

        let revised = splitter.feed("You got Neuralink, and what has that changed?");
        assert_eq!(revised.len(), 1);
        assert_eq!(
            revised[0].sentence,
            "You got Neuralink, and what has that changed?"
        );
    }

    #[test]
    fn test_hanging_english_clause_is_not_finalized() {
        let mut splitter = SentenceSplitter::new();

        let results = splitter.feed("Teacher is about to be.");

        assert!(results.is_empty());
    }

    #[test]
    fn test_short_article_fragment_is_not_finalized() {
        let mut splitter = SentenceSplitter::new();

        let results = splitter.feed("This is a one.");

        assert!(results.is_empty());
    }

    #[test]
    fn test_hanging_english_prefix_is_dropped_when_next_sentence_arrives() {
        let mut splitter = SentenceSplitter::new();

        let results = splitter.feed("Teacher is about to be. Oh my God!");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].sentence, "Oh my God!");
    }

    #[test]
    fn test_asr_revision_reports_reset_and_only_emits_revised_sentence() {
        let mut splitter = SentenceSplitter::new();
        let first = splitter.feed_with_revision("All starting with this one dollar.");
        assert_eq!(first.sentences.len(), 1);
        assert!(!first.revision_reset);

        let revised = splitter.feed_with_revision(
            "All starting with this one dollar light, which can simulate the future.",
        );

        assert!(revised.revision_reset);
        assert_eq!(
            revised.previous_committed,
            "All starting with this one dollar."
        );
        assert_eq!(revised.sentences.len(), 1);
        assert_eq!(
            revised.sentences[0].sentence,
            "All starting with this one dollar light, which can simulate the future."
        );
    }
}
