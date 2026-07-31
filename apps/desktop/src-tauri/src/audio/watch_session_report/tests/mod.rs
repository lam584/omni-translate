use super::*;

fn receipt(session_id: &str, cue_id: &str, started_unix_ms: u64) -> OverlayRenderReceiptRuntime {
    OverlayRenderReceiptRuntime {
        session_id: session_id.to_string(),
        cue_id: cue_id.to_string(),
        revision: 1,
        source_text: "hello".to_string(),
        translated_text: "你好".to_string(),
        committed: true,
        visible: true,
        rendered_at_ms: started_unix_ms,
    }
}

mod lifecycle_errors;
mod recording;
mod revisions;
mod snapshot;
