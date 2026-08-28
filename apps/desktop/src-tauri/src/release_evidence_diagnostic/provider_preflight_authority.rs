use std::collections::{BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::audio::events::resolve_realtime_profile;
use crate::provider::contracts::ProviderDraftInput;

const GRANT_PATH_ENV: &str = "OMNI_RELEASE_EVIDENCE_PREFLIGHT_GRANT_PATH";
const RESERVATION_DIRECTORY_ENV: &str =
    "OMNI_RELEASE_EVIDENCE_PREFLIGHT_RESERVATION_DIRECTORY";
const AUTHORIZATION_DIGEST_ENV: &str =
    "OMNI_RELEASE_EVIDENCE_PREFLIGHT_AUTHORIZATION_DIGEST";
const COMPILED_COORDINATOR_KEY_ID: Option<&str> =
    option_env!("OMNI_PROVIDER_PREFLIGHT_COORDINATOR_KEY_ID");
const GRANT_FILE: &str = "provider-preflight-grant.json";
const AUTHORIZATION_ROOT_SUFFIX: &str = ".preflight-authorization";
const AUTHORIZATION_PARENT_RELATIVE_PATH: [&str; 3] =
    ["artifacts", "testing", "watch-mode-live-coordinator"];
const RESERVATION_DIRECTORY: &str = "provider-preflight-lease-reservations";
const CONSUMPTION_CLAIM_FILE: &str = "provider-preflight-consumption-claim.json";
const RESERVATION_KIND: &str = "watch-mode-provider-preflight-lease-reservation";
const GRANT_KIND: &str = "watch-mode-provider-preflight-grant";
const SIGNED_AUTHORITY_SCHEMA_VERSION: u64 = 2;
const CONSUMPTION_KIND: &str = "watch-mode-provider-preflight-authorization-consumption";
const CONSUMPTION_CLAIM_KIND: &str =
    "watch-mode-provider-preflight-consumption-claim";
const AUTHORIZATION_SET_KIND: &str = "watch-mode-provider-preflight-authorization-set";
const INCIDENT_GRANT_FILE: &str = "incident-plus-preflight-grant.json";
const INCIDENT_AUTHORIZATION_DIRECTORY: &str = "preflight-authorization";
const INCIDENT_AUTHORIZATION_PARENT_RELATIVE_PATH: [&str; 3] =
    ["artifacts", "testing", "watch-mode-incident-plus"];
const INCIDENT_RESERVATION_DIRECTORY: &str = "incident-plus-preflight-lease-reservations";
const INCIDENT_CONSUMPTION_CLAIM_FILE: &str =
    "incident-plus-preflight-consumption-claim.json";
const INCIDENT_RESERVATION_KIND: &str =
    "watch-mode-incident-plus-preflight-lease-reservation";
const INCIDENT_GRANT_KIND: &str = "watch-mode-incident-plus-preflight-grant";
const INCIDENT_CONSUMPTION_KIND: &str =
    "watch-mode-incident-plus-preflight-authorization-consumption";
const INCIDENT_CONSUMPTION_CLAIM_KIND: &str =
    "watch-mode-incident-plus-preflight-consumption-claim";
const INCIDENT_AUTHORIZATION_SET_KIND: &str =
    "watch-mode-incident-plus-preflight-authorization-set";
const INCIDENT_ID: &str = "watch-mode-loss-incident-plus-v1";
pub(super) const PROVIDER_ID: &str = "provider-dashscope";
const PROVIDER_TEMPLATE_ID: &str = "template-dashscope-realtime";
const PROVIDER_KIND: &str = "dashscope";
const PROVIDER_ENDPOINT_HOST: &str = "dashscope.aliyuncs.com";
const PROVIDER_CREDENTIAL_REFERENCE: &str = "credential://provider/dashscope/default";
const PREFLIGHT_MODEL: &str = "qwen3.5-omni-flash-realtime";
const PREFLIGHT_PROTOCOL: &str = "dashscope-omni";
const INCIDENT_PREFLIGHT_MODEL: &str = "qwen3.5-omni-plus-realtime";
const INCIDENT_PREFLIGHT_PROTOCOL: &str = "dashscope-omni";
const CELL_MAX_SAMPLES: u64 = 2_880_000;
const MATRIX_MAX_SAMPLES: u64 = 23_040_000;
const INCIDENT_MATRIX_MAX_SAMPLES: u64 = 8_640_000;
const PREFLIGHT_MAX_INPUT_TOKENS: u64 = 4_096;
const PREFLIGHT_MAX_OUTPUT_TOKENS: u64 = 256;

const CELL_MODELS: [&str; 8] = [
    "qwen3.5-omni-flash-realtime",
    "qwen3.5-omni-flash-realtime",
    "qwen3.5-omni-flash-realtime",
    "qwen3.5-livetranslate-flash-realtime",
    "qwen3.5-livetranslate-flash-realtime",
    "qwen3.5-livetranslate-flash-realtime",
    "qwen3.5-omni-flash-realtime",
    "qwen3.5-livetranslate-flash-realtime",
];
const CELL_FEEDBACK_MODES: [&str; 8] = [
    "process-exclusion",
    "virtual-driver",
    "echo-cancel",
    "process-exclusion",
    "virtual-driver",
    "echo-cancel",
    "process-exclusion",
    "process-exclusion",
];
const CELL_DEVICE_CLASSES: [&str; 8] = [
    "default-speaker",
    "default-speaker",
    "default-speaker",
    "default-speaker",
    "default-speaker",
    "default-speaker",
    "default-speaker",
    "default-speaker",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreflightAuthorityProfile {
    StrictReleaseMatrix,
    IncidentPlusReplay,
}

impl PreflightAuthorityProfile {
    fn from_grant(grant: &Value) -> Result<Self, String> {
        match grant.pointer("/artifactKind").and_then(Value::as_str) {
            Some(GRANT_KIND) => Ok(Self::StrictReleaseMatrix),
            Some(INCIDENT_GRANT_KIND) => Ok(Self::IncidentPlusReplay),
            _ => Err("provider preflight grant has an unsupported authority kind".to_string()),
        }
    }

    fn grant_file(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => GRANT_FILE,
            Self::IncidentPlusReplay => INCIDENT_GRANT_FILE,
        }
    }

    fn reservation_directory(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => RESERVATION_DIRECTORY,
            Self::IncidentPlusReplay => INCIDENT_RESERVATION_DIRECTORY,
        }
    }

    fn consumption_claim_file(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => CONSUMPTION_CLAIM_FILE,
            Self::IncidentPlusReplay => INCIDENT_CONSUMPTION_CLAIM_FILE,
        }
    }

    fn reservation_kind(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => RESERVATION_KIND,
            Self::IncidentPlusReplay => INCIDENT_RESERVATION_KIND,
        }
    }

    fn consumption_kind(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => CONSUMPTION_KIND,
            Self::IncidentPlusReplay => INCIDENT_CONSUMPTION_KIND,
        }
    }

    fn consumption_claim_kind(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => CONSUMPTION_CLAIM_KIND,
            Self::IncidentPlusReplay => INCIDENT_CONSUMPTION_CLAIM_KIND,
        }
    }

    fn authorization_set_kind(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => AUTHORIZATION_SET_KIND,
            Self::IncidentPlusReplay => INCIDENT_AUTHORIZATION_SET_KIND,
        }
    }

    fn preflight_model(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => PREFLIGHT_MODEL,
            Self::IncidentPlusReplay => INCIDENT_PREFLIGHT_MODEL,
        }
    }

    fn preflight_protocol(self) -> &'static str {
        match self {
            Self::StrictReleaseMatrix => PREFLIGHT_PROTOCOL,
            Self::IncidentPlusReplay => INCIDENT_PREFLIGHT_PROTOCOL,
        }
    }

    fn cell_count(self) -> usize {
        match self {
            Self::StrictReleaseMatrix => 8,
            Self::IncidentPlusReplay => 3,
        }
    }

    fn matrix_max_samples(self) -> u64 {
        match self {
            Self::StrictReleaseMatrix => MATRIX_MAX_SAMPLES,
            Self::IncidentPlusReplay => INCIDENT_MATRIX_MAX_SAMPLES,
        }
    }
}

pub(super) struct ProviderPreflightAuthorization {
    pub(super) authority: Value,
    pub(super) model: String,
    pub(super) protocol: String,
    authorization_root: PathBuf,
    grant: Value,
    authorization_digest: String,
    expires_at: DateTime<Utc>,
    profile: PreflightAuthorityProfile,
}

impl ProviderPreflightAuthorization {
    pub(super) fn load_required(source_head_commit: &str) -> Result<Self, String> {
        let values = [
            env_value(GRANT_PATH_ENV),
            env_value(RESERVATION_DIRECTORY_ENV),
            env_value(AUTHORIZATION_DIGEST_ENV),
        ];
        if values.iter().any(Option::is_none) {
            return Err(
                "provider preflight authorization requires grant, reservation directory, and digest before provider connect"
                    .to_string(),
            );
        }
        let grant_path = PathBuf::from(values[0].as_deref().unwrap_or_default());
        let reservation_directory = PathBuf::from(values[1].as_deref().unwrap_or_default());
        let expected_authorization_digest = values[2].as_deref().unwrap_or_default();
        if !grant_path.is_absolute() || !reservation_directory.is_absolute() {
            return Err("provider preflight authority paths must be absolute and canonical-named".to_string());
        }

        let grant = read_regular_json(&grant_path, "provider preflight grant")?;
        let profile = PreflightAuthorityProfile::from_grant(&grant)?;
        if grant_path.file_name().and_then(|value| value.to_str()) != Some(profile.grant_file()) {
            return Err("provider preflight authority paths must use the canonical grant filename".to_string());
        }
        verify_signed_authority(&grant, None, "provider preflight grant")?;
        validate_grant(&grant, source_head_commit, profile)?;
        let authorization_root = validate_authorization_paths(
            &grant_path,
            &reservation_directory,
            &grant,
            profile,
        )?;
        let public_key = required_str(&grant, "/coordinator/publicKeyPem", "grant public key")?;

        let directory_metadata = fs::symlink_metadata(&reservation_directory).map_err(|error| {
            format!(
                "provider preflight reservation directory is unavailable {}: {error}",
                reservation_directory.display()
            )
        })?;
        if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
            return Err("provider preflight reservation directory must be a real directory".to_string());
        }
        let cells = required_array(&grant, "/cells", "grant cells")?;
        let expected_files = cells
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                Ok(format!(
                    "{:02}-{}.json",
                    index + 1,
                    safe_cell_id(required_str(cell, "/cellId", "grant cellId")?)
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let actual_files = fs::read_dir(&reservation_directory)
            .map_err(|error| error.to_string())?
            .map(|entry| {
                let entry = entry.map_err(|error| error.to_string())?;
                let metadata = entry
                    .file_type()
                    .map_err(|error| error.to_string())?;
                if !metadata.is_file() || metadata.is_symlink() {
                    return Err("provider preflight reservation directory contains a non-file".to_string());
                }
                entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "provider preflight reservation filename is not UTF-8".to_string())
            })
            .collect::<Result<BTreeSet<_>, String>>()?;
        if actual_files != expected_files.iter().cloned().collect() {
            return Err(format!(
                "provider preflight reservation directory is not the exact {}-file set",
                profile.cell_count()
            ));
        }

        let grant_generated_at = parse_time(
            required_str(&grant, "/generatedAt", "grant generatedAt")?,
            "grant generatedAt",
        )?;
        let grant_expires_at = parse_time(
            required_str(&grant, "/expiresAt", "grant expiresAt")?,
            "grant expiresAt",
        )?;
        let observed_at = Utc::now();
        if observed_at <= grant_generated_at || observed_at >= grant_expires_at {
            return Err("provider preflight grant is outside its authorized time window".to_string());
        }

        let mut reservations = Vec::with_capacity(profile.cell_count());
        let mut reservation_digests = Vec::with_capacity(profile.cell_count());
        let mut reservation_issued_at = Vec::with_capacity(profile.cell_count());
        for (index, file_name) in expected_files.iter().enumerate() {
            let reservation = read_regular_json(
                &reservation_directory.join(file_name),
                &format!("provider preflight reservation {index}"),
            )?;
            verify_signed_authority(
                &reservation,
                Some(public_key),
                &format!("provider preflight reservation {index}"),
            )?;
            validate_reservation(
                &reservation,
                &grant,
                index,
                grant_generated_at,
                grant_expires_at,
                profile,
            )?;
            let issued_at = required_str(&reservation, "/issuedAt", "reservation issuedAt")?;
            if parse_time(issued_at, "reservation issuedAt")? >= observed_at {
                return Err(format!(
                    "provider preflight reservation {index} was not issued before authorization observation"
                ));
            }
            reservation_issued_at.push(Value::String(issued_at.to_string()));
            let digest = required_str(&reservation, "/digest", "reservation digest")?;
            reservation_digests.push(Value::String(digest.to_string()));
            reservations.push(json!({
                "cellIndex": index,
                "cellId": required_str(&reservation, "/cellId", "reservation cellId")?,
                "workerId": required_str(&reservation, "/workerId", "reservation workerId")?,
                "waveIndex": required_u64(&reservation, "/waveIndex", "reservation waveIndex")?,
                "leaseId": required_str(&reservation, "/leaseId", "reservation leaseId")?,
                "maxExternalAudioSamples": CELL_MAX_SAMPLES,
                "digest": digest,
                "issuedAt": issued_at,
            }));
        }

        let authorization_digest = sha256_canonical(&json!({
            "schemaVersion": SIGNED_AUTHORITY_SCHEMA_VERSION,
            "artifactKind": profile.authorization_set_kind(),
            "executionId": required_str(&grant, "/executionId", "grant executionId")?,
            "grantDigest": required_str(&grant, "/digest", "grant digest")?,
            "leaseReservationDigests": reservation_digests,
        }))?;
        if !is_sha256(expected_authorization_digest)
            || authorization_digest != expected_authorization_digest
        {
            return Err("provider preflight authorization digest mismatch".to_string());
        }
        let mut authority = json!({
            "schemaVersion": SIGNED_AUTHORITY_SCHEMA_VERSION,
            "artifactKind": profile.consumption_kind(),
            "executionId": required_str(&grant, "/executionId", "grant executionId")?,
            "grantDigest": required_str(&grant, "/digest", "grant digest")?,
            "leaseReservationDigests": reservation_digests,
            "authorizationDigest": authorization_digest,
            "providerId": PROVIDER_ID,
            "model": profile.preflight_model(),
            "protocol": profile.preflight_protocol(),
            "operation": "text-translation-preflight",
            "inputMode": "text-only",
            "invocationCount": 1,
            "externalAudioSamples": 0,
            "tokenBudget": {
                "maxInputTokens": PREFLIGHT_MAX_INPUT_TOKENS,
                "maxOutputTokens": PREFLIGHT_MAX_OUTPUT_TOKENS,
            },
            "leaseReservations": reservations,
            "grantGeneratedAt": required_str(&grant, "/generatedAt", "grant generatedAt")?,
            "reservationIssuedAts": reservation_issued_at,
            "authorizationObservedAt": observed_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .as_object()
        .cloned()
        .ok_or_else(|| "provider preflight authority cannot be represented as an object".to_string())?;
        if profile == PreflightAuthorityProfile::IncidentPlusReplay {
            authority.insert("incidentId".to_string(), Value::String(INCIDENT_ID.to_string()));
        }
        let authority = Value::Object(authority);
        Ok(Self {
            authority,
            model: profile.preflight_model().to_string(),
            protocol: profile.preflight_protocol().to_string(),
            authorization_root,
            grant,
            authorization_digest,
            expires_at: grant_expires_at,
            profile,
        })
    }

    pub(super) fn claim_before_connect(&mut self) -> Result<(), String> {
        if self.authority.get("consumptionClaim").is_some() {
            return Err("provider preflight authorization is already claimed in this process".to_string());
        }
        let observed_at = parse_time(
            required_str(
                &self.authority,
                "/authorizationObservedAt",
                "authorization observedAt",
            )?,
            "authorization observedAt",
        )?;
        let claimed_at = Utc::now();
        if claimed_at <= observed_at {
            return Err("provider preflight consumption claim timestamp did not follow authorization observation".to_string());
        }
        if claimed_at >= self.expires_at {
            return Err(
                "provider preflight authorization expired before the one-shot network claim"
                    .to_string(),
            );
        }
        let claim = create_consumption_claim(
            &self.authorization_root,
            &self.grant,
            &self.authorization_digest,
            claimed_at,
            self.profile,
        )?;
        self.authority
            .as_object_mut()
            .ok_or_else(|| "provider preflight authority must be an object".to_string())?
            .insert("consumptionClaim".to_string(), claim);
        Ok(())
    }

    pub(super) fn apply_to_provider(
        &self,
        provider: &mut ProviderDraftInput,
    ) -> Result<String, String> {
        let configured_model = provider.model.clone();
        if provider.provider_id != PROVIDER_ID
            || provider.template_id != PROVIDER_TEMPLATE_ID
            || provider.kind != PROVIDER_KIND
            || provider.transport != "websocket"
            || !provider.stream_enabled
            || provider.auth_ref.kind != "credential-ref"
            || provider.auth_ref.reference != PROVIDER_CREDENTIAL_REFERENCE
            || provider.auth_ref.header_name != "Authorization"
            || provider.auth_ref.scheme != "bearer"
            || !provider.custom_headers.is_empty()
            || provider.system_prompt_template != "game-live-translation-cn"
            || provider.response_modalities != ["text"]
            || provider.timeout_ms != 12_000
            || provider.temperature != 0.2
            || provider.max_output_tokens != PREFLIGHT_MAX_OUTPUT_TOKENS
        {
            return Err("authorized provider preflight requires the fixed streaming DashScope WebSocket provider identity, auth, prompt, modality, and timeout".to_string());
        }
        let endpoint = url::Url::parse(&provider.base_url)
            .map_err(|_| "authorized provider baseUrl is not a valid URL".to_string())?;
        let endpoint_host = endpoint
            .host_str()
            .ok_or_else(|| "authorized provider baseUrl has no endpoint host".to_string())?;
        if endpoint.scheme() != "https"
            || endpoint_host != PROVIDER_ENDPOINT_HOST
            || endpoint.port().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err(format!(
                "authorized provider endpoint must be canonical TLS origin https://{PROVIDER_ENDPOINT_HOST} with no explicit port or userinfo"
            ));
        }
        provider.model.clone_from(&self.model);
        provider.template_realtime_protocol = Some(self.protocol.clone());
        provider.realtime_protocol = Some(self.protocol.clone());
        let resolved = resolve_realtime_profile(provider, &provider.model)
            .protocol_dialect
            .map(|value| value.as_str());
        if resolved != Some(self.protocol.as_str()) {
            return Err("authorized provider model did not resolve to the signed protocol".to_string());
        }
        Ok(configured_model)
    }
}

fn validate_authorization_paths(
    grant_path: &Path,
    reservation_directory: &Path,
    grant: &Value,
    profile: PreflightAuthorityProfile,
) -> Result<PathBuf, String> {
    let executable = current_desktop_executable_path()?;
    if executable.file_name().and_then(|value| value.to_str())
        != Some("omni-desktop-shell.exe")
        || executable
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            != Some("release")
        || executable
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            != Some("target")
    {
        return Err(
            "provider preflight must execute the canonical target/release/omni-desktop-shell.exe"
                .to_string(),
        );
    }
    let repo_root = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| {
            "provider preflight Desktop executable is not under target/release".to_string()
        })?;
    let execution_id = required_str(grant, "/executionId", "grant executionId")?;
    let expected_root = match profile {
        PreflightAuthorityProfile::StrictReleaseMatrix => AUTHORIZATION_PARENT_RELATIVE_PATH
            .iter()
            .fold(repo_root.to_path_buf(), |root, segment| root.join(segment))
            .join(format!("{execution_id}{AUTHORIZATION_ROOT_SUFFIX}")),
        PreflightAuthorityProfile::IncidentPlusReplay => INCIDENT_AUTHORIZATION_PARENT_RELATIVE_PATH
            .iter()
            .fold(repo_root.to_path_buf(), |root, segment| root.join(segment))
            .join(execution_id)
            .join(INCIDENT_AUTHORIZATION_DIRECTORY),
    };
    reject_reparse_points(repo_root, &expected_root)?;
    let expected_root = fs::canonicalize(&expected_root).map_err(|error| {
        format!(
            "canonical provider preflight authorization root is unavailable {}: {error}",
            expected_root.display()
        )
    })?;
    let actual_root = grant_path
        .parent()
        .ok_or_else(|| "provider preflight grant has no authorization root".to_string())?;
    let actual_root = fs::canonicalize(actual_root).map_err(|error| {
        format!("provider preflight authorization root is unavailable: {error}")
    })?;
    let actual_reservations = fs::canonicalize(reservation_directory).map_err(|error| {
        format!("provider preflight reservation directory is unavailable: {error}")
    })?;
    reject_reparse_points(repo_root, reservation_directory)?;
    let expected_reservations = fs::canonicalize(actual_root.join(profile.reservation_directory()))
        .map_err(|error| {
            format!("canonical provider preflight reservation directory is unavailable: {error}")
        })?;
    if actual_root != expected_root || actual_reservations != expected_reservations {
        return Err(
            "provider preflight authorization must use the canonical repository execution root"
                .to_string(),
        );
    }
    Ok(actual_root)
}

fn reject_reparse_points(repo_root: &Path, target: &Path) -> Result<(), String> {
    let relative = target.strip_prefix(repo_root).map_err(|_| {
        "provider preflight authorization path escapes the repository".to_string()
    })?;
    let mut current = repo_root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            format!(
                "provider preflight authorization path is unavailable {}: {error}",
                current.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "provider preflight authorization path contains a symlink {}",
                current.display()
            ));
        }
        #[cfg(windows)]
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "provider preflight authorization path contains a Windows reparse point {}",
                current.display()
            ));
        }
    }
    Ok(())
}

fn create_consumption_claim(
    authorization_root: &Path,
    grant: &Value,
    authorization_digest: &str,
    claimed_at: DateTime<Utc>,
    profile: PreflightAuthorityProfile,
) -> Result<Value, String> {
    let executable = current_desktop_executable_path()?;
    let executable_bytes = fs::read(&executable)
        .map_err(|error| format!("provider preflight Desktop executable cannot be read: {error}"))?;
    let mut claim = json!({
        "schemaVersion": SIGNED_AUTHORITY_SCHEMA_VERSION,
        "artifactKind": profile.consumption_claim_kind(),
        "executionId": required_str(grant, "/executionId", "grant executionId")?,
        "grantDigest": required_str(grant, "/digest", "grant digest")?,
        "authorizationDigest": authorization_digest,
        "coordinatorKeyId": required_str(grant, "/signature/keyId", "grant coordinator keyId")?,
        "claimedAt": claimed_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "desktopProcessId": std::process::id(),
        "desktopExecutablePath": executable.to_string_lossy(),
        "desktopExecutableRelativePath": "target/release/omni-desktop-shell.exe",
        "desktopExecutableBytes": executable_bytes.len(),
        "desktopExecutableSha256": sha256_bytes(&executable_bytes),
        "retryPolicy": "new-execution-required",
    })
    .as_object()
    .cloned()
    .ok_or_else(|| "provider preflight consumption claim cannot be represented as an object".to_string())?;
    if profile == PreflightAuthorityProfile::IncidentPlusReplay {
        claim.insert("incidentId".to_string(), Value::String(INCIDENT_ID.to_string()));
    }
    let claim = Value::Object(claim);
    let mut bytes = serde_json::to_vec_pretty(&claim)
        .map_err(|error| format!("provider preflight consumption claim cannot serialize: {error}"))?;
    bytes.push(b'\n');
    let claim_path = authorization_root.join(profile.consumption_claim_file());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    options.custom_flags(0x8000_0000);
    let mut file = options.open(&claim_path).map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            "provider preflight authorization was already consumed; create a new execution"
                .to_string()
        } else {
            format!(
                "provider preflight consumption claim cannot be created {}: {error}",
                claim_path.display()
            )
        }
    })?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            format!(
                "provider preflight consumption claim cannot be durably written {}: {error}",
                claim_path.display()
            )
        })?;
    let mut projected = claim
        .as_object()
        .cloned()
        .ok_or_else(|| "provider preflight consumption claim must be an object".to_string())?;
    projected.insert(
        "path".to_string(),
        Value::String(profile.consumption_claim_file().to_string()),
    );
    projected.insert("bytes".to_string(), json!(bytes.len()));
    projected.insert("sha256".to_string(), Value::String(sha256_bytes(&bytes)));
    Ok(Value::Object(projected))
}

/// Returns one canonical executable identity without Windows' verbatim `\\?\`
/// spelling. Rust's `canonicalize` adds that prefix on Windows while Node's
/// `path.resolve` and the release emitter use the ordinary drive-rooted form;
/// all three authorities must bind the same bytes *and* the same path string.
pub(super) fn current_desktop_executable_path() -> Result<PathBuf, String> {
    let executable = fs::canonicalize(
        std::env::current_exe().map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("provider preflight Desktop executable is unavailable: {error}"))?;
    portable_executable_path(executable)
}

fn portable_executable_path(executable: PathBuf) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let value = executable.into_os_string().into_string().map_err(|_| {
            "provider preflight Desktop executable path is not valid Unicode".to_string()
        })?;
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(drive_rooted) = value.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(drive_rooted));
        }
        Ok(PathBuf::from(value))
    }
    #[cfg(not(windows))]
    {
        Ok(executable)
    }
}

fn validate_grant(
    grant: &Value,
    source_head_commit: &str,
    profile: PreflightAuthorityProfile,
) -> Result<(), String> {
    if required_u64(grant, "/schemaVersion", "grant schemaVersion")?
        != SIGNED_AUTHORITY_SCHEMA_VERSION
        || required_str(grant, "/artifactKind", "grant artifactKind")?
            != match profile {
                PreflightAuthorityProfile::StrictReleaseMatrix => GRANT_KIND,
                PreflightAuthorityProfile::IncidentPlusReplay => INCIDENT_GRANT_KIND,
            }
    {
        return Err("provider preflight grant schema is unsupported".to_string());
    }
    if required_str(grant, "/provenance/source", "grant provenance source")? != "git"
        || required_str(grant, "/provenance/captureStatus", "grant capture status")? != "captured"
        || grant
            .get("provenance")
            .and_then(|value| value.get("worktreeClean"))
            .and_then(Value::as_bool)
            != Some(true)
        || required_u64(grant, "/provenance/dirtyEntryCount", "grant dirty count")? != 0
        || required_str(grant, "/provenance/headCommit", "grant head")? != source_head_commit
    {
        return Err("provider preflight grant provenance does not match the exact clean Desktop build".to_string());
    }
    let workers = required_array(grant, "/workers", "grant workers")?;
    let expected_worker_count = match profile {
        PreflightAuthorityProfile::StrictReleaseMatrix => 1,
        PreflightAuthorityProfile::IncidentPlusReplay => 2,
    };
    if workers.len() != expected_worker_count
        || required_u64(grant, "/localIsolationAuthority/providerCalls", "local provider calls")? != 0
        || required_u64(grant, "/budget/inputSampleRateHz", "budget sample rate")? != 16_000
        || required_u64(grant, "/budget/cellMaxExternalAudioSamples", "cell budget")? != CELL_MAX_SAMPLES
        || required_u64(grant, "/budget/matrixMaxExternalAudioSamples", "matrix budget")?
            != profile.matrix_max_samples()
        || required_str(grant, "/budget/reclaimPolicy", "budget reclaim policy")? != "never-within-execution"
        || required_str(grant, "/budget/retryPolicy", "budget retry policy")? != "new-execution-required"
    {
        return Err("provider preflight grant worker/local/budget authority is invalid".to_string());
    }
    if profile == PreflightAuthorityProfile::IncidentPlusReplay
        && required_str(grant, "/incidentId", "incident grant incidentId")? != INCIDENT_ID
    {
        return Err("incident Plus preflight grant incident binding is invalid".to_string());
    }
    for (pointer, expected) in [
        ("/authorization/providerId", PROVIDER_ID),
        ("/authorization/model", profile.preflight_model()),
        ("/authorization/protocol", profile.preflight_protocol()),
        ("/authorization/operation", "text-translation-preflight"),
        ("/authorization/inputMode", "text-only"),
        ("/authorization/systemPromptTemplate", "game-live-translation-cn"),
    ] {
        if required_str(grant, pointer, "grant authorization")? != expected {
            return Err("provider preflight grant is not the fixed text-only authorization".to_string());
        }
    }
    if required_u64(grant, "/authorization/invocationCount", "preflight invocation count")? != 1
        || required_u64(grant, "/authorization/externalAudioSamples", "preflight audio samples")? != 0
        || required_u64(grant, "/authorization/tokenBudget/maxInputTokens", "preflight input token cap")?
            != PREFLIGHT_MAX_INPUT_TOKENS
        || required_u64(grant, "/authorization/tokenBudget/maxOutputTokens", "preflight output token cap")?
            != PREFLIGHT_MAX_OUTPUT_TOKENS
        || required_u64(grant, "/authorization/timeoutMs", "preflight timeout")? != 12_000
        || grant
            .get("authorization")
            .and_then(|value| value.get("temperature"))
            .and_then(Value::as_f64)
            != Some(0.2)
        || required_array(grant, "/authorization/responseModalities", "preflight modalities")?
            != &vec![Value::String("text".to_string())]
        || !required_array(grant, "/authorization/customHeaders", "preflight custom headers")?
            .is_empty()
    {
        return Err("provider preflight grant invocation/audio authorization is invalid".to_string());
    }

    let worker_ids = workers
        .iter()
        .map(|worker| required_str(worker, "/workerId", "grant workerId").map(str::to_string))
        .collect::<Result<HashSet<_>, _>>()?;
    let cells = required_array(grant, "/cells", "grant cells")?;
    let mut lease_ids = HashSet::new();
    let mut worker_wave_slots = HashSet::new();
    if cells.len() != profile.cell_count() {
        return Err(format!(
            "provider preflight grant must contain exactly {} cells",
            profile.cell_count()
        ));
    }
    for (index, cell) in cells.iter().enumerate() {
        let (expected_id, expected_model, expected_protocol, expected_feedback, expected_device) =
            match profile {
                PreflightAuthorityProfile::StrictReleaseMatrix => {
                    let tier = if index < 6 { "pairwise-live" } else { "model-stability" };
                    (
                        format!(
                            "{tier}::{}::{}::{}",
                            CELL_MODELS[index], CELL_FEEDBACK_MODES[index], CELL_DEVICE_CLASSES[index]
                        ),
                        CELL_MODELS[index],
                        if CELL_MODELS[index].contains("livetranslate") {
                            "dashscope-livetranslate"
                        } else {
                            "dashscope-omni"
                        },
                        CELL_FEEDBACK_MODES[index],
                        CELL_DEVICE_CLASSES[index],
                    )
                }
                PreflightAuthorityProfile::IncidentPlusReplay => {
                    const MODES: [&str; 3] = ["process-exclusion", "virtual-driver", "echo-cancel"];
                    const DEVICES: [&str; 3] = ["default-speaker", "usb", "default-speaker"];
                    (
                        format!(
                            "incident-plus::{INCIDENT_PREFLIGHT_MODEL}::{}::{}",
                            MODES[index], DEVICES[index]
                        ),
                        INCIDENT_PREFLIGHT_MODEL,
                        INCIDENT_PREFLIGHT_PROTOCOL,
                        MODES[index],
                        DEVICES[index],
                    )
                }
            };
        let worker_id = required_str(cell, "/workerId", "grant cell workerId")?;
        let wave_index = required_u64(cell, "/waveIndex", "grant cell waveIndex")?;
        let lease_id = required_str(cell, "/leaseId", "grant cell leaseId")?;
        if required_u64(cell, "/cellIndex", "grant cellIndex")? != index as u64
            || required_str(cell, "/cellId", "grant cellId")? != expected_id
            || required_str(cell, "/providerId", "grant cell providerId")? != PROVIDER_ID
            || required_str(cell, "/modelId", "grant cell modelId")? != expected_model
            || required_str(cell, "/protocol", "grant cell protocol")? != expected_protocol
            || required_str(cell, "/feedbackLoopPrevention", "grant feedback mode")?
                != expected_feedback
            || required_str(cell, "/deviceClass", "grant device class")?
                != expected_device
            || required_u64(cell, "/maxExternalAudioSamples", "grant cell budget")?
                != CELL_MAX_SAMPLES
            || !worker_ids.contains(worker_id)
            || required_str(cell, "/deviceProfileInstanceId", "grant device profile")?.is_empty()
            || !lease_ids.insert(lease_id.to_string())
            || !worker_wave_slots.insert((worker_id.to_string(), wave_index))
        {
            return Err(format!("provider preflight grant cell {index} is not canonical"));
        }
    }
    let runtime = required_array(grant, "/runtimeBinaryHashes", "grant runtime inventory")?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable_bytes = fs::read(&executable).map_err(|error| error.to_string())?;
    let executable_sha = sha256_bytes(&executable_bytes);
    let desktop_entry = runtime.iter().find(|entry| {
        entry.get("path").and_then(Value::as_str) == Some("target/release/omni-desktop-shell.exe")
    });
    if desktop_entry.and_then(|entry| entry.get("sha256")).and_then(Value::as_str)
        != Some(executable_sha.as_str())
        || desktop_entry.and_then(|entry| entry.get("bytes")).and_then(Value::as_u64)
            != Some(executable_bytes.len() as u64)
    {
        return Err("provider preflight grant does not bind the executing Desktop binary".to_string());
    }
    Ok(())
}

fn validate_reservation(
    reservation: &Value,
    grant: &Value,
    index: usize,
    grant_generated_at: DateTime<Utc>,
    grant_expires_at: DateTime<Utc>,
    profile: PreflightAuthorityProfile,
) -> Result<(), String> {
    let cell = required_array(grant, "/cells", "grant cells")?
        .get(index)
        .ok_or_else(|| "provider preflight grant cell is missing".to_string())?;
    let issued_at = parse_time(
        required_str(reservation, "/issuedAt", "reservation issuedAt")?,
        "reservation issuedAt",
    )?;
    let expires_at = parse_time(
        required_str(reservation, "/expiresAt", "reservation expiresAt")?,
        "reservation expiresAt",
    )?;
    for (pointer, expected) in [
        ("/artifactKind", profile.reservation_kind()),
        (
            "/executionId",
            required_str(grant, "/executionId", "grant executionId")?,
        ),
        ("/grantDigest", required_str(grant, "/digest", "grant digest")?),
        ("/cellId", required_str(cell, "/cellId", "grant cellId")?),
        ("/workerId", required_str(cell, "/workerId", "grant cell workerId")?),
        ("/leaseId", required_str(cell, "/leaseId", "grant cell leaseId")?),
        ("/reclaimPolicy", "never-within-execution"),
        ("/retryPolicy", "new-execution-required"),
    ] {
        if required_str(reservation, pointer, "reservation binding")? != expected {
            return Err(format!("provider preflight reservation {index} does not match its grant"));
        }
    }
    if required_u64(reservation, "/schemaVersion", "reservation schemaVersion")?
        != SIGNED_AUTHORITY_SCHEMA_VERSION
        || required_u64(reservation, "/cellIndex", "reservation cellIndex")? != index as u64
        || required_u64(reservation, "/waveIndex", "reservation waveIndex")?
            != required_u64(cell, "/waveIndex", "grant waveIndex")?
        || required_u64(reservation, "/maxExternalAudioSamples", "reservation budget")?
            != CELL_MAX_SAMPLES
        || issued_at <= grant_generated_at
        || issued_at >= grant_expires_at
        || expires_at != grant_expires_at
        || required_str(reservation, "/coordinator/publicKeyPem", "reservation public key")?
            != required_str(grant, "/coordinator/publicKeyPem", "grant public key")?
    {
        return Err(format!("provider preflight reservation {index} is invalid"));
    }
    Ok(())
}

fn verify_signed_authority(
    value: &Value,
    expected_public_key: Option<&str>,
    label: &str,
) -> Result<(), String> {
    let mut signed = value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} must be an object"))?;
    let signature = signed
        .remove("signature")
        .ok_or_else(|| format!("{label} has no signature"))?;
    let digest = signed
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} has no digest"))?;
    let mut core = signed.clone();
    core.remove("digest");
    if !is_sha256(digest) || sha256_canonical(&Value::Object(core))? != digest {
        return Err(format!("{label} digest mismatch"));
    }
    let public_key = required_str(value, "/coordinator/publicKeyPem", "authority public key")?;
    if expected_public_key.is_some_and(|expected| expected != public_key) {
        return Err(format!("{label} public key differs from its grant"));
    }
    let der = decode_public_key(public_key)?;
    let expected_key_id = sha256_bytes(&der);
    let signature_key_id = required_str(&signature, "/keyId", "signature keyId")?;
    if required_str(&signature, "/algorithm", "signature algorithm")? != "Ed25519"
        || signature_key_id != expected_key_id
    {
        return Err(format!("{label} signature metadata is invalid"));
    }
    if expected_public_key.is_none() {
        let compiled_key_id = COMPILED_COORDINATOR_KEY_ID
            .map(str::trim)
            .filter(|value| is_sha256(value))
            .ok_or_else(|| {
                "release evidence Desktop binary has no compile-time provider preflight coordinator key; rebuild through the production coordinator"
                    .to_string()
            })?;
        if signature_key_id != compiled_key_id {
            return Err(format!(
                "{label} coordinator key does not match the key embedded in this Desktop build"
            ));
        }
    }
    let signature_bytes = STANDARD
        .decode(required_str(&signature, "/valueBase64", "signature value")?)
        .map_err(|_| format!("{label} signature is not valid base64"))?;
    let message = canonical_json(&Value::Object(signed))?;
    UnparsedPublicKey::new(&ED25519, &der[12..])
        .verify(message.as_bytes(), &signature_bytes)
        .map_err(|_| format!("{label} Ed25519 signature verification failed"))
}

fn decode_public_key(pem: &str) -> Result<Vec<u8>, String> {
    let encoded = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>();
    let der = STANDARD
        .decode(encoded)
        .map_err(|_| "provider preflight public key PEM is invalid".to_string())?;
    if der.len() != 44 || !der.starts_with(&[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]) {
        return Err("provider preflight public key is not an Ed25519 SPKI key".to_string());
    }
    Ok(der)
}

fn read_regular_json(path: &Path, label: &str) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} is unavailable {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!("{label} must be a non-empty regular non-symlink file"));
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{label} is invalid JSON: {error}"))
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn required_str<'a>(value: &'a Value, pointer: &str, label: &str) -> Result<&'a str, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{label} is missing or invalid"))
}

fn required_u64(value: &Value, pointer: &str, label: &str) -> Result<u64, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{label} is missing or invalid"))
}

fn required_array<'a>(
    value: &'a Value,
    pointer: &str,
    label: &str,
) -> Result<&'a Vec<Value>, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} is missing or invalid"))
}

fn parse_time(value: &str, label: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| format!("{label} is not an RFC3339 timestamp"))
}

fn safe_cell_id(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            output.push(character);
            last_was_dash = false;
        } else if !last_was_dash && !output.is_empty() {
            output.push('-');
            last_was_dash = true;
        }
    }
    output.trim_matches('-').to_string()
}

fn canonical_json(value: &Value) -> Result<String, String> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value).map_err(|error| error.to_string())
        }
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|error| error.to_string())?,
                        canonical_json(&values[key])?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

fn sha256_canonical(value: &Value) -> Result<String, String> {
    Ok(sha256_bytes(canonical_json(value)?.as_bytes()))
}

fn sha256_bytes(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::Map;
    use std::sync::{Arc, Barrier};

    fn sign_test_authority(mut core: Map<String, Value>) -> Value {
        let seed = [7_u8; 32];
        let key_pair = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        let mut der = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
        der.extend_from_slice(key_pair.public_key().as_ref());
        let public_key_pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            STANDARD.encode(&der)
        );
        core.insert(
            "coordinator".to_string(),
            json!({ "publicKeyPem": public_key_pem }),
        );
        let digest = sha256_canonical(&Value::Object(core.clone())).unwrap();
        core.insert("digest".to_string(), Value::String(digest));
        let message = canonical_json(&Value::Object(core.clone())).unwrap();
        let signature = key_pair.sign(message.as_bytes());
        core.insert(
            "signature".to_string(),
            json!({
                "algorithm": "Ed25519",
                "keyId": sha256_bytes(&der),
                "valueBase64": STANDARD.encode(signature.as_ref()),
            }),
        );
        Value::Object(core)
    }

    #[test]
    fn canonical_json_matches_node_sorted_object_grammar() {
        let value = json!({
            "z": [3, { "b": "中文", "a": true }],
            "a": null,
            "n": 1.25,
        });
        assert_eq!(
            canonical_json(&value).unwrap(),
            r#"{"a":null,"n":1.25,"z":[3,{"a":true,"b":"中文"}]}"#
        );
        assert_eq!(
            sha256_canonical(&value).unwrap(),
            "12d222cb5cfd147f798449a67d0599e7268e3abe6b177d0007b1dbd47a2902fe"
        );
    }

    #[test]
    fn reservation_filenames_match_node_safe_cell_ids() {
        assert_eq!(
            safe_cell_id(
                "pairwise-live::qwen3.5-omni-flash-realtime::process-exclusion::default-speaker"
            ),
            "pairwise-live-qwen3.5-omni-flash-realtime-process-exclusion-default-speaker"
        );
    }

    #[cfg(windows)]
    #[test]
    fn executable_identity_removes_windows_verbatim_prefixes() {
        assert_eq!(
            portable_executable_path(PathBuf::from(
                r"\\?\E:\repo\target\release\omni-desktop-shell.exe"
            ))
            .unwrap(),
            PathBuf::from(r"E:\repo\target\release\omni-desktop-shell.exe")
        );
        assert_eq!(
            portable_executable_path(PathBuf::from(
                r"\\?\UNC\server\share\target\release\omni-desktop-shell.exe"
            ))
            .unwrap(),
            PathBuf::from(r"\\server\share\target\release\omni-desktop-shell.exe")
        );
    }

    #[test]
    fn rejects_non_ed25519_spki_keys_before_any_provider_call() {
        let rsa_like = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            STANDARD.encode([0_u8; 44])
        );
        assert!(decode_public_key(&rsa_like)
            .unwrap_err()
            .contains("not an Ed25519 SPKI key"));
    }

    #[test]
    fn rejects_legacy_grant_schema_without_misclassifying_it_as_provenance() {
        assert_eq!(SIGNED_AUTHORITY_SCHEMA_VERSION, 2);
        let legacy = json!({
            "schemaVersion": 1,
            "artifactKind": GRANT_KIND,
        });
        assert_eq!(
            validate_grant(
                &legacy,
                "0123456789abcdef0123456789abcdef01234567",
                PreflightAuthorityProfile::StrictReleaseMatrix,
            )
            .unwrap_err(),
            "provider preflight grant schema is unsupported"
        );
    }

    #[test]
    fn verifies_node_compatible_ed25519_authority_and_rejects_tampering() {
        let signed = sign_test_authority(
            json!({
                "schemaVersion": 1,
                "artifactKind": GRANT_KIND,
                "executionId": "execution-test-1",
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        let public_key = required_str(&signed, "/coordinator/publicKeyPem", "test key")
            .unwrap()
            .to_string();
        verify_signed_authority(&signed, Some(&public_key), "test authority").unwrap();
        let mut tampered = signed;
        tampered["executionId"] = Value::String("execution-test-2".to_string());
        assert!(verify_signed_authority(&tampered, Some(&public_key), "test authority")
            .unwrap_err()
            .contains("digest mismatch"));
    }

    #[test]
    fn consumption_claim_is_durable_and_single_use_under_concurrency() {
        let root = tempfile::tempdir().unwrap();
        let grant = json!({
            "executionId": "execution-test-claim",
            "digest": "a".repeat(64),
            "signature": { "keyId": "b".repeat(64) },
        });
        let digest = "c".repeat(64);
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let root = root.path().to_path_buf();
                let grant = grant.clone();
                let digest = digest.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    create_consumption_claim(
                        &root,
                        &grant,
                        &digest,
                        Utc::now(),
                        PreflightAuthorityProfile::StrictReleaseMatrix,
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 7);
        let claim_path = root.path().join(CONSUMPTION_CLAIM_FILE);
        let claim: Value = serde_json::from_slice(&fs::read(claim_path).unwrap()).unwrap();
        assert_eq!(claim["authorizationDigest"], digest);
        assert_eq!(claim["retryPolicy"], "new-execution-required");
        assert!(results
            .into_iter()
            .filter_map(Result::err)
            .all(|error| error.contains("already consumed")));
    }
}
