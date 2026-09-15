use super::super::contracts::{
    ProviderDraftInput, ProviderProbeCheckRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult,
};
use super::{routing, time};

/// Maps a transport smoke result into the durable provider probe profile used
/// by configuration, diagnostics, and scene routing.
#[derive(Clone, Default)]
pub(crate) struct ProviderProbeService;

impl ProviderProbeService {
    pub(crate) fn evaluate(
        &self,
        provider: ProviderDraftInput,
        smoke: ProviderSmokeResult,
    ) -> ProviderProbeProfileRuntime {
        let checked_at = time::now_unix_seconds_marker();
        let latency_ms = smoke.first_event_latency_ms.unwrap_or(smoke.duration_ms);
        let livetranslate_session_stable = smoke
            .wire_evidence
            .as_ref()
            .is_some_and(|evidence| {
                evidence.evidence_outcome == "livetranslate-session-finished"
                    && evidence.provider_error_frame.is_none()
                    && evidence.websocket_close.is_none()
                    && evidence.timeout_phase.is_none()
            });
        let response_shape_stable = smoke.status == "completed"
            && (livetranslate_session_stable
                || (smoke
                    .event_log
                    .iter()
                    .any(|item| item.event_type == "translation.completed")
                    && smoke
                        .event_log
                        .iter()
                        .any(|item| item.event_type == "response.completed")));
        let latency_budget_ms = routing::LATENCY_BUDGET_MS;
        let error_shape_stable = smoke.error.is_none()
            || smoke
                .error
                .as_ref()
                .map(|error| !error.code.is_empty() && !error.message.is_empty())
                .unwrap_or(false);
        let verdict = if smoke.error.is_some() || !response_shape_stable {
            "unavailable"
        } else if smoke.stream_observed && latency_ms <= latency_budget_ms {
            "available"
        } else if smoke.stream_observed && error_shape_stable {
            "realtime-risk"
        } else {
            "unavailable"
        };
        let routing_decision = routing::build_routing_decision(
            verdict,
            latency_ms,
            smoke.fallback_applied,
        );
        let input_tokens = smoke.input_tokens;
        let output_tokens = smoke.output_tokens;
        let audio_seconds = smoke.audio_seconds;
        let checks = vec![
            check(
                &provider.provider_id,
                "streaming",
                "流式能力",
                if smoke.stream_observed { "pass" } else { "fail" },
                if smoke.stream_observed {
                    format!("已观察到增量事件，实际传输模式为 {}。", smoke.transport_effective)
                } else {
                    format!("未观察到增量事件，当前为 {}。", smoke.transport_effective)
                },
            ),
            check(
                &provider.provider_id,
                "latency",
                "实时适用性",
                if latency_ms <= latency_budget_ms { "pass" } else { "warn" },
                format!("首个有效事件耗时 {latency_ms} ms，预算 {latency_budget_ms} ms。"),
            ),
            check(
                &provider.provider_id,
                "error-shape",
                "错误结构",
                if error_shape_stable { "pass" } else { "fail" },
                match smoke.error.as_ref() {
                    Some(error) => format!("已归一化为 {}，可直接给 UI 与 Diagnostics 使用。", error.code),
                    None => "本次请求未触发上游错误，当前归一化链路可用。".to_string(),
                },
            ),
            check(
                &provider.provider_id,
                "response-shape",
                "响应格式稳定性",
                if response_shape_stable { "pass" } else { "fail" },
                if response_shape_stable {
                    if livetranslate_session_stable {
                        "已完整得到 session.created、session.updated 与 session.finished。"
                            .to_string()
                    } else {
                        "已完整得到 translation.completed 与 response.completed。".to_string()
                    }
                } else {
                    "返回事件不完整，当前不建议接入实时主链路。".to_string()
                },
            ),
        ];

        ProviderProbeProfileRuntime {
            id: format!("probe-{}-{}", provider.provider_id, time::normalize_timestamp(&checked_at)),
            template_id: provider.template_id,
            provider_id: provider.provider_id,
            verdict: verdict.to_string(),
            checked_at,
            measured_latency_ms: latency_ms,
            latency_budget_ms,
            stream_supported: smoke.stream_observed,
            error_shape_stable,
            response_shape_stable,
            transport_requested: smoke.transport_requested,
            transport_effective: smoke.transport_effective,
            fallback_applied: smoke.fallback_applied,
            input_tokens,
            output_tokens,
            audio_seconds,
            connection_attempts: smoke.connection_attempts,
            connection_count: smoke.connection_count,
            connection_opened: smoke.connection_opened,
            connection_closed: smoke.connection_closed,
            connection_owner: smoke.connection_owner,
            connection_generation: smoke.connection_generation,
            checks,
            guidance: routing::build_probe_guidance(verdict, &routing_decision, smoke.fallback_applied),
            routing_decision,
            error: smoke.error,
            wire_evidence: smoke.wire_evidence,
        }
    }
}

fn check(provider_id: &str, key: &str, label: &str, status: &str, summary: String) -> ProviderProbeCheckRuntime {
    ProviderProbeCheckRuntime {
        id: format!("{provider_id}-{key}"),
        key: key.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        summary,
    }
}
