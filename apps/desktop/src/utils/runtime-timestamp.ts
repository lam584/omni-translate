/**
 * Single source of truth for parsing runtime timestamp markers produced by
 * the Rust backend. The wire grammar, pinned by runtime-timestamp.test.ts:
 *
 * - `unix:<seconds>`      runtime/state.rs now_marker, provider gateway
 *                         now_marker, storage repository current_timestamp
 * - `unix-ms:<millis>`    audio/time_utils.rs ms_marker / now_marker
 * - bare 10-digit string  unix seconds
 * - bare 13-digit string  unix milliseconds
 * - anything else         ISO-8601 (Date.parse)
 */
export function parseRuntimeTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  if (value.startsWith('unix-ms:')) {
    const raw = Number(value.slice('unix-ms:'.length));
    return Number.isFinite(raw) ? raw : null;
  }
  if (value.startsWith('unix:')) {
    const raw = Number(value.slice('unix:'.length));
    return Number.isFinite(raw) ? raw * 1000 : null;
  }
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  if (/^\d{13}$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
