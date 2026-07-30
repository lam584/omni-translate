/// Truncate a string to at most `max_chars` characters (not bytes).
///
/// Unlike byte-based slicing (`&s[..n]`), this never panics on multi-byte
/// UTF-8 sequences because it counts characters and finds the correct byte
/// boundary before slicing.
pub(crate) fn truncate_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    #[test]
    fn ascii_truncation() {
        assert_eq!(truncate_chars("hello world", 5), "hello");
        assert_eq!(truncate_chars("hi", 10), "hi");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn cjk_truncation_does_not_panic() {
        let text = "你好世界这是一个测试文本";
        // Each CJK char is 3 bytes; byte slicing at 4 would panic.
        assert_eq!(truncate_chars(text, 2), "你好");
        assert_eq!(truncate_chars(text, 4), "你好世界");
        assert_eq!(truncate_chars(text, 100), text);
    }

    #[test]
    fn mixed_content() {
        let text = "abc你好def";
        assert_eq!(truncate_chars(text, 4), "abc你");
        assert_eq!(truncate_chars(text, 3), "abc");
    }

    #[test]
    fn emoji_truncation() {
        let text = "a\u{1F600}b"; // a😀b
        assert_eq!(truncate_chars(text, 2), "a\u{1F600}");
        assert_eq!(truncate_chars(text, 1), "a");
    }
}
