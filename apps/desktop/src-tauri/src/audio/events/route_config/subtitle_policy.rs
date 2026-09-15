use super::*;

pub(super) fn is_legacy_default_instructions(text: &str) -> bool {
    matches!(
        text,
        "你是一个实时翻译助手，请将听到的外语内容翻译成中文输出。"
            | "You are a realtime subtitle translator. Translate incoming audio into concise subtitles."
    )
}
pub(super) fn subtitle_translate_mode_and_model(config: &Value) -> (&str, &str) {
    let mode = config
        .pointer("/devices/subtitleTranslationMode")
        .and_then(Value::as_str)
        .unwrap_or("native");
    let model_id = config
        .pointer("/devices/subtitleTranslationModelId")
        .and_then(Value::as_str)
        .unwrap_or("");
    (mode, model_id)
}
