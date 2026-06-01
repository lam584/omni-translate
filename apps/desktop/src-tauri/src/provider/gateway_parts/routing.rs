use serde_json::{json, Value};

use super::super::contracts::{ProviderDraftInput, ProviderRoutingDecision};

pub(super) const LATENCY_BUDGET_MS: u64 = 1200;

pub(super) fn build_messages(
    provider: &ProviderDraftInput,
    source_text: &str,
    source_language: &str,
    target_language: &str,
    glossary_package_ids: &[String],
) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut system_text = format!(
    "promptTemplateId={}\nsourceLanguage={}\ntargetLanguage={}\n请输出自然、简洁、可直接展示的翻译。",
    provider.system_prompt_template,
    source_language,
    target_language,
  );
    if !glossary_package_ids.is_empty() {
        system_text.push_str(&format!(
            "\nglossaryPackageIds={}",
            glossary_package_ids.join(",")
        ));
    }
    messages.push(json!({ "role": "system", "content": system_text }));
    messages.push(json!({ "role": "user", "content": source_text }));
    messages
}

pub(super) fn build_routing_decision(
    verdict: &str,
    latency_ms: u64,
    fallback_applied: bool,
) -> ProviderRoutingDecision {
    match verdict {
        "available" => ProviderRoutingDecision {
            subtitle_priority: "balanced".to_string(),
            speech_disposition: "ready".to_string(),
            rationale: if fallback_applied {
                "已做传输回退，但当前延迟和结构稳定性仍满足实时要求。".to_string()
            } else {
                format!("当前延迟 {} ms，允许字幕与译音并行。", latency_ms)
            },
        },
        "realtime-risk" => ProviderRoutingDecision {
            subtitle_priority: "subtitle-first".to_string(),
            speech_disposition: "deferred".to_string(),
            rationale: format!(
                "当前延迟 {} ms 超过预算，优先保证字幕不断流，译音进入 deferred。",
                latency_ms
            ),
        },
        _ => ProviderRoutingDecision {
            subtitle_priority: "subtitle-first".to_string(),
            speech_disposition: "queued".to_string(),
            rationale: "当前 Provider 不可用或响应结构不稳定，禁止进入实时主链路。".to_string(),
        },
    }
}

pub(super) fn build_probe_guidance(
    verdict: &str,
    routing_decision: &ProviderRoutingDecision,
    fallback_applied: bool,
) -> Vec<String> {
    let mut guidance = vec![routing_decision.rationale.clone()];
    if fallback_applied {
        guidance.push(
            "本次探测已发生 transport fallback，请检查模板默认传输模式是否与上游一致。".to_string(),
        );
    }
    match verdict {
        "available" => {
            guidance.push("可直接用于真实 Provider 连通性测试与后续字幕/译音主链路。".to_string())
        }
        "realtime-risk" => {
            guidance.push("建议保留字幕优先，默认关闭译音叠加，避免阻塞实时字幕。".to_string())
        }
        _ => guidance.push("建议先修复认证、请求路径或响应格式，再重新探测。".to_string()),
    }
    guidance
}
