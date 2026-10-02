use crate::audio::events::RealtimeProtocol;

// Protocol authority comes from the shared resolver. A model keyword (or an
// independently guessed profile id) is not permission to change capabilities.
pub(super) fn normalize_interaction_capabilities(
    mut capabilities: Vec<String>,
    protocol: Option<RealtimeProtocol>,
) -> Vec<String> {
    if protocol == Some(RealtimeProtocol::DashscopeLivetranslate) {
        capabilities.retain(|cap| !matches!(cap.to_ascii_lowercase().as_str(),
            "pipeline_asr_mt_tts" | "server_commit_tts" | "commit_tts" | "text_only_backend"));
        for required in ["auto_vad", "streaming"] {
            if !capabilities.iter().any(|cap| cap == required) {
                capabilities.push(required.to_string());
            }
        }
    }
    capabilities
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::contracts::ProviderDraftInput;
    use serde_json::json;

    fn provider(model: &str) -> ProviderDraftInput {
        serde_json::from_value(json!({
            "templateId": "t", "providerId": "p", "kind": "dashscope",
            "displayName": "Offline benchmark resolver fixture", "model": model,
            "templateRealtimeProtocol": "dashscope-livetranslate",
            "baseUrl": "https://dashscope.aliyuncs.com/api/v1", "region": "cn-beijing",
            "transport": "websocket", "streamEnabled": true, "timeoutMs": 1000,
            "systemPromptTemplate": "", "authRef": {
                "kind": "header", "reference": "offline-fixture", "headerName": "Authorization", "scheme": "Bearer"
            }
        })).unwrap()
    }

    #[test]
    fn exact_livetranslate_resolver_protocol_normalizes_capabilities_idempotently() {
        let provider = provider("qwen3.5-livetranslate-flash-realtime");
        let profile = crate::audio::events::resolve_realtime_profile(&provider, &provider.model);
        assert_eq!(profile.protocol_dialect, Some(RealtimeProtocol::DashscopeLivetranslate));
        let capabilities = ["PIPELINE_ASR_MT_TTS", "server_commit_tts", "commit_tts", "text_only_backend", "streaming", "other"]
            .into_iter().map(str::to_string).collect();
        let normalized = normalize_interaction_capabilities(capabilities, profile.protocol_dialect);
        assert_eq!(normalized, ["streaming", "other", "auto_vad"]);
        assert_eq!(normalize_interaction_capabilities(normalized.clone(), profile.protocol_dialect), normalized);
    }

    #[test]
    fn keyword_in_unregistered_model_cannot_override_resolver_rejection() {
        let provider = provider("unregistered-livetranslate-realtime-model");
        let profile = crate::audio::events::resolve_realtime_profile(&provider, &provider.model);
        assert_eq!(profile.protocol_dialect, None);
        let original = vec!["pipeline_asr_mt_tts".to_string(), "commit_tts".to_string()];
        assert_eq!(normalize_interaction_capabilities(original.clone(), profile.protocol_dialect), original);
    }

    #[test]
    fn other_protocols_preserve_existing_capabilities() {
        let original = vec!["server_commit_tts".to_string(), "text_only_backend".to_string()];
        for protocol in [None, Some(RealtimeProtocol::DashscopeOmni), Some(RealtimeProtocol::OpenAiTranslation), Some(RealtimeProtocol::GeminiLive)] {
            assert_eq!(normalize_interaction_capabilities(original.clone(), protocol), original);
        }
    }
}
