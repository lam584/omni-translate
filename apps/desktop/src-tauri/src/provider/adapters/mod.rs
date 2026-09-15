//! Provider-owned wire adapters.
//!
//! Audio orchestration consumes these adapters through compatibility re-exports;
//! provider-specific endpoint, request, event and lifecycle logic lives here.

pub(crate) mod gemini_live;
pub(crate) mod openai_realtime;
pub(crate) mod tencent_speech_translate;
