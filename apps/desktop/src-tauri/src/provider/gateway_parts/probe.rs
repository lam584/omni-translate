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
        let response_shape_stable = smoke.status == "completed"
            && smoke.event_log.iter().any(|item| item.event_type == "translation.completed")
            && smoke.event_log.iter().any(|item| item.event_type == "response.completed");
        let error_shape_stable = smoke.error.is_none()
            || smoke
                .error
                .as_ref()
                .map(|error| !error.code.is_empty() && !error.message.is_empty())
                .unwrap_or(false);
        let verdict = if smoke.error.is_some() || !response_shape_stable {
            "unavailable"
        } else if smoke.stream_observed && latency_ms <= routing::LATENCY_BUDGET_MS {
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
                if latency_ms <= routing::LATENCY_BUDGET_MS { "pass" } else { "warn" },
                format!("首个有效事件耗时 {latency_ms} ms，预算 {} ms。", routing::LATENCY_BUDGET_MS),
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
                    "已完整得到 translation.completed 与 response.completed。".to_string()
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
            latency_budget_ms: routing::LATENCY_BUDGET_MS,
            stream_supported: smoke.stream_observed,
            error_shape_stable,
            response_shape_stable,
            transport_requested: smoke.transport_requested,
            transport_effective: smoke.transport_effective,
            fallback_applied: smoke.fallback_applied,
            checks,
            guidance: routing::build_probe_guidance(verdict, &routing_decision, smoke.fallback_applied),
            routing_decision,
            error: smoke.error,
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
