import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { windowsPowerShellEnvironment } from './run-watch-mode-live-production-coordinator.mjs';
export const HOST_TIME_DLL = 'C:\\Program Files\\VMware\\VMware Tools\\vmtools.dll';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function validateHostTimeOptIn(dll, digest) {
 if(!dll&&!digest)return null;
 if(typeof dll!=='string'||typeof digest!=='string'||dll.toLowerCase()!==HOST_TIME_DLL.toLowerCase()
  ||!/^[a-f0-9]{64}$/u.test(digest))throw Error('host time diagnostic requires fixed installed vendor DLL and explicit SHA256');
 return {dllPath:HOST_TIME_DLL,dllSha256:digest};
}
export function validateHostTimeSignature(value, expected) {
 if(value?.status!=='Valid'||typeof value.subject!=='string'||!/(?:^|,\s*)O=Broadcom Inc(?:,|$)/u.test(value.subject)
  ||value.sha256!==expected.dllSha256||value.dllPath!==HOST_TIME_DLL
  ||typeof value.thumbprint!=='string'||!/^[A-Fa-f0-9]{40,64}$/u.test(value.thumbprint))throw Error('host time vendor signature/hash preflight failed');
 return {...expected,signatureStatus:value.status,signerSubject:value.subject,signerThumbprint:value.thumbprint,
  diagnosticOnly:true,acceptanceAuthority:false,qpcFitOrReanchor:false,inputCommand:46};
}
export function hostTimeSignaturePowerShell(expected) {
 const bound=validateHostTimeOptIn(expected?.dllPath,expected?.dllSha256);
 if(!bound)throw Error('missing host time preflight binding');
 return String.raw`$ErrorActionPreference='Stop'
$p='C:\Program Files\VMware\VMware Tools\vmtools.dll'
foreach($ancestor in @($p,'C:\Program Files\VMware\VMware Tools','C:\Program Files\VMware','C:\Program Files','C:\')) {
 if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'host-time DLL path is redirected'}
}
$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
 if($f.Length -le 0 -or $f.Length -gt 67108864){throw 'host-time DLL size out of bound'}
 $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
 if($h -cne '${bound.dllSha256}'){throw 'host-time DLL hash changed'}
 $s=Get-AuthenticodeSignature -LiteralPath $p
 if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)O=Broadcom Inc(?:,|$)'){throw 'host-time DLL not vendor signed'}
 [ordered]@{dllPath=$p;sha256=$h;status=[string]$s.Status;subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress
}finally{$f.Dispose()}`;
}
export function preflightHostTimeDiagnostic(dll,digest) {
 const expected=validateHostTimeOptIn(dll,digest);if(!expected)return null;
 const stat=fs.lstatSync(expected.dllPath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>64*1024*1024
  ||fs.realpathSync.native(expected.dllPath)!==path.resolve(expected.dllPath)
  ||sha(fs.readFileSync(expected.dllPath))!==expected.dllSha256)throw Error('host time DLL bytes/path failed preflight');
 const script=hostTimeSignaturePowerShell(expected);
 const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
  {encoding:'utf8',windowsHide:true,timeout:10000,env:windowsPowerShellEnvironment()}).replace(/^\uFEFF/u,''));
 return validateHostTimeSignature(value,expected);
}
