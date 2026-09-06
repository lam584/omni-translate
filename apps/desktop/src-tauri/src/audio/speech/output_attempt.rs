use std::time::Instant;

use super::SpeakerRenderEvent;
use crate::audio::playback_ownership;

pub(super) fn run_wasapi_render_attempt<F, A, T>(
    on_render_event: &mut F,
    attempt: A,
) -> Result<T, String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
    A: FnOnce(&mut F) -> Result<T, String>,
{
    on_render_event(SpeakerRenderEvent::Discontinuity {
        reason: "wasapi-render-session-start",
        observed_at: Instant::now(),
    })?;
    match attempt(on_render_event) {
        Ok(value) => Ok(value),
        Err(error) => {
            let reason = if playback_ownership::desktop_playback_was_cancelled(&error) {
                "wasapi-render-ownership-cancelled"
            } else {
                "wasapi-render-failed"
            };
            let discontinuity = on_render_event(SpeakerRenderEvent::Discontinuity {
                reason,
                observed_at: Instant::now(),
            });
            Err(match discontinuity {
                Ok(()) => error,
                Err(discontinuity_error) => format!(
                    "{error}; failed to publish render discontinuity after render failure: {discontinuity_error}"
                ),
            })
        }
    }
}
