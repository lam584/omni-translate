import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {HOST_TIME_DLL,validateHostTimeOptIn,validateHostTimeSignature,hostTimeSignaturePowerShell} from './local-aec-host-time-preflight.mjs';
import {localAecProbeDesktopPowerShell} from './run-watch-mode-local-aec-probe.mjs';
const digest='a'.repeat(64);
const expected={dllPath:HOST_TIME_DLL,dllSha256:digest};
const signature={dllPath:HOST_TIME_DLL,sha256:digest,status:'Valid',subject:'CN=Broadcom Inc, O=Broadcom Inc, C=US',thumbprint:'B'.repeat(40)};
test('host-time opt-in is absent or exactly fixed installed vendor path/hash',()=>{
 assert.equal(validateHostTimeOptIn('',''),null);assert.deepEqual(validateHostTimeOptIn(HOST_TIME_DLL,digest),expected);
 for(const [p,h] of [[HOST_TIME_DLL,''],['',digest],['C:\\temp\\vmtools.dll',digest],[HOST_TIME_DLL,'g'.repeat(64)],['x";bad',digest]])
  assert.throws(()=>validateHostTimeOptIn(p,h),/fixed installed/u);
});
test('host-time binding requires actual vendor signature and matching bytes',()=>{
 const bound=validateHostTimeSignature(signature,expected);
 assert.equal(bound.diagnosticOnly,true);assert.equal(bound.acceptanceAuthority,false);assert.equal(bound.qpcFitOrReanchor,false);
 for(const [key,value] of [['status','NotSigned'],['subject','CN=Broadcom Inc.'],['sha256','0'.repeat(64)],['dllPath','C:\\fake.dll'],['thumbprint','bogus']])
  assert.throws(()=>validateHostTimeSignature({...signature,[key]:value},expected),/vendor signature/u);
});
test('signature script pins actual file and refuses hash/signature/reparse changes',()=>{
 const script=hostTimeSignaturePowerShell(expected);
 assert.ok(script.includes(HOST_TIME_DLL));assert.ok(script.includes(digest));
 for(const marker of ['Get-AuthenticodeSignature','[IO.FileShare]::Read','ReparsePoint','finally{$f.Dispose()}','O=Broadcom Inc'])assert.ok(script.includes(marker));
 assert.throws(()=>hostTimeSignaturePowerShell({dllPath:'untrusted',dllSha256:digest}),/fixed installed/u);
});
test('no-provider desktop environment scrubs first then injects only frozen diagnostic pair',()=>{
 const args={executable:'desktop.exe',executableSha256:digest,runtimeRoot:'runtime',outputDirectory:'output',requestPath:'request',deadlineUtc:'2026-10-03T00:00:00Z',helperPath:'helper',helperSha256:digest};
 const absent=localAecProbeDesktopPowerShell(args);
 assert.ok(!absent.includes('OMNI_WATCH_MODE_AEC_HOST_TIME_DLL='));
 const opted=localAecProbeDesktopPowerShell({...args,hostTimeDiagnostic:expected});
 assert.ok(opted.indexOf('SetEnvironmentVariable')<opted.indexOf('$hostSignatureReceipt'));
 assert.ok(opted.includes(HOST_TIME_DLL));assert.ok(opted.includes('OMNI_WATCH_MODE_AEC_HOST_TIME_DLL_SHA256'));
 assert.throws(()=>localAecProbeDesktopPowerShell({...args,hostTimeDiagnostic:{...expected,dllPath:'arbitrary'}}),/fixed installed/u);
});
test('native reader is initialized before Start, and does not grant source-clock authority',()=>{
 const raw=fs.readFileSync(new URL('../../apps/bridge-service-native/src/bin/injector/source_clock/raw_trace.rs',import.meta.url),'utf8');
 const start=raw.indexOf('fn open('),end=raw.indexOf('pub(super) fn start_render(&mut self',start);
 assert.ok(raw.slice(start,end).includes('HostTimeObserver::from_env()'));
 const observe=raw.slice(raw.indexOf('pub(super) fn observe('),raw.indexOf('fn observe_reading('));
 assert.ok(!observe.includes('get_or_insert_with(HostTimeObserver::from_env)'));
 const reader=fs.readFileSync(new URL('../../apps/bridge-service-native/src/bin/injector/source_clock/host_time_observation.rs',import.meta.url),'utf8');
 assert.ok(reader.includes('LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32'));
 for(const marker of ['"acceptanceAuthority":false','"qpcFitOrReanchor":false','"inputCommand":46'])assert.ok(reader.includes(marker));
});
