use super::*;
use std::sync::{mpsc, Arc};
use super::super::super::contracts::WatchSessionReportRuntime;

fn plan(model: &str) -> ResolvedRoutePlan {
    let provider = serde_json::json!({
        "templateId": "template-dashscope-workspace", "providerId": "provider-dashscope",
        "manifestProviderId": "bailian", "kind": "dashscope", "displayName": "Workspace",
        "model": model, "modelRegistryVersion": 2,
        "baseUrl": "wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
        "transport": "websocket", "region": "cn-beijing", "timeoutMs": 30000,
        "authRef": {"kind": "env-ref", "reference": "TEST_KEY", "headerName": "Authorization", "scheme": "bearer"},
        "streamEnabled": true, "systemPromptTemplate": "",
        "modelProtocolBindings": [{"modelId": "qwen3.8-livetranslate-flash-realtime", "operation": "realtime-translation",
            "profileOwnerProviderId": "bailian", "manifestVersion": 1, "profileId": "bailian.livetranslate.3_8.realtime.ws", "profileVersion": 1}]
    });
    let config = serde_json::json!({"devices": {"routeMode": "watch", "subtitleTranslationMode": "native"}, "providers": [provider]});
    let provider = serde_json::from_value(config["providers"][0].clone()).unwrap();
    let plan = ResolvedRoutePlan::from_resolved_provider("inbound", &config,
        format!("template-dashscope-workspace::{model}"), provider);
    assert!(plan.configuration_error.is_none(), "{:?}", plan.configuration_error);
    plan
}

fn start_fake_preconnect(state: &Arc<AudioStateStore>, plan: &ResolvedRoutePlan) -> mpsc::Receiver<WatchSessionReportRuntime> {
    prepare_watch_report_for_plan(state, plan).unwrap();
    let key = &plan.session_reuse_key;
    let generation = state.begin_omni_session_with_languages("inbound", &key.model,
        &key.source_language, &key.target_language, &key.realtime_audio_mode,
        key.subtitle_translate_active, key.output_mode, key.contract_signature);
    assert!(state.mark_omni_session_ready("inbound", generation));
    let (audio_tx, _audio_rx) = mpsc::channel();
    state.store_omni_sender("inbound", audio_tx);
    let (stop_tx, stop_rx) = mpsc::channel();
    let (final_tx, final_rx) = mpsc::channel();
    let worker_state = Arc::clone(state);
    let worker = std::thread::spawn(move || {
        stop_rx.recv().unwrap();
        worker_state.watch_session_report.record_session_error("old-worker-final", "final old-owner event");
        final_tx.send(worker_state.watch_session_report.snapshot().unwrap()).unwrap();
    });
    assert!(state.store_omni_handle("inbound", omni::OmniHandle::new(stop_tx, worker)).is_none());
    final_rx
}

#[test]
fn realtime_preconnect_to_livetranslate_joins_old_publisher_before_new_report() {
    let state = Arc::new(AudioStateStore::new());
    let omni = plan("qwen3.5-livetranslate-flash-realtime");
    let old_final = start_fake_preconnect(&state, &omni);
    let old_id = state.watch_session_report.session_id().unwrap();
    // Exercise the exact fast-ack mutation that used to overwrite a sealed report.
    state.watch_session_report.begin_or_reuse("", "template-dashscope-workspace::qwen3.8-livetranslate-flash-realtime");
    assert_eq!(state.watch_session_report.snapshot().unwrap().model, omni.provider.model);
    let _guard = state.lock_inbound_pipeline();
    let live = plan("qwen3.8-livetranslate-flash-realtime");
    prepare_watch_report_for_plan(&state, &live).unwrap();
    let final_old = old_final.recv().unwrap();
    assert_eq!(final_old.session_id, old_id);
    assert_eq!(final_old.status, "active");
    assert_eq!(final_old.model, omni.provider.model);
    assert!(final_old.issues.iter().any(|issue| issue.code == "old-worker-final"));
    let new = state.watch_session_report.snapshot().unwrap();
    assert_ne!(new.session_id, old_id);
    assert_eq!(new.model, live.provider.model);
    assert_eq!(new.model_protocol_profile_identity.unwrap().exact_model_id, live.provider.model);
    assert!(new.issues.is_empty());
    assert!(!state.has_omni_sender("inbound"));
    assert!(state.omni_session_metadata("inbound").is_none());
}

#[test]
fn identical_preconnect_contract_is_reused_without_stopping_worker() {
    let state = Arc::new(AudioStateStore::new());
    let live = plan("qwen3.8-livetranslate-flash-realtime");
    let old_final = start_fake_preconnect(&state, &live);
    let id = state.watch_session_report.session_id().unwrap();
    prepare_watch_report_for_plan(&state, &live).unwrap();
    assert_eq!(state.watch_session_report.session_id().unwrap(), id);
    assert!(state.has_omni_sender("inbound"));
    assert!(old_final.try_recv().is_err());
    state.take_omni_handle("inbound").unwrap().stop_and_join("inbound").unwrap();
    old_final.recv().unwrap();
}

#[test]
fn same_identity_with_changed_connection_contract_joins_but_reuses_report() {
    let state = Arc::new(AudioStateStore::new());
    let mut live = plan("qwen3.8-livetranslate-flash-realtime");
    let old_final = start_fake_preconnect(&state, &live);
    let id = state.watch_session_report.session_id().unwrap();
    live.session_reuse_key.contract_signature = live.session_reuse_key.contract_signature.wrapping_add(1);
    prepare_watch_report_for_plan(&state, &live).unwrap();
    old_final.recv().unwrap();
    assert_eq!(state.watch_session_report.session_id().unwrap(), id);
    assert!(!state.has_omni_sender("inbound"));
}

#[test]
fn invalid_new_plan_does_not_retire_the_existing_preconnect() {
    let state = Arc::new(AudioStateStore::new());
    let live = plan("qwen3.8-livetranslate-flash-realtime");
    let old_final = start_fake_preconnect(&state, &live);
    let id = state.watch_session_report.session_id().unwrap();
    let mut invalid = plan("qwen3.5-livetranslate-flash-realtime");
    invalid.configuration_error = Some("model_protocol.endpoint_host_region_mismatch".into());
    assert!(prepare_watch_report_for_plan(&state, &invalid).is_err());
    assert_eq!(state.watch_session_report.session_id().unwrap(), id);
    assert!(state.has_omni_sender("inbound"));
    state.take_omni_handle("inbound").unwrap().stop_and_join("inbound").unwrap();
    old_final.recv().unwrap();
}


#[test]
fn completed_report_with_a_parked_owner_is_retired_before_next_session() {
    let state = Arc::new(AudioStateStore::new());
    let live = plan("qwen3.8-livetranslate-flash-realtime");
    let old_final = start_fake_preconnect(&state, &live);
    let id = state.watch_session_report.session_id().unwrap();
    // A failed route attempt can finish its report while the preconnect remains parked.
    state.watch_session_report.complete();
    prepare_watch_report_for_plan(&state, &live).unwrap();
    let old = old_final.recv().unwrap();
    assert_eq!(old.session_id, id);
    assert_eq!(old.status, "completed");
    let new = state.watch_session_report.snapshot().unwrap();
    assert_ne!(new.session_id, id);
    assert!(new.issues.is_empty());
    assert!(!state.has_omni_sender("inbound"));
}


#[test]
fn failed_fast_start_does_not_complete_or_pollute_an_existing_preconnect_report() {
    let state = Arc::new(AudioStateStore::new());
    let live = plan("qwen3.8-livetranslate-flash-realtime");
    let old_final = start_fake_preconnect(&state, &live);
    let id = state.watch_session_report.session_id().unwrap();
    let mut invalid = plan("qwen3.5-livetranslate-flash-realtime");
    invalid.configuration_error = Some("model_protocol.endpoint_host_region_mismatch".into());
    let _guard = state.lock_inbound_pipeline();
    let outcome = super::super::route_orchestrator::execute_fast_watch_start(
        &state,
        std::panic::AssertUnwindSafe(|| {
            prepare_watch_report_for_plan(&state, &invalid)?;
            Ok(state.snapshot())
        }),
        || {},
    );
    assert!(matches!(outcome, super::super::route_orchestrator::FastWatchStartOutcome::Failed(_)));
    let report = state.watch_session_report.snapshot().unwrap();
    assert_eq!(report.session_id, id);
    assert_eq!(report.status, "active");
    assert!(report.issues.is_empty());
    assert!(state.snapshot().inbound.last_error.is_some());
    assert!(state.has_omni_sender("inbound"));
    state.take_omni_handle("inbound").unwrap().stop_and_join("inbound").unwrap();
    assert_eq!(old_final.recv().unwrap().status, "active");
}

#[test]
fn failed_fast_handoff_does_not_complete_report_owned_by_outbound_route() {
    let state = Arc::new(AudioStateStore::new());
    let omni = plan("qwen3.5-livetranslate-flash-realtime");
    prepare_watch_report_for_plan(&state, &omni).unwrap();
    state.mark_route_started("outbound", "outbound-owner", "microphone", "microphone");
    let id = state.watch_session_report.session_id().unwrap();
    let _guard = state.lock_inbound_pipeline();
    let outcome = super::super::route_orchestrator::execute_fast_watch_start(
        &state,
        std::panic::AssertUnwindSafe(|| {
            prepare_watch_report_for_plan(&state, &plan("qwen3.8-livetranslate-flash-realtime"))?;
            Ok(state.snapshot())
        }),
        || {},
    );
    assert!(matches!(outcome, super::super::route_orchestrator::FastWatchStartOutcome::Failed(_)));
    let report = state.watch_session_report.snapshot().unwrap();
    assert_eq!(report.session_id, id);
    assert_eq!(report.status, "active");
    assert_eq!(report.model, omni.provider.model);
    assert!(report.issues.is_empty());
    assert!(state.snapshot().outbound.stream_bound);
}
