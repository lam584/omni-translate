//! 批量基准测试模型清单定义与解析

use serde::Deserialize;

/// 模型清单文件结构
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub models: Vec<ManifestEntry>,
}

/// 单个模型的清单条目
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub model_id: String,
    pub provider: String,
    pub protocol: String,
    pub audio_mode: String,
    pub base_url: String,
    pub credential_ref: String,
    pub env_fallback: String,
    pub auth_header: String,
    pub auth_scheme: String,
    #[serde(default = "default_voice")]
    pub voice: String,
    #[serde(default = "default_target_lang")]
    pub target_language: String,
    #[serde(default = "default_source_lang")]
    pub source_language: String,
}

fn default_voice() -> String {
    "Ethan".to_string()
}

fn default_target_lang() -> String {
    "zh".to_string()
}

fn default_source_lang() -> String {
    "en".to_string()
}

/// 从 JSON 文件加载模型清单
pub fn load_manifest(path: &str) -> Result<Manifest, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("读取清单文件 '{}': {e}", path))?;
    let manifest: Manifest = serde_json::from_str(&content)
        .map_err(|e| format!("解析清单 JSON '{}': {e}", path))?;
    if manifest.models.is_empty() {
        return Err(format!("清单文件 '{}' 中没有模型条目", path));
    }
    Ok(manifest)
}
