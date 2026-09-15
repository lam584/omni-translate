#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::audio::omni) struct StrictMediaEndAuthority {
    pub(in crate::audio::omni) authoritative_reference_frames: u64,
    pub(in crate::audio::omni) input_sample_rate_hz: u32,
    pub(in crate::audio::omni) media_sha256: String,
    pub(in crate::audio::omni) run_marker: String,
    pub(in crate::audio::omni) cell_id: String,
    pub(in crate::audio::omni) lease_id: String,
    pub(in crate::audio::omni) provider_input_max_samples: u64,
    pub(in crate::audio::omni) session_generation: u64,
}

pub(super) const AUTHORITATIVE_REFERENCE_FRAMES_ENV: &str =
    "OMNI_WATCH_MODE_AUTHORITATIVE_TRANSFORMED_REFERENCE_FRAMES";
pub(super) const INPUT_SAMPLE_RATE_HZ_ENV: &str = "OMNI_WATCH_MODE_INPUT_SAMPLE_RATE_HZ";
pub(super) const AUTHORITY_RUN_MARKER_ENV: &str = "OMNI_WATCH_MODE_MEDIA_AUTHORITY_RUN_MARKER";
pub(super) const AUTHORITY_CELL_ID_ENV: &str = "OMNI_WATCH_MODE_MEDIA_AUTHORITY_CELL_ID";
pub(super) const AUTHORITY_LEASE_ID_ENV: &str = "OMNI_WATCH_MODE_MEDIA_AUTHORITY_LEASE_ID";
pub(super) const MEDIA_SHA256_ENV: &str = "OMNI_WATCH_MODE_MEDIA_SHA256";
const PROVIDER_INPUT_SAMPLE_RATE_HZ: u32 = 16_000;

impl StrictMediaEndAuthority {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn from_environment(
        read_env: &impl Fn(&str) -> Option<String>,
        strict_paid_authority: bool,
        run_marker: &str,
        cell_id: &str,
        lease_id: &str,
        provider_input_max_samples: u64,
        session_generation: u64,
    ) -> Result<Option<Self>, String> {
        if !strict_paid_authority {
            return Ok(None);
        }
        let reference_frames = read_env(AUTHORITATIVE_REFERENCE_FRAMES_ENV);
        let input_sample_rate_hz = read_env(INPUT_SAMPLE_RATE_HZ_ENV);
        let media_sha256 = read_env(MEDIA_SHA256_ENV);
        let authority_run_marker = read_env(AUTHORITY_RUN_MARKER_ENV);
        let authority_cell_id = read_env(AUTHORITY_CELL_ID_ENV);
        let authority_lease_id = read_env(AUTHORITY_LEASE_ID_ENV);
        if reference_frames.is_none() || input_sample_rate_hz.is_none() || media_sha256.is_none() {
            return Ok(None);
        }
        let required = |name: &str, value: Option<String>| -> Result<String, String> {
            value
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .ok_or_else(|| format!("strict media-end authority requires {name}"))
        };
        let authoritative_reference_frames =
            required(AUTHORITATIVE_REFERENCE_FRAMES_ENV, reference_frames)?
                .parse::<u64>()
                .map_err(|error| {
                    format!(
                        "{AUTHORITATIVE_REFERENCE_FRAMES_ENV} must be a positive integer: {error}"
                    )
                })?;
        if authoritative_reference_frames == 0
            || authoritative_reference_frames > provider_input_max_samples
        {
            return Err(format!(
                "{AUTHORITATIVE_REFERENCE_FRAMES_ENV} must be within 1..={provider_input_max_samples}"
            ));
        }
        let input_sample_rate_hz = required(INPUT_SAMPLE_RATE_HZ_ENV, input_sample_rate_hz)?
            .parse::<u32>()
            .map_err(|error| {
                format!("{INPUT_SAMPLE_RATE_HZ_ENV} must be a positive integer: {error}")
            })?;
        if input_sample_rate_hz != PROVIDER_INPUT_SAMPLE_RATE_HZ {
            return Err(format!(
                "strict media-end authority requires {INPUT_SAMPLE_RATE_HZ_ENV}={PROVIDER_INPUT_SAMPLE_RATE_HZ}; got {input_sample_rate_hz}"
            ));
        }
        let media_sha256 = required(MEDIA_SHA256_ENV, media_sha256)?;
        let authority_run_marker = required(AUTHORITY_RUN_MARKER_ENV, authority_run_marker)?;
        let authority_cell_id = required(AUTHORITY_CELL_ID_ENV, authority_cell_id)?;
        let authority_lease_id = required(AUTHORITY_LEASE_ID_ENV, authority_lease_id)?;
        if authority_run_marker != run_marker
            || authority_cell_id != cell_id
            || authority_lease_id != lease_id
        {
            return Err(
                "strict media-end authority identity does not match the validated run/cell/lease identity"
                    .to_string(),
            );
        }
        if media_sha256.len() != 64
            || !media_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!(
                "{MEDIA_SHA256_ENV} must be a lowercase 64-character sha256"
            ));
        }
        if run_marker.trim().is_empty()
            || cell_id.trim().is_empty()
            || lease_id.trim().is_empty()
            || session_generation == 0
        {
            return Err(
                "strict media-end authority requires the validated run/cell/lease/session identity"
                    .to_string(),
            );
        }
        Ok(Some(Self {
            authoritative_reference_frames,
            input_sample_rate_hz,
            media_sha256,
            run_marker: run_marker.to_string(),
            cell_id: cell_id.to_string(),
            lease_id: lease_id.to_string(),
            provider_input_max_samples,
            session_generation,
        }))
    }

    pub(in crate::audio::omni) fn media_end_ms(&self) -> u64 {
        let numerator = u128::from(self.authoritative_reference_frames).saturating_mul(1_000);
        let denominator = u128::from(self.input_sample_rate_hz);
        numerator.div_ceil(denominator).min(u128::from(u64::MAX)) as u64
    }

    pub(in crate::audio::omni) fn authenticates_post_reference_start(&self, audio_start_ms: u64) -> bool {
        audio_start_ms >= self.media_end_ms()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn strict_environment() -> HashMap<String, String> {
        HashMap::from([
            (
                AUTHORITATIVE_REFERENCE_FRAMES_ENV.to_string(),
                "2013045".to_string(),
            ),
            (INPUT_SAMPLE_RATE_HZ_ENV.to_string(), "16000".to_string()),
            (MEDIA_SHA256_ENV.to_string(), "a".repeat(64)),
            (AUTHORITY_RUN_MARKER_ENV.to_string(), "run-1".to_string()),
            (AUTHORITY_CELL_ID_ENV.to_string(), "cell-1".to_string()),
            (AUTHORITY_LEASE_ID_ENV.to_string(), "lease-1".to_string()),
        ])
    }

    #[test]
    fn production_parser_authenticates_only_the_ceil_media_end_boundary() {
        let environment = strict_environment();
        let authority = StrictMediaEndAuthority::from_environment(
            &|name| environment.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .expect("valid authority")
        .expect("authority present");
        assert_eq!(authority.media_end_ms(), 125_816);
        assert!(!authority.authenticates_post_reference_start(125_815));
        assert!(authority.authenticates_post_reference_start(125_816));
    }

    #[test]
    fn production_parser_keeps_missing_or_non_strict_authority_disabled() {
        let mut missing = strict_environment();
        missing.remove(AUTHORITATIVE_REFERENCE_FRAMES_ENV);
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| missing.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .expect("missing media authority is fail-closed")
        .is_none());
        let complete = strict_environment();
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| complete.get(name).cloned(),
            false,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .expect("ordinary session is fail-closed")
        .is_none());
    }

    #[test]
    fn production_parser_rejects_inconsistent_media_authority() {
        let mut wrong_rate = strict_environment();
        wrong_rate.insert(INPUT_SAMPLE_RATE_HZ_ENV.to_string(), "48000".to_string());
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| wrong_rate.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .is_err());
        let mut excessive_frames = strict_environment();
        excessive_frames.insert(
            AUTHORITATIVE_REFERENCE_FRAMES_ENV.to_string(),
            "2173046".to_string(),
        );
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| excessive_frames.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .is_err());
        let mut wrong_identity = strict_environment();
        wrong_identity.insert(AUTHORITY_LEASE_ID_ENV.to_string(), "other-lease".to_string());
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| wrong_identity.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .is_err());
        let mut missing_identity = strict_environment();
        missing_identity.remove(AUTHORITY_RUN_MARKER_ENV);
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| missing_identity.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .is_err());
        let mut uppercase_sha = strict_environment();
        uppercase_sha.insert(MEDIA_SHA256_ENV.to_string(), "A".repeat(64));
        assert!(StrictMediaEndAuthority::from_environment(
            &|name| uppercase_sha.get(name).cloned(),
            true,
            "run-1",
            "cell-1",
            "lease-1",
            2_173_045,
            7,
        )
        .is_err());
    }
}
