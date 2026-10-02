import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isMain, repoRoot} from '../lib/testing-common.mjs';
// Reviewed upstream archive and exact event-only patch identity.
export const WASAPI_EVENT_MANIFEST_SHA256 = '5d45a38c6352099f267fe9c29ab0f45c92d109b8988e60d3173317b97d76912f';
const UPSTREAM_CRATE_CHECKSUM = 'ee144c215d8d31e94c1a599fbaf540ca82a7017e4f1786816b179f334fac751d';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(ok,message)=>{if(!ok)throw Error(`wasapi event provenance: ${message}`);};
const safeRelative=value=>typeof value==='string' && !value.includes('\\') && !path.posix.isAbsolute(value)
  && value.split('/').every(part=>part.length>0 && part!=='.' && part!=='..' && /^[A-Za-z0-9_.-]+$/u.test(part));
export function verifyWasapiVendorInventory({manifest, inventory, read}) {
  check(manifest?.schemaVersion===1 && manifest.artifactKind==='wasapi-event-vendor-provenance', 'manifest schema');
  check(manifest.upstream?.version==='0.24.0' && /^[a-f0-9]{64}$/u.test(manifest.upstream.crateChecksum), 'upstream identity');
  check(Array.isArray(manifest.files) && manifest.files.length>0 && Array.isArray(manifest.addedFiles), 'file inventory');
  const seen=new Set();
  for(const file of [...manifest.files,...manifest.addedFiles]) {
    check(safeRelative(file.path) && !seen.has(file.path), 'unsafe or duplicate path'); seen.add(file.path);
    check(/^[a-f0-9]{64}$/u.test(file.patchedSha256), 'patched hash');
    check(digest(read(file.path))===file.patchedSha256, `file hash ${file.path}`);
  }
  const modified=[];
  for(const file of manifest.files) {
    check(/^[a-f0-9]{64}$/u.test(file.upstreamSha256) && typeof file.modified==='boolean', 'upstream file identity');
    check(file.modified===(file.upstreamSha256!==file.patchedSha256), 'modification declaration');
    if(file.modified)modified.push(file.path);
  }
  check(JSON.stringify(modified.sort())===JSON.stringify(['Cargo.toml','src/api.rs','src/errors.rs']), 'unexpected production patch scope');
  check(seen.has('LICENSE.txt') && seen.has('src/lib.rs') && seen.has('README.md'), 'missing upstream license/source');
  check(inventory.every(safeRelative) && inventory.length===seen.size && inventory.every(file=>seen.has(file)), 'extra/missing vendor file');
  return {schemaVersion:1,artifactKind:'wasapi-event-vendor-verification',passed:true,
    version:manifest.upstream.version,upstreamCrateChecksum:manifest.upstream.crateChecksum,
    verifiedFileCount:seen.size,modifiedFiles:modified,hardwareCalls:0,providerCalls:0};
}
function list(dir,prefix='') {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    check(!entry.isSymbolicLink(), 'symlink vendor file');
    const relative=prefix+entry.name;
    if(entry.isDirectory())return list(path.join(dir,entry.name),relative+'/');
    check(entry.isFile(), 'non-regular vendor file');
    return relative==='VENDOR-PROVENANCE.json'?[]:[relative];
  });
}
export function verifyWasapiEventProvenance(root=repoRoot) {
  const vendor=path.join(root,'third-party/wasapi-0.24.0');
  const bytes=fs.readFileSync(path.join(vendor,'VENDOR-PROVENANCE.json'));
  check(digest(bytes)===WASAPI_EVENT_MANIFEST_SHA256, 'frozen manifest hash');
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  check(manifest.upstream?.crateChecksum===UPSTREAM_CRATE_CHECKSUM, 'pinned upstream archive checksum');
  const result=verifyWasapiVendorInventory({manifest,inventory:list(vendor),read:file=>fs.readFileSync(path.join(vendor,file))});
  const cargo=fs.readFileSync(path.join(root,'Cargo.toml'),'utf8');
  check(cargo.includes('[patch.crates-io]') && /wasapi\s*=\s*\{\s*path\s*=\s*"third-party\/wasapi-0\.24\.0"\s*\}/u.test(cargo), 'workspace patch');
  const locks=fs.readFileSync(path.join(root,'Cargo.lock'),'utf8').split('[[package]]').filter(block=>/^\s*name = "wasapi"$/mu.test(block));
  check(locks.length===1 && /^version = "0\.24\.0"$/mu.test(locks[0]) && !/^(source|checksum) = /mu.test(locks[0]), 'lockfile selected registry instead of audited local library');
  return {...result,manifestSha256:WASAPI_EVENT_MANIFEST_SHA256};
}
if(isMain(import.meta.url))console.log(JSON.stringify(verifyWasapiEventProvenance(),null,2));
