/**
 * Pinned vocabulary of native speech dispatch event kinds.
 *
 * Source of truth: the `push_event` call sites in
 * `apps/desktop/src-tauri/src/audio/speech/dispatch.rs` and
 * `apps/desktop/src-tauri/src/audio/speech.rs`. Every kind listed here must
 * appear verbatim in those files, and every mock/preview event must use a
 * kind from this list — `speech-event-kinds.contract.test.ts` enforces both
 * directions, so a phantom kind (like the retired `speech.tts-requested`,
 * which never existed on the Rust side) cannot re-enter the mock world.
 */
export const SPEECH_EVENT_KINDS = [
  'speech.deferred',
  'speech.cache-hit',
  'speech.realtime-audio-requested',
  'speech.completed',
  'speech.error',
  'speech.ptt-blocked',
  'speech.stopped',
] as const;

export type SpeechEventKind = (typeof SPEECH_EVENT_KINDS)[number];
