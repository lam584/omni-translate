use super::*;

struct BudgetEnvironment {
    max_samples: u64,
    ledger_path: String,
    cell_id: String,
    lease_id: String,
    run_marker: String,
    strict_paid_authority: bool,
    incident_replay_authority: bool,
    local_single_session_authority: bool,
    declared_model_protocol_profile_identity: Option<String>,
}

fn read_authority_flag(
    read_env: &impl Fn(&str) -> Option<String>,
    name: &str,
) -> Result<bool, String> {
    match read_env(name) {
        None => Ok(false),
        Some(value) if value.trim() == "1" => Ok(true),
        Some(_) => Err(format!("{name} must be exactly 1 when present")),
    }
}

fn read_budget_environment(
    read_env: &impl Fn(&str) -> Option<String>,
) -> Result<Option<BudgetEnvironment>, String> {
    let max_samples = read_env(MAX_SAMPLES_ENV);
    let ledger_path = read_env(LEDGER_PATH_ENV);
    let cell_id = read_env(CELL_ID_ENV);
    let lease_id = read_env(LEASE_ID_ENV);
    let declared_model_protocol_profile_identity =
        read_env(MODEL_PROTOCOL_PROFILE_IDENTITY_ENV);
    let strict_paid_authority = read_authority_flag(read_env, STRICT_PAID_AUTHORITY_ENV)?;
    let incident_replay_authority =
        read_authority_flag(read_env, INCIDENT_REPLAY_AUTHORITY_ENV)?;
    let local_single_session_authority =
        read_authority_flag(read_env, LOCAL_SINGLE_SESSION_AUTHORITY_ENV)?;
    if [
        strict_paid_authority,
        incident_replay_authority,
        local_single_session_authority,
    ]
    .into_iter()
    .filter(|enabled| *enabled)
    .count()
        > 1
    {
        return Err(
            "strict paid, incident replay, and local single-session provider authorities are mutually exclusive".to_string(),
        );
    }
    if !strict_paid_authority
        && !incident_replay_authority
        && !local_single_session_authority
        && max_samples.is_none()
        && ledger_path.is_none()
        && lease_id.is_none()
    {
        return Ok(None);
    }
    let required = |name: &str, value: Option<String>| -> Result<String, String> {
        value
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .ok_or_else(|| format!("strict provider input budget requires {name}"))
    };
    let max_samples = required(MAX_SAMPLES_ENV, max_samples)?
        .parse::<u64>()
        .map_err(|error| format!("{MAX_SAMPLES_ENV} must be a positive integer: {error}"))?;
    if max_samples == 0 || max_samples > MAX_PROVIDER_INPUT_AUTHORITY_SAMPLES {
        return Err(format!(
            "{MAX_SAMPLES_ENV} must be within 1..={MAX_PROVIDER_INPUT_AUTHORITY_SAMPLES}"
        ));
    }
    let ledger_path = required(LEDGER_PATH_ENV, ledger_path)?;
    let cell_id = required(CELL_ID_ENV, cell_id)?;
    if strict_paid_authority {
        let expected_max_samples = strict_release_cell_max_samples(&cell_id)?;
        if max_samples != expected_max_samples {
            return Err(format!(
                "strict paid Provider input cell {cell_id} requires exactly {expected_max_samples} samples; got {max_samples}"
            ));
        }
    }
    let lease_id = required(LEASE_ID_ENV, lease_id)?;
    let run_marker = required(RUN_MARKER_ENV, read_env(RUN_MARKER_ENV))?;
    let autostart = required(AUTOSTART_ENV, read_env(AUTOSTART_ENV))?;
    if !matches!(autostart.as_str(), "1" | "true" | "TRUE" | "yes" | "YES") {
        return Err(format!(
            "strict provider input budget requires {AUTOSTART_ENV}=1"
        ));
    }
    Ok(Some(BudgetEnvironment {
        max_samples,
        ledger_path,
        cell_id,
        lease_id,
        run_marker,
        strict_paid_authority,
        incident_replay_authority,
        local_single_session_authority,
        declared_model_protocol_profile_identity,
    }))
}

fn resolve_model_protocol_identity(
    provider: &ProviderDraftInput,
    model: &str,
    protocol: &str,
    strict_paid_authority: bool,
    declared_identity: Option<String>,
) -> Result<ModelProtocolProfileIdentityRuntime, String> {
    let resolved_profile =
        crate::audio::events::resolve_realtime_profile(provider, &provider.model);
    let model_protocol_authority = resolved_profile
        .model_protocol_authority
        .as_ref()
        .ok_or_else(|| {
            resolved_profile.model_protocol_error.unwrap_or_else(|| {
                "model_protocol.authorization_identity_mismatch: enabled Provider input budget has no authorized model protocol profile".to_string()
            })
        })?;
    if model_protocol_authority.exact_model_id != model {
        return Err(format!(
            "model_protocol.authorization_identity_mismatch: Provider input budget model '{model}' does not match authorized exactModelId '{}'",
            model_protocol_authority.exact_model_id
        ));
    }
    if crate::audio::events::RealtimeProtocol::DashscopeLivetranslate.as_str() != protocol {
        return Err(format!(
            "model_protocol.authorization_identity_mismatch: Provider input budget protocol '{protocol}' does not match enabled LiveTranslate adapter"
        ));
    }
    let identity = ModelProtocolProfileIdentityRuntime::from(model_protocol_authority);
    if strict_paid_authority || declared_identity.is_some() {
        let declared = declared_identity
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .ok_or_else(|| {
                format!(
                    "strict provider input budget requires {MODEL_PROTOCOL_PROFILE_IDENTITY_ENV}"
                )
            })?;
        let declared: ModelProtocolProfileIdentityRuntime =
            serde_json::from_str(&declared).map_err(|error| {
                format!(
                    "model_protocol.authorization_identity_mismatch: {MODEL_PROTOCOL_PROFILE_IDENTITY_ENV} must be the exact 15-field identity: {error}"
                )
            })?;
        if declared != identity {
            return Err(
                "model_protocol.authorization_identity_mismatch: signed Watch identity does not match the Desktop-authorized Provider send boundary"
                    .to_string(),
            );
        }
    }
    Ok(identity)
}

impl ProviderInputBudget {
    pub(super) fn from_environment(
    provider: &ProviderDraftInput,
    direction: &str,
    session_generation: u64,
    model: &str,
    protocol: &str,
    read_env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let Some(environment) = read_budget_environment(&read_env)? else {
            return Ok(Self { enabled: None });
        };
        let BudgetEnvironment {
            max_samples,
            ledger_path,
            cell_id,
            lease_id,
            run_marker,
            strict_paid_authority,
            incident_replay_authority,
            local_single_session_authority,
            declared_model_protocol_profile_identity,
        } = environment;
        let required = |name: &str, value: Option<String>| -> Result<String, String> {
            value
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .ok_or_else(|| format!("strict provider input budget requires {name}"))
        };
    if direction != "inbound" {
    return Err(
    "strict provider input budget permits only the inbound Watch route".to_string(),
    );
    }
    let model = model.trim();
    if model.is_empty() {
    return Err("strict provider input budget requires an actual provider model".to_string());
    }
    let protocol = protocol.trim();
    if protocol.is_empty() {
    return Err(
    "strict provider input budget requires an actual realtime protocol".to_string(),
    );
    }
    let provider_id = provider.provider_id.trim();
    let template_id = provider.template_id.trim();
    let provider_kind = provider.kind.trim();
    let credential_reference = provider.auth_ref.reference.trim();
    let auth_header_name = provider.auth_ref.header_name.trim();
    let auth_scheme = provider.auth_ref.scheme.trim();
    let custom_header_count = provider.custom_headers.len();
    let endpoint = Url::parse(provider.base_url.trim()).map_err(|_| {
    "strict provider input budget requires a valid provider baseUrl".to_string()
    })?;
    let endpoint_host = endpoint
    .host_str()
    .map(str::to_ascii_lowercase)
    .ok_or_else(|| {
    "strict provider input budget requires a provider baseUrl with a hostname"
    .to_string()
    })?;
        let model_protocol_profile_identity = resolve_model_protocol_identity(
            provider,
            model,
            protocol,
            strict_paid_authority,
            declared_model_protocol_profile_identity,
        )?;
    let incident_id = if incident_replay_authority {
    let incident_id = required(INCIDENT_ID_ENV, read_env(INCIDENT_ID_ENV))?;
    if incident_id != INCIDENT_PLUS_ID {
    return Err(format!(
    "incident replay provider authority requires {INCIDENT_ID_ENV}={INCIDENT_PLUS_ID}"
    ));
    }
    Some(incident_id)
    } else {
    None
    };
    if local_single_session_authority {
    if session_generation == 0 {
    return Err(
    "local single-session provider authority requires a non-zero session generation"
    .to_string(),
    );
    }
    required(PCM_PATH_ENV, read_env(PCM_PATH_ENV))?;
    let expected_model = required(MODEL_ENV, read_env(MODEL_ENV))?;
    let expected_protocol = required(PROTOCOL_ENV, read_env(PROTOCOL_ENV))?;
    if !matches!(
    (expected_model.as_str(), expected_protocol.as_str()),
    (STRICT_OMNI_MODEL, STRICT_OMNI_PROTOCOL)
    | (STRICT_LIVETRANSLATE_MODEL, STRICT_LIVETRANSLATE_PROTOCOL)
    | (INCIDENT_PLUS_MODEL, INCIDENT_PLUS_PROTOCOL)
    ) {
    return Err(format!(
    "local single-session provider authority rejected model/protocol pair {expected_model}/{expected_protocol}"
    ));
    }
    if model != expected_model || protocol != expected_protocol {
    return Err(format!(
    "local single-session provider authority runtime pair mismatch: expected={expected_model}/{expected_protocol} actual={model}/{protocol}"
    ));
    }
    if provider_id != STRICT_PROVIDER_ID
    || template_id != STRICT_TEMPLATE_ID
    || provider_kind != STRICT_PROVIDER_KIND
    || endpoint_host != STRICT_ENDPOINT_HOST
    || provider.auth_ref.kind != "credential-ref"
    || credential_reference != STRICT_CREDENTIAL_REFERENCE
    || auth_header_name != "Authorization"
    || auth_scheme != "bearer"
    || custom_header_count != 0
    || provider.transport != "websocket"
    || !matches!(endpoint.scheme(), "https" | "wss")
    || !endpoint.username().is_empty()
    || endpoint.password().is_some()
    || endpoint.port().is_some()
    {
    return Err(
    "local single-session provider authority requires the canonical DashScope TLS websocket provider and credential reference".to_string(),
    );
    }
    }
    if strict_paid_authority || incident_replay_authority {
    if session_generation == 0 {
    return Err(
    "strict paid provider authority requires a non-zero session generation"
    .to_string(),
    );
    }
    required(PCM_PATH_ENV, read_env(PCM_PATH_ENV))?;
    let expected_model = required(MODEL_ENV, read_env(MODEL_ENV))?;
    let expected_protocol = required(PROTOCOL_ENV, read_env(PROTOCOL_ENV))?;
    let expected_provider_id =
    required(EXPECTED_PROVIDER_ID_ENV, read_env(EXPECTED_PROVIDER_ID_ENV))?;
    let expected_template_id = required(
    EXPECTED_TEMPLATE_ID_ENV,
    read_env(EXPECTED_TEMPLATE_ID_ENV),
    )?;
    let expected_provider_kind = required(
    EXPECTED_PROVIDER_KIND_ENV,
    read_env(EXPECTED_PROVIDER_KIND_ENV),
    )?;
    let expected_endpoint_host = required(
    EXPECTED_ENDPOINT_HOST_ENV,
    read_env(EXPECTED_ENDPOINT_HOST_ENV),
    )?
    .to_ascii_lowercase();
    let expected_credential_reference = required(
    EXPECTED_CREDENTIAL_REFERENCE_ENV,
    read_env(EXPECTED_CREDENTIAL_REFERENCE_ENV),
    )?;
    let approved_pair = if strict_paid_authority {
    matches!(
    (expected_model.as_str(), expected_protocol.as_str()),
    (STRICT_LIVETRANSLATE_MODEL, STRICT_LIVETRANSLATE_PROTOCOL)
    )
    } else {
    matches!(
    (expected_model.as_str(), expected_protocol.as_str()),
    (INCIDENT_PLUS_MODEL, INCIDENT_PLUS_PROTOCOL)
    )
    };
    if !approved_pair {
    return Err(format!(
    "provider authority rejected model/protocol pair {expected_model}/{expected_protocol}"
    ));
    }
    for (label, actual, expected, fixed) in [
    ("providerId", provider_id, expected_provider_id.as_str(), STRICT_PROVIDER_ID),
    ("templateId", template_id, expected_template_id.as_str(), STRICT_TEMPLATE_ID),
    ("providerKind", provider_kind, expected_provider_kind.as_str(), STRICT_PROVIDER_KIND),
    (
    "endpointHost",
    endpoint_host.as_str(),
    expected_endpoint_host.as_str(),
    STRICT_ENDPOINT_HOST,
    ),
    (
    "credentialReference",
    credential_reference,
    expected_credential_reference.as_str(),
    STRICT_CREDENTIAL_REFERENCE,
    ),
    ] {
    if expected != fixed {
    return Err(format!(
    "strict paid provider authority {label} expectation must be {fixed}; got {expected}"
    ));
    }
    if actual != expected {
    return Err(format!(
    "strict paid provider authority {label} mismatch: expected={expected} actual={actual}"
    ));
    }
    }
    if model != expected_model {
    return Err(format!(
    "strict paid provider authority model mismatch: expected={expected_model} actual={model}"
    ));
    }
    if protocol != expected_protocol {
    return Err(format!(
    "strict paid provider authority protocol mismatch: expected={expected_protocol} actual={protocol}"
    ));
    }
    if provider.auth_ref.kind != "credential-ref"
    || !credential_reference.starts_with("credential://")
    || provider.auth_ref.header_name != "Authorization"
    || provider.auth_ref.scheme != "bearer"
    || !provider.custom_headers.is_empty()
    || provider.transport != "websocket"
    || !matches!(endpoint.scheme(), "https" | "wss")
    || !endpoint.username().is_empty()
    || endpoint.password().is_some()
    || endpoint.port().is_some()
    {
    return Err(
    "strict paid provider authority requires a canonical TLS websocket endpoint, credential-ref bearer authentication, and no custom headers".to_string(),
    );
    }
    }
    let final_ledger = OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(Path::new(&ledger_path))
    .map_err(|error| {
    format!(
    "strict provider input budget ledger must be a new exclusive file: {error}"
    )
    })?;
    let journal_path = format!("{ledger_path}.journal.jsonl");
    let journal = OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(Path::new(&journal_path))
    .map_err(|error| {
    format!(
    "strict provider input budget journal must be a new exclusive file: {error}"
    )
    })?;
    let budget = Self {
    enabled: Some(EnabledProviderInputBudget {
    final_ledger: Mutex::new(final_ledger),
    journal: Mutex::new(journal),
    cell_id,
    lease_id,
    run_marker,
    session_generation,
    strict_paid_authority,
    incident_replay_authority,
    local_single_session_authority,
    incident_id,
    provider_id: provider_id.to_string(),
    template_id: template_id.to_string(),
    provider_kind: provider_kind.to_string(),
    endpoint_host,
    credential_reference: credential_reference.to_string(),
    auth_header_name: auth_header_name.to_string(),
    auth_scheme: auth_scheme.to_string(),
    custom_header_count,
    model: model.to_string(),
    protocol: protocol.to_string(),
    model_protocol_profile_identity,
    max_samples,
    total_attempted_samples: AtomicU64::new(0),
    append_attempts: AtomicU64::new(0),
    send_failures: AtomicU64::new(0),
    initial_connect_attempts: AtomicU64::new(0),
    reconnect_count: AtomicU64::new(0),
    sequence: AtomicU64::new(0),
    budget_exceeded: AtomicBool::new(false),
    finalized: AtomicBool::new(false),
    terminal_reason: Mutex::new(None),
    }),
    };
    budget.write_event("initialized", None, false)?;
    Ok(budget)
    }
}
