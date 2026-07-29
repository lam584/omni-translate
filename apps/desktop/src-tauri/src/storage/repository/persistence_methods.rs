use rusqlite::{params, Connection};
use serde_json::Value;

use crate::common::MapErrToString;

use super::json_merge::{bool_at, bool_to_i64, f64_at, i64_at, string_at};
use super::{insert_string_array, ConfigRepository};

/// Insert each string entry of a `capabilities` array via `insert`, which
/// receives the capability text and its zero-based position. Non-string
/// entries are skipped, matching the per-domain loops that previously repeated
/// this shape.
fn insert_each_capability_str<F>(capabilities: &[Value], mut insert: F) -> Result<(), String>
where
    F: FnMut(&str, i64) -> Result<(), String>,
{
    for (position, capability) in capabilities.iter().enumerate() {
        if let Some(capability) = capability.as_str() {
            insert(capability, position as i64)?;
        }
    }
    Ok(())
}

impl ConfigRepository {
    pub(super) fn persist_providers(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        if let Some(providers) = config.get("providers").and_then(Value::as_array) {
            for (position, provider) in providers.iter().enumerate() {
                self.persist_provider(
                    connection,
                    &format!("provider-{position}"),
                    position as i64,
                    false,
                    provider,
                    timestamp,
                )?;
            }
        }

        // Backward compat: also persist legacy provider/linkedProviders if present
        if let Some(provider) = config.get("provider") {
            self.persist_provider(connection, "primary", 0, true, provider, timestamp)?;
        }

        if let Some(linked) = config.get("linkedProviders").and_then(Value::as_array) {
            for (position, provider) in linked.iter().enumerate() {
                self.persist_provider(
                    connection,
                    &format!("linked-{position}"),
                    (position + 1) as i64,
                    false,
                    provider,
                    timestamp,
                )?;
            }
        }

        Ok(())
    }

    fn persist_provider(
        &self,
        connection: &Connection,
        provider_key: &str,
        position: i64,
        is_primary: bool,
        provider: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        connection
            .execute(
                "INSERT INTO providers (
                  provider_key, position, is_primary, template_id, template_version, template_source,
                  provider_id, kind, display_name, mode, model, base_url, transport, region,
                  stream_enabled, timeout_ms, system_prompt_template, temperature, max_output_tokens,
                  probe_profile_id, probe_verdict, probe_checked_at, probe_stream_supported,
                  probe_error_shape_stable, probe_response_shape_stable, status, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
                params![
                    provider_key,
                    position,
                    bool_to_i64(is_primary),
                    string_at(provider, "/templateId"),
                    string_at(provider, "/templateVersion"),
                    string_at(provider, "/templateSource"),
                    string_at(provider, "/providerId"),
                    string_at(provider, "/kind"),
                    string_at(provider, "/displayName"),
                    string_at(provider, "/mode"),
                    string_at(provider, "/model"),
                    string_at(provider, "/baseUrl"),
                    string_at(provider, "/transport"),
                    string_at(provider, "/region"),
                    bool_at(provider, "/streamEnabled").map(bool_to_i64),
                    i64_at(provider, "/timeoutMs"),
                    string_at(provider, "/systemPromptTemplate"),
                    f64_at(provider, "/temperature"),
                    i64_at(provider, "/maxOutputTokens"),
                    string_at(provider, "/probe/profileId"),
                    string_at(provider, "/probe/verdict"),
                    string_at(provider, "/probe/checkedAt"),
                    bool_at(provider, "/probe/streamSupported").map(bool_to_i64),
                    bool_at(provider, "/probe/errorShapeStable").map(bool_to_i64),
                    bool_at(provider, "/probe/responseShapeStable").map(bool_to_i64),
                    string_at(provider, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;

        if let Some(auth_ref) = provider.get("authRef") {
            connection
                .execute(
                    "INSERT INTO provider_auth_refs (provider_key, kind, reference, header_name, scheme)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        provider_key,
                        string_at(auth_ref, "/kind"),
                        string_at(auth_ref, "/reference"),
                        string_at(auth_ref, "/headerName"),
                        string_at(auth_ref, "/scheme"),
                    ],
                )
                .map_err_str()?;
        }

        insert_string_array(
            connection,
            "provider_response_modalities",
            "provider_key",
            provider_key,
            "modality",
            provider.get("responseModalities"),
        )?;

        if let Some(headers) = provider.get("customHeaders").and_then(Value::as_array) {
            for (position, header) in headers.iter().enumerate() {
                connection
                    .execute(
                        "INSERT INTO provider_custom_headers (provider_key, header_id, position, name, value, enabled)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            provider_key,
                            string_at(header, "/id").unwrap_or_else(|| format!("header-{position}")),
                            position as i64,
                            string_at(header, "/name"),
                            string_at(header, "/value"),
                            bool_at(header, "/enabled").map(bool_to_i64),
                        ],
                    )
                    .map_err_str()?;
            }
        }

        if let Some(assignments) = provider
            .get("sceneModelAssignments")
            .and_then(Value::as_array)
        {
            for (position, assignment) in assignments.iter().enumerate() {
                let scenario = string_at(assignment, "/scenario")
                    .unwrap_or_else(|| format!("scenario-{position}"));
                connection
                    .execute(
                        "INSERT INTO provider_scene_model_assignments (provider_key, scenario, position)
                         VALUES (?1, ?2, ?3)",
                        params![provider_key, scenario, position as i64],
                    )
                    .map_err_str()?;

                if let Some(model_ids) = assignment.get("modelIds").and_then(Value::as_array) {
                    for (model_position, model_id) in model_ids.iter().enumerate() {
                        if let Some(model_id) = model_id.as_str() {
                            connection
                                .execute(
                                    "INSERT INTO provider_scene_model_ids (provider_key, scenario, model_id, position)
                                     VALUES (?1, ?2, ?3, ?4)",
                                    params![provider_key, scenario, model_id, model_position as i64],
                                )
                                .map_err_str()?;
                        }
                    }
                }
            }
        }

        if let Some(entries) = provider
            .get("localModelCapabilityRegistry")
            .and_then(Value::as_array)
        {
            for (position, entry) in entries.iter().enumerate() {
                let entry_id =
                    string_at(entry, "/id").unwrap_or_else(|| format!("capability-{position}"));
                if let Some(capabilities) = entry.get("capabilities").and_then(Value::as_array) {
                    insert_each_capability_str(capabilities, |capability, capability_position| {
                        connection
                            .execute(
                                "INSERT INTO provider_model_capabilities (provider_key, entry_id, model_id, capability, position)
                                     VALUES (?1, ?2, ?3, ?4, ?5)",
                                params![
                                    provider_key,
                                    entry_id,
                                    string_at(entry, "/modelId"),
                                    capability,
                                    capability_position,
                                ],
                            )
                            .map_err_str()?;
                        Ok(())
                    })?;
                }
            }
        }

        if let Some(cache) = provider.get("modelCatalogCache") {
            connection
                .execute(
                    "INSERT INTO provider_model_catalog_cache (provider_key, signature, source, endpoint, fetched_at, error)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        provider_key,
                        string_at(cache, "/signature"),
                        string_at(cache, "/source"),
                        string_at(cache, "/endpoint"),
                        string_at(cache, "/fetchedAt"),
                        string_at(cache, "/error"),
                    ],
                )
                .map_err_str()?;

            if let Some(models) = cache.get("models").and_then(Value::as_array) {
                for (position, model) in models.iter().enumerate() {
                    let model_id = string_at(model, "/id")
                        .unwrap_or_else(|| format!("catalog-model-{position}"));
                    connection
                        .execute(
                            "INSERT INTO provider_model_catalog_items (
                              provider_key, item_id, position, display_name, owned_by, created_at,
                              provider_template_id, provider_template_name
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                            params![
                                provider_key,
                                model_id,
                                position as i64,
                                string_at(model, "/displayName"),
                                string_at(model, "/ownedBy"),
                                i64_at(model, "/createdAt"),
                                string_at(model, "/providerTemplateId"),
                                string_at(model, "/providerTemplateName"),
                            ],
                        )
                        .map_err_str()?;

                    if let Some(capabilities) = model.get("capabilities").and_then(Value::as_array)
                    {
                        insert_each_capability_str(capabilities, |capability, capability_position| {
                            connection
                                .execute(
                                    "INSERT INTO provider_model_catalog_item_capabilities (provider_key, item_id, capability, position)
                                         VALUES (?1, ?2, ?3, ?4)",
                                    params![provider_key, model_id, capability, capability_position],
                                )
                                .map_err_str()?;
                            Ok(())
                        })?;
                    }
                }
            }
        }

        Ok(())
    }

    pub(super) fn persist_audio(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let devices = config.get("devices").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO audio_device_preferences (
                  id, route_mode, input_device_id, output_device_id, virtual_render_device_id, playback_device_id,
                  virtual_mic_state, support_profile_id, subtitle_translation_mode,
                  subtitle_translation_model_id, inbound_voice_model_id, outbound_voice_model_id,
                  text_to_speech_model_id,
                  feedback_loop_prevention, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    string_at(devices, "/routeMode"),
                    string_at(devices, "/inputDeviceId"),
                    string_at(devices, "/outputDeviceId"),
                    string_at(devices, "/virtualRenderDeviceId"),
                    string_at(devices, "/playbackDeviceId"),
                    string_at(devices, "/virtualMicState"),
                    string_at(devices, "/supportProfileId"),
                    string_at(devices, "/subtitleTranslationMode"),
                    string_at(devices, "/subtitleTranslationModelId"),
                    string_at(devices, "/inboundVoiceModelId"),
                    string_at(devices, "/outboundVoiceModelId"),
                    string_at(devices, "/textToSpeechModelId"),
                    string_at(devices, "/feedbackLoopPrevention"),
                    string_at(devices, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;

        self.persist_audio_route(
            connection,
            "inbound",
            devices.get("inboundRoute"),
            timestamp,
        )?;
        self.persist_audio_route(
            connection,
            "outbound",
            devices.get("outboundRoute"),
            timestamp,
        )?;
        Ok(())
    }

    fn persist_audio_route(
        &self,
        connection: &Connection,
        direction_key: &str,
        route: Option<&Value>,
        timestamp: &str,
    ) -> Result<(), String> {
        let route = route.unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO audio_routes (
                  direction_key, route_id, direction, input_source_id, input_kind, input_device_id,
                  input_state, input_muted, input_buffer_ahead_ms, input_pre_buffer_state,
                  keep_original_audio, translated_audio_enabled, translated_audio_gain_db,
                  translated_audio_auto_gain_enabled, original_audio_gain_db, ducking_enabled, ducking_depth_percent, monitor_mode,
                  capture_buffer_ms, translation_buffer_ms, playback_buffer_ms, compensation_ms,
                  push_to_talk_enabled, push_to_talk_hotkey, push_to_talk_state,
                  push_to_talk_release_delay_ms, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)",
                params![
                    direction_key,
                    string_at(route, "/routeId"),
                    string_at(route, "/direction"),
                    string_at(route, "/input/sourceId"),
                    string_at(route, "/input/kind"),
                    string_at(route, "/input/deviceId"),
                    string_at(route, "/input/state"),
                    bool_at(route, "/input/muted").map(bool_to_i64),
                    i64_at(route, "/input/bufferAheadMs"),
                    string_at(route, "/input/preBufferState"),
                    bool_at(route, "/mixControl/keepOriginalAudio").map(bool_to_i64),
                    bool_at(route, "/mixControl/translatedAudioEnabled").map(bool_to_i64),
                    f64_at(route, "/mixControl/translatedAudioGainDb"),
                    bool_at(route, "/mixControl/translatedAudioAutoGainEnabled").map(bool_to_i64),
                    f64_at(route, "/mixControl/originalAudioGainDb"),
                    bool_at(route, "/mixControl/duckingEnabled").map(bool_to_i64),
                    i64_at(route, "/mixControl/duckingDepthPercent"),
                    string_at(route, "/mixControl/monitorMode"),
                    i64_at(route, "/latencyControl/captureBufferMs"),
                    i64_at(route, "/latencyControl/translationBufferMs"),
                    i64_at(route, "/latencyControl/playbackBufferMs"),
                    i64_at(route, "/latencyControl/compensationMs"),
                    bool_at(route, "/pushToTalk/enabled").map(bool_to_i64),
                    string_at(route, "/pushToTalk/hotkey"),
                    string_at(route, "/pushToTalk/state"),
                    i64_at(route, "/pushToTalk/releaseDelayMs"),
                    timestamp,
                ],
            )
            .map_err_str()?;

        if let Some(outputs) = route.get("outputs").and_then(Value::as_array) {
            for (position, output) in outputs.iter().enumerate() {
                connection
                    .execute(
                        "INSERT INTO audio_route_outputs (direction_key, target_id, position, kind, device_id, enabled)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            direction_key,
                            string_at(output, "/targetId").unwrap_or_else(|| format!("output-{position}")),
                            position as i64,
                            string_at(output, "/kind"),
                            string_at(output, "/deviceId"),
                            bool_at(output, "/enabled").map(bool_to_i64),
                        ],
                    )
                    .map_err_str()?;
            }
        }

        Ok(())
    }

    pub(super) fn persist_subtitles(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let subtitles = config.get("subtitles").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO subtitle_preferences (
                  id, source_language, target_language, translation_language_preference,
                  display_mode, caption_density, priority_mode, instructions, overlay_opacity,
                  overlay_locked, overlay_text_color, overlay_text_opacity, overlay_background_color,
                  overlay_background_opacity, overlay_font_family, overlay_width, overlay_height,
                  overlay_x, overlay_y, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    string_at(subtitles, "/sourceLanguage"),
                    string_at(subtitles, "/targetLanguage"),
                    string_at(subtitles, "/translationLanguagePreference"),
                    string_at(subtitles, "/mode"),
                    string_at(subtitles, "/captionDensity"),
                    string_at(subtitles, "/priority"),
                    string_at(subtitles, "/instructions"),
                    f64_at(subtitles, "/overlayOpacity"),
                    bool_at(subtitles, "/overlayLocked").map(bool_to_i64),
                    string_at(subtitles, "/overlayTextColor"),
                    f64_at(subtitles, "/overlayTextOpacity"),
                    string_at(subtitles, "/overlayBackgroundColor"),
                    f64_at(subtitles, "/overlayBackgroundOpacity"),
                    string_at(subtitles, "/overlayFontFamily"),
                    i64_at(subtitles, "/overlayWidth"),
                    i64_at(subtitles, "/overlayHeight"),
                    i64_at(subtitles, "/overlayX"),
                    i64_at(subtitles, "/overlayY"),
                    string_at(subtitles, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;
        Ok(())
    }

    pub(super) fn persist_speech(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let speech = config.get("speech").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO speech_preferences (
                  id, speech_enabled, target_language, voice_preset_id, text_to_speech_model_id,
                  voice, output_target,
                  local_playback_enabled, virtual_mic_output_enabled, dispatch_state, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    bool_at(speech, "/enabled").map(bool_to_i64),
                    string_at(speech, "/targetLanguage"),
                    string_at(speech, "/voicePresetId"),
                    string_at(speech, "/textToSpeechModelId"),
                    string_at(speech, "/voice"),
                    string_at(speech, "/outputTarget"),
                    bool_at(speech, "/localPlaybackEnabled").map(bool_to_i64),
                    bool_at(speech, "/virtualMicOutputEnabled").map(bool_to_i64),
                    string_at(speech, "/dispatchState"),
                    string_at(speech, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;
        Ok(())
    }

    pub(super) fn persist_driver(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let driver = config.get("driver").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO driver_preferences (
                  id, protocol_version, install_channel, install_phase, target_device_id,
                  expected_driver_version, expected_bridge_version, rollback_supported,
                  last_error_code, recommended_action, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    string_at(driver, "/protocolVersion"),
                    string_at(driver, "/installChannel"),
                    string_at(driver, "/installPhase"),
                    string_at(driver, "/targetDeviceId"),
                    string_at(driver, "/expectedDriverVersion"),
                    string_at(driver, "/expectedBridgeVersion"),
                    bool_at(driver, "/rollbackSupported").map(bool_to_i64),
                    string_at(driver, "/lastErrorCode"),
                    string_at(driver, "/recommendedAction"),
                    string_at(driver, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;
        Ok(())
    }

    pub(super) fn persist_glossary(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let glossary = config.get("glossary").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO glossary_preferences (
                  id, template_id, scenario, injection_strategy, game_dictionary_id,
                  import_strategy, export_format, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    string_at(glossary, "/templateId"),
                    string_at(glossary, "/scenario"),
                    string_at(glossary, "/injectionStrategy"),
                    string_at(glossary, "/gameDictionaryId"),
                    string_at(glossary, "/importStrategy"),
                    string_at(glossary, "/exportFormat"),
                    string_at(glossary, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;

        insert_string_array(
            connection,
            "glossary_active_packages",
            "config_id",
            "1",
            "package_id",
            glossary.get("activePackageIds"),
        )?;
        insert_string_array(
            connection,
            "glossary_community_packages",
            "config_id",
            "1",
            "package_id",
            glossary.get("communityPackageIds"),
        )?;
        insert_string_array(
            connection,
            "glossary_injection_order",
            "config_id",
            "1",
            "source",
            glossary.get("injectionOrder"),
        )?;
        Ok(())
    }

    pub(super) fn persist_diagnostics(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let diagnostics = config.get("diagnostics").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO diagnostic_preferences (
                  id, install_status, last_export_scope, support_tier, status, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5)",
                params![
                    string_at(diagnostics, "/installStatus"),
                    string_at(diagnostics, "/lastExportScope"),
                    string_at(diagnostics, "/supportTier"),
                    string_at(diagnostics, "/status"),
                    timestamp,
                ],
            )
            .map_err_str()?;
        Ok(())
    }

    pub(super) fn persist_onboarding(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let onboarding = config.get("onboarding").unwrap_or(&Value::Null);
        connection
            .execute(
                "INSERT INTO onboarding_state (id, active_preset_id, checklist_status, updated_at)
                 VALUES (1, ?1, ?2, ?3)",
                params![
                    string_at(onboarding, "/activePresetId"),
                    string_at(onboarding, "/checklistStatus"),
                    timestamp,
                ],
            )
            .map_err_str()?;
        insert_string_array(
            connection,
            "onboarding_completed_steps",
            "config_id",
            "1",
            "step_id",
            onboarding.get("completedStepIds"),
        )?;
        insert_string_array(
            connection,
            "onboarding_unresolved_risks",
            "config_id",
            "1",
            "risk_id",
            onboarding.get("unresolvedRiskIds"),
        )?;
        Ok(())
    }

    pub(super) fn persist_runtime_cache(
        &self,
        connection: &Connection,
        config: &Value,
        timestamp: &str,
    ) -> Result<(), String> {
        let driver = config.get("driver").unwrap_or(&Value::Null);
        let diagnostics = config.get("diagnostics").unwrap_or(&Value::Null);
        for (key, value) in [
            ("driver.driverHealth", string_at(driver, "/driverHealth")),
            ("driver.bridgeState", string_at(driver, "/bridgeState")),
            (
                "diagnostics.driverStatus",
                string_at(diagnostics, "/driverStatus"),
            ),
            (
                "diagnostics.providerStatus",
                string_at(diagnostics, "/providerStatus"),
            ),
            (
                "diagnostics.deviceStatus",
                string_at(diagnostics, "/deviceStatus"),
            ),
        ] {
            if let Some(value) = value {
                connection
                    .execute(
                        "INSERT INTO runtime_state_cache (key, value, updated_at) VALUES (?1, ?2, ?3)",
                        params![key, value, timestamp],
                    )
                    .map_err_str()?;
            }
        }
        Ok(())
    }
}
