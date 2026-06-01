use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_PENDING_DURATION: Duration = Duration::from_millis(700);
const MAX_CONTEXT_SENTENCES: usize = 3;
const MIN_FORCE_CHARS: usize = 40;
const MIN_FORCE_WORDS: usize = 8;
const MIN_FORCE_GROWTH_CHARS: usize = 24;
const MAX_SUBTITLE_CHARS: usize = 120;
const MAX_SUBTITLE_WORDS: usize = 22;
const MIN_SPLIT_HEAD_CHARS: usize = 36;

pub struct SentenceSplitter {
    buffer: String,
    committed: String,
    pending_start: Option<Instant>,
    context: VecDeque<String>,
    split_endings: Vec<char>,
    active_forced_pending: Option<ForcedPending>,
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

fn unix_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as u64,
        Err(_) => 0,
    }
}

impl SentenceSplitter {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
            committed: String::new(),
            pending_start: None,
            context: VecDeque::new(),
            split_endings: vec!['.', '!', '?', ';', '。', '！', '？', '；', '\n'],
            active_forced_pending: None,
        }
    }

    #[allow(dead_code)]
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
                self.pending_start = Some(Instant::now());
            }
            if let Some(start) = self.pending_start {
                let pending_text = self.buffer[self.committed.len()..].trim().to_string();
                if !pending_text.is_empty()
                    && (start.elapsed() >= MAX_PENDING_DURATION
                        || is_readable_pending_fragment(&pending_text))
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
        self.pending_start = Some(Instant::now() - duration);
    }
}

fn is_readable_pending_fragment(text: &str) -> bool {
    text.chars().count() >= MIN_FORCE_CHARS || text.split_whitespace().count() >= MIN_FORCE_WORDS
}

fn needs_subtitle_split(text: &str) -> bool {
    text.chars().count() > MAX_SUBTITLE_CHARS
        || text.split_whitespace().count() > MAX_SUBTITLE_WORDS
}

fn split_subtitle_chunks(sentence: &str) -> Vec<String> {
    let trimmed = sentence.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if !needs_subtitle_split(trimmed) {
        return vec![trimmed.to_string()];
    }

    let mut remaining = trimmed;
    let mut chunks = Vec::new();
    while needs_subtitle_split(remaining) {
        let Some(split_at) = find_subtitle_split_at(remaining) else {
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

fn find_subtitle_split_at(text: &str) -> Option<usize> {
    let candidates = split_candidates(text);
    let target = byte_after_char_count(text, MAX_SUBTITLE_CHARS)?;
    let min = byte_after_char_count(text, MIN_SPLIT_HEAD_CHARS).unwrap_or(0);

    candidates
        .iter()
        .copied()
        .filter(|idx| *idx >= min && *idx <= target)
        .max()
        .or_else(|| candidates.iter().copied().filter(|idx| *idx >= min).min())
        .or_else(|| Some(target))
}

fn split_candidates(text: &str) -> Vec<usize> {
    let mut candidates = Vec::new();
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
            candidates.push(idx + ch.len_utf8());
        }
    }

    for connector in connectors {
        let mut search_from = 0;
        while let Some(found) = text[search_from..].find(connector) {
            let idx = search_from + found + connector.len();
            candidates.push(idx);
            search_from = idx;
        }
    }

    for (idx, ch) in text.char_indices() {
        if ch.is_whitespace() {
            candidates.push(idx + ch.len_utf8());
        }
    }

    candidates.sort_unstable();
    candidates.dedup();
    candidates
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
    #[allow(dead_code)]
    pub committed_preview: String,
    #[allow(dead_code)]
    pub buffer_preview: String,
    pub pending_ms: Option<u64>,
    #[allow(dead_code)]
    pub context_sentences: usize,
    #[allow(dead_code)]
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
        let results = splitter
            .feed("This is a long enough fragment that should translate before punctuation");

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

        assert_eq!(splitter.feed(text).len(), 1);
        assert!(splitter.feed(text).is_empty());
    }

    #[test]
    fn test_aged_short_fragment_forces_once() {
        let mut splitter = SentenceSplitter::new();

        assert!(splitter.feed("short fragment").is_empty());
        splitter.age_pending_for_test(Duration::from_millis(800));
        let forced = splitter.feed("short fragment plus");

        assert_eq!(forced.len(), 1);
        assert!(forced[0].is_forced);
        assert!(splitter.feed("short fragment plus").is_empty());
    }

    #[test]
    fn test_complete_sentence_replaces_forced_fragment() {
        let mut splitter = SentenceSplitter::new();
        let forced = splitter
            .feed("This is a long enough fragment that should translate before punctuation");
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
        let first = splitter
            .feed("This is a long enough fragment that should translate before punctuation");
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
        let forced = splitter
            .feed("This is a long enough fragment that should translate before punctuation");
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
    fn test_long_paragraph_does_not_repeat_committed_chunks() {
        let mut splitter = SentenceSplitter::new();
        let text = "First long enough sentence that should stay readable in the overlay and still only be emitted once. Second sentence follows cleanly.";

        let first = splitter.feed(text);
        let second = splitter.feed(text);

        assert!(!first.is_empty());
        assert!(second.is_empty());
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
