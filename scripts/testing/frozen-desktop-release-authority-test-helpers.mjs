import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  AUTHORITY_IMPLEMENTATION_FILES, AUTHORITY_RUNTIME_BINARY_FILES,
  currentAuthorityImplementationHashes, currentAuthorityRuntimeBinaryHashes, fileAuthorityEntry,
} from './watch-mode-evidence-authority.mjs';
import { coordinatorKeyIdForPublicKey, generateCoordinatorSigningKeyPair } from './watch-mode-shard-authority.mjs';
import { resolveFrozenDesktopAuthority } from './frozen-desktop-release-authority.mjs';

// Disposable fixture repository only. No product binary or Provider is executed.
export function createFrozenDesktopFixture(workspaceRoot) {
  const write = (relative, bytes) => {
    const candidate = path.join(workspaceRoot, relative);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, bytes);
    return candidate;
  };
  write('.gitignore', '*\n');
  write('tracked-fixture.txt', 'clean fixture\n');
  const git = (...args) => execFileSync('git', args, { cwd: workspaceRoot, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '--force', '.gitignore', 'tracked-fixture.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(workspaceRoot, 'no-hooks')}`,
    'commit', '--quiet', '-m', 'isolated fixture');
  const provenance = currentGitProvenance({ cwd: workspaceRoot });
  for (const relative of [
    ...AUTHORITY_IMPLEMENTATION_FILES, ...AUTHORITY_RUNTIME_BINARY_FILES,
    'scripts/testing/frozen-desktop-release-authority.mjs',
  ]) {
    if (!fs.existsSync(path.join(workspaceRoot, relative))) write(relative, `fixture:${relative}`);
  }
  const directory = 'artifacts/testing/watch-mode-strict-runtime/frozen-fixture';
  const keys = generateCoordinatorSigningKeyPair();
  const publicPath = write(`${directory}/public.pem`, keys.publicKeyPem);
  const privatePath = write(`${directory}/private.pem`, keys.privateKeyPem);
  const certificatePath = write(`${directory}/certificate.cer`, fs.readFileSync(path.join(
    workspaceRoot, 'drivers/windows-virtual-mic/package/omni-translate-development-driver.cer',
  )));
  const aecPath = write(`${directory}/aec.log`, 'fixture-only AEC receipt');
  const authority = {
    schemaVersion: 1, artifactKind: 'watch-mode-strict-runtime-authority', provenance,
    implementationHashes: currentAuthorityImplementationHashes({ workspaceRoot }),
    runtimeBinaryHashes: currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
    certificate: {
      keyAlgorithm: 'RSA', keyLength: 3072, hashAlgorithm: 'SHA256', enhancedKeyUsage: 'Code Signing',
      signingMode: 'local-self-signed', trustScope: 'vmware-testsigning-only', publicProductionTrust: false,
      certificateAuthority: fileAuthorityEntry(certificatePath, 'certificate.cer'),
    },
    coordinatorSigning: {
      algorithm: 'Ed25519', keyId: coordinatorKeyIdForPublicKey(keys.publicKeyPem),
      publicKeyAuthority: fileAuthorityEntry(publicPath, 'public.pem'),
      privateKeyAuthority: fileAuthorityEntry(privatePath, 'private.pem'),
    },
    aec3Gate: { verdict: 'passed', authority: fileAuthorityEntry(aecPath, 'aec.log') },
  };
  const canonicalize = (value) => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
  authority.authorityDigest = crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(authority))).digest('hex');
  const runtimeAuthority = write(`${directory}/strict-runtime-authority.json`, JSON.stringify(authority));
  const frozenRuntime = resolveFrozenDesktopAuthority({ runtimeAuthority, workspaceRoot });
  return { workspaceRoot, provenance, runtimeAuthority, frozenRuntime, authority, write };
}
