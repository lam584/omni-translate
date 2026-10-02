import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
function runMarker(mutation = '', budget = 2880000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-aec-media-marker-'));
  try {
    const reference = path.join(directory, 'source.pcm');
    fs.writeFileSync(reference, Buffer.alloc(2013045 * 2));
    const script = `
      $ErrorActionPreference='Stop'
      Import-Module ${quote(path.join(root, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InputCompletion.psm1'))} -Force
      $env:OMNI_WATCH_MODE_COMPLETION_POLICY='aec-output-quiescent-v2'
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES='${budget}'
      $playback=[pscustomobject]@{passed=$true;mediaSha256='cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f';injectorProcessId=123;endpointId='speaker';startedAtMs=1000;finishedAtMs=2000;referencePcmPath=${quote(reference)}}
      ${mutation}
      Write-WatchModeMediaCompleteMarker -Path ${quote(path.join(directory, 'media-complete.json'))} -RunMarker run -CellId c03 -LeaseId lease -WorkspaceRoot ${quote(root)} -Playback $playback -CompletionPolicy 'aec-output-quiescent-v2' | Out-Null
    `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return { status: result.status, stderr: result.stderr,
      inputClosed: fs.existsSync(path.join(directory, 'input-complete.json')),
      marker: fs.existsSync(path.join(directory, 'media-complete.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'media-complete.json'), 'utf8').replace(/^\uFEFF/, '')) : null };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test('media-complete records source and physical player identity without closing input', {skip:process.platform!=='win32'}, () => {
  const result=runMarker(); assert.equal(result.status,0,result.stderr); assert.equal(result.inputClosed,false);
  assert.equal(result.marker.artifactKind,'watch-mode-media-complete');assert.equal(result.marker.schemaVersion,2);
  assert.equal(result.marker.playbackProcessId,123);assert.equal(result.marker.mediaPlaybackCompletedAtUnixMs,2000);
  assert.equal(result.marker.expectedSourceSegments.length,6);assert.equal(result.marker.maxExternalAudioSamples,2880000);
});
test('failed playback, wrong material, old budget and spoofed source cannot create completion', {skip:process.platform!=='win32'}, () => {
  for(const [mutation,budget] of [["$playback.passed=$false",2880000],["$playback.mediaSha256='wrong'",2880000],["",2173045],["$playback.injectorProcessId=0",2880000],["$playback.finishedAtMs=999",2880000]]) {
    const result=runMarker(mutation,budget);assert.notEqual(result.status,0);assert.match(result.stderr,/media-complete requires|signed sample ceiling/);assert.equal(result.marker,null);assert.equal(result.inputClosed,false);
  }
});

// A failed terminal must retain the offending admitted model event as well as
// its typed failure. Do not place the trace behind the fallible drain reducer.
test('late admitted output is journaled before typed quiescence can reject it', () => {
  const source = fs.readFileSync(new URL('../../apps/desktop/src-tauri/src/audio/omni/socket_event_processor.rs', import.meta.url), 'utf8');
  const trace = source.indexOf('trace_call.record_ws_recv(event_type.as_str(), evt.clone());');
  const activity = source.indexOf('record_admitted_open_input_activity(store, &direction, event_type.as_str(), &evt)?;');
  assert.ok(trace >= 0 && activity > trace);
});
