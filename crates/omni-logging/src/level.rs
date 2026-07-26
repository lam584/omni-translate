/// Log severity shared by the desktop shell and the bridge service.
///
/// The numeric order matches the desktop diagnostics priorities
/// (`verbose` = 0 … `error` = 4), and the canonical string vocabulary is
/// `error/warning/info/debug/verbose` — the same set accepted by the
/// `OMNI_LOG_LEVEL` environment variable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Verbose = 0,
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4,
}

impl LogLevel {
    /// The `[{LEVEL}]` marker used in log lines. Matches the desktop shell's
    /// historical `level_marker` mapping (`info` → `NORMAL`,
    /// `verbose` → `TRACE`) so both processes emit identical markers.
    pub fn marker(self) -> &'static str {
        match self {
            LogLevel::Verbose => "TRACE",
            LogLevel::Debug => "DEBUG",
            LogLevel::Info => "NORMAL",
            LogLevel::Warning => "WARNING",
            LogLevel::Error => "ERROR",
        }
    }

    /// Parse the canonical level vocabulary, case-insensitively.
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "error" => Some(LogLevel::Error),
            "warning" => Some(LogLevel::Warning),
            "info" => Some(LogLevel::Info),
            "debug" => Some(LogLevel::Debug),
            "verbose" => Some(LogLevel::Verbose),
            _ => None,
        }
    }

    pub fn priority(self) -> u8 {
        self as u8
    }

    pub fn from_priority(priority: u8) -> Self {
        match priority {
            4 => LogLevel::Error,
            3 => LogLevel::Warning,
            2 => LogLevel::Info,
            1 => LogLevel::Debug,
            _ => LogLevel::Verbose,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LogLevel;

    #[test]
    fn parse_accepts_the_canonical_vocabulary_case_insensitively() {
        assert_eq!(LogLevel::parse("ERROR"), Some(LogLevel::Error));
        assert_eq!(LogLevel::parse("Warning"), Some(LogLevel::Warning));
        assert_eq!(LogLevel::parse("info"), Some(LogLevel::Info));
        assert_eq!(LogLevel::parse("DEBUG"), Some(LogLevel::Debug));
        assert_eq!(LogLevel::parse("Verbose"), Some(LogLevel::Verbose));
        assert_eq!(LogLevel::parse("trace"), None);
        assert_eq!(LogLevel::parse("warn"), None);
        assert_eq!(LogLevel::parse(""), None);
    }

    #[test]
    fn markers_match_the_desktop_level_marker_mapping() {
        assert_eq!(LogLevel::Error.marker(), "ERROR");
        assert_eq!(LogLevel::Warning.marker(), "WARNING");
        assert_eq!(LogLevel::Info.marker(), "NORMAL");
        assert_eq!(LogLevel::Debug.marker(), "DEBUG");
        assert_eq!(LogLevel::Verbose.marker(), "TRACE");
    }

    #[test]
    fn priority_round_trips() {
        for level in [
            LogLevel::Verbose,
            LogLevel::Debug,
            LogLevel::Info,
            LogLevel::Warning,
            LogLevel::Error,
        ] {
            assert_eq!(LogLevel::from_priority(level.priority()), level);
        }
    }
}
