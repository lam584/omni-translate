use super::*;

#[cfg(test)]
use std::cell::RefCell;

pub(super) struct PreparedLiveTranslateProbePlan {
    pub(super) session_update: Value,
    pub(super) session_finish: Value,
    pub(super) requested_config: Value,
    pub(super) protocol_authority:
        crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    pub(super) protocol_state: crate::audio::bailian_protocol::LiveTranslateServerState,
}

pub(super) fn prepare_livetranslate_probe_plan(
    context: &ProviderCallContext<'_>,
) -> Result<PreparedLiveTranslateProbePlan, ProviderRuntimeError> {
    let provider = context.provider;
    let protocol_authority = crate::audio::events::authorize_bailian_native_translate(provider)
        .map_err(|error| ProviderRuntimeError::new("protocol.profile-invalid", error))?;
    let source_language = crate::audio::omni::resolve_livetranslate_language(
        &protocol_authority,
        context.source_language,
        "en",
    )
    .map_err(|error| ProviderRuntimeError::new("request.invalid", error))?;
    let target_language = crate::audio::omni::resolve_livetranslate_language(
        &protocol_authority,
        context.target_language,
        "zh",
    )
    .map_err(|error| ProviderRuntimeError::new("request.invalid", error))?;
    let safe_id = context.request_id.replace(':', "_").replace('-', "_");
    let mut session_update =
        crate::audio::omni::build_omni_session_update_for_provider_with_output_mode(
            provider,
            "",
            "",
            crate::audio::omni::RealtimeAudioMode::ServerVad,
            &source_language,
            &target_language,
            crate::audio::omni::OmniOutputMode::TextOnly,
        );
    crate::audio::omni::apply_watch_release_livetranslate_corpus(
        &mut session_update,
        context.strict_livetranslate_authority,
        &source_language,
        &target_language,
    );
    session_update["event_id"] = Value::String(format!("evt_{}_session", safe_id));
    let session_finish = json!({
        "event_id": format!("evt_{}_finish", safe_id),
        "type": "session.finish",
    });
    #[cfg(test)]
    let (session_update, session_finish) =
        apply_test_client_plan_mutation(session_update, session_finish);

    let mut protocol_state = crate::audio::bailian_protocol::LiveTranslateServerState::default();
    protocol_state
        .record_client_session_update(&protocol_authority, &session_update)
        .map_err(|error| ProviderRuntimeError::new("protocol.client-payload-invalid", error))?;
    crate::audio::bailian_protocol::admit_livetranslate_client_event(
        &protocol_authority,
        &session_finish,
    )
    .map_err(|error| ProviderRuntimeError::new("protocol.client-payload-invalid", error))?;
    let requested_config = normalized_livetranslate_probe_config(
        session_update.pointer("/session").unwrap_or(&Value::Null),
    );

    Ok(PreparedLiveTranslateProbePlan {
        session_update,
        session_finish,
        requested_config,
        protocol_authority,
        protocol_state,
    })
}

#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(super) enum TestClientPlanMutation {
    OmniOnlySessionField,
    UnknownSessionField,
    WrongTerminalEvent,
}

#[cfg(test)]
thread_local! {
    static TEST_CLIENT_PLAN_MUTATION: RefCell<Option<TestClientPlanMutation>> =
        const { RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn set_test_client_plan_mutation(mutation: TestClientPlanMutation) {
    TEST_CLIENT_PLAN_MUTATION.with(|slot| {
        assert!(
            slot.borrow().is_none(),
            "test client plan mutation must be consumed before another is registered"
        );
        *slot.borrow_mut() = Some(mutation);
    });
}

#[cfg(test)]
fn apply_test_client_plan_mutation(
    mut session_update: Value,
    mut session_finish: Value,
) -> (Value, Value) {
    TEST_CLIENT_PLAN_MUTATION.with(|slot| match slot.borrow_mut().take() {
        Some(TestClientPlanMutation::OmniOnlySessionField) => {
            session_update["session"]["instructions"] =
                Value::String("forbidden Omni prompt".to_string());
        }
        Some(TestClientPlanMutation::UnknownSessionField) => {
            session_update["session"]["future_provider_knob"] = Value::Bool(true);
        }
        Some(TestClientPlanMutation::WrongTerminalEvent) => {
            session_finish["type"] = Value::String("response.create".to_string());
        }
        None => {}
    });
    (session_update, session_finish)
}
