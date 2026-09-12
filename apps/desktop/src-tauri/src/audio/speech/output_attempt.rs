use super::SpeakerRenderEvent;

pub(super) fn run_wasapi_render_attempt<F, A, T>(
    on_render_event: &mut F,
    attempt: A,
) -> Result<T, String>
where
    F: for<'a> FnMut(SpeakerRenderEvent<'a>) -> Result<(), String>,
    A: FnOnce(&mut F) -> Result<T, String>,
{
    attempt(on_render_event)
}
