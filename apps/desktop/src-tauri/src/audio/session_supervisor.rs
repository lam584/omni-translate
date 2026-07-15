//! Application-facing owner for short-lived audio commands.
//!
//! Worker implementations remain in their focused modules; this type keeps
//! command handlers from reaching into engine, speech, and translation
//! modules independently.

use serde_json::Value;
use tauri::AppHandle;

use super::contracts::AudioRuntimeSnapshot;
use super::{engine, speech, state::AudioStateStore, translate};

pub struct AudioSessionSupervisor<'a> {
    app: AppHandle,
    state: &'a AudioStateStore,
}

impl<'a> AudioSessionSupervisor<'a> {
    pub fn new(app: AppHandle, state: &'a AudioStateStore) -> Self {
        Self { app, state }
    }

    pub fn bootstrap(&self) -> Result<AudioRuntimeSnapshot, String> {
        engine::bootstrap_audio_runtime(&self.app, self.state)
    }

    pub fn refresh_devices(&self) -> Result<AudioRuntimeSnapshot, String> {
        engine::refresh_devices(&self.app, self.state)
    }

    pub fn clear_cues(&self) -> Result<AudioRuntimeSnapshot, String> {
        engine::clear_cues(&self.app, self.state)
    }

    pub fn start_speech(&self, config: Value) -> Result<AudioRuntimeSnapshot, String> {
        speech::start_dispatch(self.app.clone(), self.state, config)
    }

    pub fn start_translation(&self, config: Value) -> Result<AudioRuntimeSnapshot, String> {
        translate::start_translate(self.app.clone(), self.state, config)
    }
}
