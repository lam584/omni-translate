#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RealtimeAdapterRoute {
    OpenAiConversation,
    OpenAiTranslation,
    OpenAiTranscription,
    GeminiLive,
    TencentSpeechTranslation,
}

/// Provider-owned projection from an exact manifest adapter/operation pair
/// into the shared audio route vocabulary. Core routing never interprets a
/// provider id or model name.
pub(crate) fn realtime_route(
    adapter_id: &str,
    operation: &str,
) -> Option<RealtimeAdapterRoute> {
    match (adapter_id, operation) {
        (
            "openai-realtime-websocket" | "azure-openai-realtime-websocket",
            "realtime-conversation",
        ) => Some(RealtimeAdapterRoute::OpenAiConversation),
        (
            "openai-realtime-websocket" | "azure-openai-realtime-websocket",
            "realtime-translation",
        ) => Some(RealtimeAdapterRoute::OpenAiTranslation),
        (
            "openai-realtime-websocket" | "azure-openai-realtime-websocket",
            "realtime-transcription",
        ) => Some(RealtimeAdapterRoute::OpenAiTranscription),
        ("gemini-live", "realtime-conversation") => Some(RealtimeAdapterRoute::GeminiLive),
        ("tencent-speech-translate-adapter", "realtime-translation") => {
            Some(RealtimeAdapterRoute::TencentSpeechTranslation)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_only_exact_adapter_operation_pairs() {
        assert_eq!(
            realtime_route("gemini-live", "realtime-conversation"),
            Some(RealtimeAdapterRoute::GeminiLive)
        );
        assert_eq!(realtime_route("gemini-live", "realtime-translation"), None);
        assert_eq!(realtime_route("gemini-looking-name", "realtime-conversation"), None);
    }
}
