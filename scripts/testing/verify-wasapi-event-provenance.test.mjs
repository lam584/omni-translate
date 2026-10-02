import assert from 'node:assert/strict';
import {test} from 'node:test';
import crypto from 'node:crypto';
import {verifyWasapiVendorInventory as verify, verifyWasapiEventProvenance as verifyRepo} from './verify-wasapi-event-provenance.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const contents=new Map(['Cargo.toml','src/api.rs','src/errors.rs','src/lib.rs','LICENSE.txt','README.md'].map(p=>[p,Buffer.from(p)]));
  const manifest={schemaVersion:1,artifactKind:'wasapi-event-vendor-provenance',upstream:{version:'0.24.0',crateChecksum:'a'.repeat(64)},addedFiles:[],files:[...contents].map(([path,bytes])=>({path,patchedSha256:digest(bytes),upstreamSha256:path==='Cargo.toml'||path==='src/api.rs'||path==='src/errors.rs'?'b'.repeat(64):digest(bytes),modified:path==='Cargo.toml'||path==='src/api.rs'||path==='src/errors.rs'}))};
  return {manifest,inventory:[...contents.keys()],read:p=>contents.get(p),contents};
}
test('verifies exact license/source and declared minimal production patch',()=>{
  const f=fixture(),r=verify(f); assert.equal(r.passed,true); assert.equal(r.verifiedFileCount,6);
  assert.deepEqual(r.modifiedFiles,['Cargo.toml','src/api.rs','src/errors.rs']);
});
test('rejects altered source, license and deleted or extra files',()=>{
  for(const edit of [f=>f.contents.set('src/api.rs',Buffer.from('tampered')),f=>f.contents.set('LICENSE.txt',Buffer.from('different')),f=>f.inventory.pop(),f=>f.inventory.push('extra.rs')]){
    const f=fixture();edit(f);assert.throws(()=>verify(f),/wasapi event provenance/u);
  }
});
test('rejects unsafe paths, identity change and undeclared upstream mutation',()=>{
  for(const edit of [f=>f.manifest.files[0].path='../escape',f=>f.manifest.files[0].path='C:\\escape',f=>f.manifest.files[0].path='/escape',f=>f.manifest.files.push({...f.manifest.files[0]}),f=>f.manifest.upstream.version='0.25.0',f=>f.manifest.files[0].modified=false,f=>f.manifest.files[3].modified=true,f=>f.manifest.files[3].upstreamSha256='c'.repeat(64)]){
    const f=fixture();edit(f);assert.throws(()=>verify(f),/wasapi event provenance/u);
  }
});
test('frozen real vendor, manifest and workspace lock agree',()=>assert.equal(verifyRepo().passed,true));

test('added deadline sources require exact hashes and inventory without widening original modified scope',()=>{
  function addedFixture() {
    const f=fixture();
    for(const path of ['src/event_deadline.rs','src/event_deadline_tests.rs']) {
      const bytes=Buffer.from(path);f.contents.set(path,bytes);f.inventory.push(path);
      f.manifest.addedFiles.push({path,patchedSha256:digest(bytes)});
    }
    return f;
  }
  const good=verify(addedFixture());
  assert.equal(good.verifiedFileCount,8);
  assert.deepEqual(good.modifiedFiles,['Cargo.toml','src/api.rs','src/errors.rs']);
  for(const mutate of [
    f=>f.contents.set('src/event_deadline.rs',Buffer.from('altered deadline')),
    f=>f.manifest.addedFiles[1].patchedSha256='c'.repeat(64),
    f=>f.inventory.pop(),
    f=>f.inventory.push('src/undeclared_deadline.rs'),
    f=>f.manifest.addedFiles.push({...f.manifest.addedFiles[0]}),
  ]) {
    const value=addedFixture();mutate(value);
    assert.throws(()=>verify(value),/wasapi event provenance/u);
  }
});
