//! Native equivalent of watch-mode-report.mjs AEC expected-segment oracle.
//! Fixed references, accepted rendered cues, ordered/clause LCS and original dual floors.
use crate::audio::contracts::WatchSessionReportRuntime;

pub(super) const SOURCE_REFERENCE: &str = include_str!("../../../../../scripts/testing/fixtures/watch-mode-en-original.txt");
const TRANSLATED_REFERENCE: &str = include_str!("../../../../../scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt");
pub(super) const MEDIA_SHA256: &str = "cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f";

pub(super) fn reference_segments(text: &str) -> Vec<String> {
    text.replace("\r\n", "\n").split("\n\n").map(str::trim).filter(|part| !part.is_empty()).map(str::to_string).collect()
}

fn compatible_chars(text: &str) -> impl Iterator<Item = char> + '_ {
    // The bound reference is ASCII + BMP Chinese. Preserve NFKC equivalence for
    // full-width provider letters/digits without changing punctuation clauses.
    text.chars().map(|ch| match ch as u32 {
        0xff01..=0xff5e => char::from_u32(ch as u32 - 0xfee0).unwrap(),
        0x3000 => ' ', _ => ch,
    }).flat_map(char::to_lowercase)
}

fn meaning(text: &str) -> Vec<char> { compatible_chars(text).filter(|ch| ch.is_alphanumeric()).collect() }

fn integer_tokens(value: u64) -> Vec<String> {
    const UNITS: [&str; 20] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
    const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
    if value < 20 { return vec![UNITS[value as usize].to_string()]; }
    if value < 100 {
        let mut words = vec![TENS[(value / 10) as usize].to_string()];
        if value % 10 != 0 { words.extend(integer_tokens(value % 10)); }
        return words;
    }
    for (scale, label) in [(1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand"), (100, "hundred")] {
        if value >= scale {
            let mut words = integer_tokens(value / scale);
            words.push(label.to_string());
            if value % scale != 0 { words.extend(integer_tokens(value % scale)); }
            return words;
        }
    }
    vec![value.to_string()]
}

fn english_tokens(text: &str) -> Vec<String> {
    let chars = compatible_chars(text).collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_lowercase() {
            let start = i; while i < chars.len() && chars[i].is_ascii_lowercase() { i += 1; }
            tokens.push(chars[start..i].iter().collect());
        } else if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == ',') { i += 1; }
            let raw = chars[start..i].iter().filter(|ch| **ch != ',').collect::<String>();
            tokens.extend(raw.parse::<u64>().map(integer_tokens).unwrap_or_else(|_| vec![raw]));
            if i + 1 < chars.len() && chars[i] == '.' && chars[i + 1].is_ascii_digit() {
                i += 1; tokens.push("point".to_string());
                while i < chars.len() && chars[i].is_ascii_digit() {
                    tokens.extend(integer_tokens(chars[i].to_digit(10).unwrap() as u64)); i += 1;
                }
            }
        } else { i += 1; }
    }
    tokens
}

fn ordered_recall<T: Eq>(reference: &[T], candidate: &[T]) -> f64 {
    if reference.is_empty() { return 0.0; }
    let mut previous = vec![0usize; candidate.len() + 1];
    for token in reference {
        let mut current = vec![0usize; candidate.len() + 1];
        for index in 1..=candidate.len() {
            current[index] = if token == &candidate[index - 1] { previous[index - 1] + 1 }
                else { previous[index].max(current[index - 1]) };
        }
        previous = current;
    }
    previous[candidate.len()] as f64 / reference.len() as f64
}

fn clause_token_recall(reference: &str, candidate: &[String]) -> f64 {
    let mut total = 0; let mut matched = 0.0;
    for clause in reference.split(['.', '?', '!', '\n']).map(str::trim).filter(|clause| clause.len() > 5) {
        let tokens = english_tokens(clause); total += tokens.len();
        matched += tokens.len() as f64 * ordered_recall(&tokens, candidate);
    }
    if total == 0 { 0.0 } else { matched / total as f64 }
}

fn clause_character_recall(reference: &str, candidate: &[char]) -> f64 {
    let mut total = 0; let mut matched = 0.0;
    for clause in reference.split(['，', '。', '！', '？', '：', '“', '”', '；', '\n']).map(str::trim).filter(|clause| clause.chars().count() >= 3) {
        let weight = clause.chars().count(); total += weight;
        matched += weight as f64 * ordered_recall(&meaning(clause), candidate);
    }
    if total == 0 { 0.0 } else { matched / total as f64 }
}

pub(super) fn covered_segments(expected: &[String], source: &str, translated: &str) -> usize {
    let translations = reference_segments(TRANSLATED_REFERENCE);
    let source_tokens = english_tokens(source);
    let translated_chars = meaning(translated);
    let combined = meaning(&format!("{source}\n{translated}"));
    let recalls = expected.iter().enumerate().map(|(index, reference)| {
        let source_recall = ordered_recall(&english_tokens(reference), &source_tokens).max(clause_token_recall(reference, &source_tokens));
        let translated_recall = translations.get(index).map(|reference| {
            ordered_recall(&meaning(reference), &translated_chars)
                .max(clause_character_recall(reference, &translated_chars))
                .max(clause_character_recall(reference, &combined))
        }).unwrap_or(0.0);
        (source_recall.max(translated_recall) * 10_000.0).round() / 10_000.0
    }).collect::<Vec<_>>();
    let mean = if recalls.is_empty() { 0.0 } else { recalls.iter().sum::<f64>() / recalls.len() as f64 };
    let dual_floor = !recalls.is_empty() && ((recalls.iter().all(|recall| *recall >= 0.45) && mean >= 0.60)
        || (recalls.iter().all(|recall| *recall >= 0.40) && mean >= 0.65));
    recalls.iter().filter(|recall| **recall >= 0.65 || dual_floor).count()
}

pub(super) fn accepted_report_text(report: &WatchSessionReportRuntime) -> (String, String) {
    let accepted = report.cues.iter().filter(|cue| {
        matches!(cue.comparison_status.as_str(), "exact" | "formatting-only")
            && cue.llm_first_at_ms.is_some() && cue.published_first_at_ms.is_some() && cue.rendered_first_at_ms.is_some()
            && cue.issues.iter().all(|issue| issue.category == "data" && issue.code == "cue-events-truncated" && issue.severity == "warning")
    }).collect::<Vec<_>>();
    (accepted.iter().map(|cue| cue.source_text.as_str()).collect::<Vec<_>>().join("\n"),
        accepted.iter().map(|cue| cue.rendered_text.as_str()).collect::<Vec<_>>().join("\n"))
}
