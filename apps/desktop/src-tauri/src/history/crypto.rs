use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};

use crate::storage::credential::{CredentialVault, KeyringCredentialVault};

const MASTER_KEY_REFERENCE: &str = "credential://history/content-key/v1";
const ENVELOPE_MAGIC: &[u8; 7] = b"OMNIH01";
const NONCE_LENGTH: usize = 12;

#[derive(Clone)]
pub(super) struct HistoryCipher {
    key: [u8; 32],
}

impl HistoryCipher {
    pub(super) fn from_system_credentials(existing_archive: bool) -> Result<Self, String> {
        let vault = KeyringCredentialVault::new();
        let encoded = match vault.read_secret(MASTER_KEY_REFERENCE)? {
            Some(value) if !value.trim().is_empty() => value,
            _ if existing_archive => {
                return Err(
                    "字幕历史密钥缺失：已存在的加密历史不可用；请恢复系统凭据，或清空历史后重新初始化"
                        .to_string(),
                );
            }
            _ => generate_and_store_key(&vault)?,
        };

        let decoded = STANDARD_NO_PAD
            .decode(encoded.trim())
            .map_err(|_| "系统凭据中的字幕历史主密钥格式无效".to_string())?;
        let key: [u8; 32] = decoded
            .try_into()
            .map_err(|_| "系统凭据中的字幕历史主密钥长度无效".to_string())?;
        Ok(Self { key })
    }

    pub(super) fn reinitialize_system_credentials() -> Result<Self, String> {
        let vault = KeyringCredentialVault::new();
        let encoded = generate_and_store_key(&vault)?;
        let key: [u8; 32] = STANDARD_NO_PAD
            .decode(encoded)
            .map_err(|_| "新生成的字幕历史主密钥格式无效".to_string())?
            .try_into()
            .map_err(|_| "新生成的字幕历史主密钥长度无效".to_string())?;
        Ok(Self { key })
    }

    #[cfg(test)]
    pub(super) fn for_test(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub(super) fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &self.key)
                .map_err(|_| "无法初始化字幕历史加密密钥".to_string())?,
        );
        let mut nonce_bytes = [0_u8; NONCE_LENGTH];
        SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|_| "无法生成字幕历史加密 nonce".to_string())?;
        let mut encrypted = plaintext.to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::from(aad),
            &mut encrypted,
        )
        .map_err(|_| "字幕历史加密失败".to_string())?;

        let mut envelope = Vec::with_capacity(ENVELOPE_MAGIC.len() + NONCE_LENGTH + encrypted.len());
        envelope.extend_from_slice(ENVELOPE_MAGIC);
        envelope.extend_from_slice(&nonce_bytes);
        envelope.extend_from_slice(&encrypted);
        Ok(envelope)
    }

    pub(super) fn decrypt(&self, envelope: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
        if envelope.len() < ENVELOPE_MAGIC.len() + NONCE_LENGTH + AES_256_GCM.tag_len()
            || &envelope[..ENVELOPE_MAGIC.len()] != ENVELOPE_MAGIC
        {
            return Err("字幕历史密文格式无效".to_string());
        }
        let nonce_start = ENVELOPE_MAGIC.len();
        let nonce_end = nonce_start + NONCE_LENGTH;
        let nonce_bytes: [u8; NONCE_LENGTH] = envelope[nonce_start..nonce_end]
            .try_into()
            .map_err(|_| "字幕历史 nonce 格式无效".to_string())?;
        let key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, &self.key)
                .map_err(|_| "无法初始化字幕历史解密密钥".to_string())?,
        );
        let mut encrypted = envelope[nonce_end..].to_vec();
        let plaintext = key
            .open_in_place(
                Nonce::assume_unique_for_key(nonce_bytes),
                Aad::from(aad),
                &mut encrypted,
            )
            .map_err(|_| "字幕历史解密失败：密文或关联数据已损坏".to_string())?;
        Ok(plaintext.to_vec())
    }
}

fn generate_and_store_key(vault: &impl CredentialVault) -> Result<String, String> {
    let mut key = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "无法生成字幕历史主密钥".to_string())?;
    let encoded = STANDARD_NO_PAD.encode(key);
    vault.upsert_secret(MASTER_KEY_REFERENCE, &encoded)?;
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_envelope_round_trips_and_authenticates_aad() {
        let cipher = HistoryCipher::for_test([7; 32]);
        let encrypted = cipher.encrypt("你好，history".as_bytes(), b"cue-1").unwrap();
        assert!(!encrypted.windows(7).any(|part| part == "history".as_bytes()));
        assert_eq!(
            cipher.decrypt(&encrypted, b"cue-1").unwrap(),
            "你好，history".as_bytes()
        );
        assert!(cipher.decrypt(&encrypted, b"cue-2").is_err());
    }
}
