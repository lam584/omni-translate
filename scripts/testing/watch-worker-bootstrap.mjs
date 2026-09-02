import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export const FIXED_CREDENTIAL_TARGET = 'OmniTranslate:credential___provider_dashscope_default';

export function validateWorkerPins(workers) {
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > 3) {
    throw new Error('worker inventory must contain 1 to 3 workers');
  }
  const ids = new Set(); const bios = new Set(); const keys = new Set();
  for (const worker of workers) {
    if (!String(worker?.workerId ?? '').trim()) throw new Error('worker workerId is required');
    if (!String(worker?.user ?? '').trim()) throw new Error('worker user is required');
    if (!String(worker?.vmIdentity?.uuidBios ?? '').trim()) throw new Error('worker vmIdentity.uuidBios is required');
    const transport = worker?.transport;
    for (const field of ['kind', 'host', 'identityFile', 'knownHostsFile', 'hostKeyAlias', 'hostKeyAlgorithm', 'hostKeySha256']) {
      if (!String(transport?.[field] ?? '').trim()) throw new Error(`worker transport.${field} is required`);
    }
    if (transport.kind !== 'ssh' || !Number.isInteger(transport.port) || transport.port < 1 || transport.port > 65535) throw new Error(`worker ${worker.workerId} has an invalid SSH transport`);
    if (worker.user !== 'VMUser') throw new Error(`worker ${worker.workerId} must use VMUser`);
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(transport.hostKeySha256)) {
      throw new Error(`worker ${worker.workerId} has an invalid pinned SSH host-key fingerprint`);
    }
    for (const [set, value, label] of [[ids, worker.workerId, 'workerId'], [bios, worker.vmIdentity.uuidBios.toLowerCase(), 'BIOS UUID'], [keys, transport.hostKeySha256, 'SSH host key']]) {
      if (set.has(value)) throw new Error(`duplicate ${label}: ${value}`);
      set.add(value);
    }
  }
  return workers;
}

export function acceptRediscoveredWorker({ expected, observed }) {
  if (observed.transport.hostKeySha256 !== expected.transport.hostKeySha256) throw new Error('rediscovered SSH host key does not match its pin');
  if (String(observed.vmIdentity.uuidBios).toLowerCase() !== String(expected.vmIdentity.uuidBios).toLowerCase()) throw new Error('rediscovered BIOS UUID does not match its pin');
  return { workerId: expected.workerId, host: observed.transport.host, identityMatched: true };
}

export function verifyPinnedKnownHost(worker, readFileSync = fs.readFileSync) {
  const transport = worker.transport;
  const lines = readFileSync(transport.knownHostsFile, 'utf8').split(/\r?\n/);
  const matching = lines.map((line) => line.trim().split(/\s+/)).filter((parts) =>
    parts.length >= 3 && parts[0].split(',').includes(transport.hostKeyAlias) && parts[1] === transport.hostKeyAlgorithm);
  if (matching.length !== 1) throw new Error(`known_hosts must contain exactly one ${transport.hostKeyAlias} ${transport.hostKeyAlgorithm} key`);
  const encoded = matching[0][2];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('known_hosts key is not canonical base64');
  const key = Buffer.from(encoded, 'base64');
  if (key.toString('base64') !== encoded) throw new Error('known_hosts key is not canonical base64');
  if (!key.length) throw new Error('known_hosts key is empty');
  const actual = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
  if (actual !== transport.hostKeySha256) throw new Error('known_hosts key material does not match the pinned fingerprint');
  return actual;
}

export function buildStrictSshArgs({ worker, extra = [] }) {
  const transport = worker.transport;
  if (extra.some((value) => /^-(?:o|F|i)$/i.test(String(value)))) throw new Error('SSH identity and trust options cannot be overridden');
  return [
    '-i', transport.identityFile,
    '-p', String(transport.port),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${transport.knownHostsFile}`,
    '-o', `HostKeyAlias=${transport.hostKeyAlias}`,
    '-o', 'ConnectTimeout=15',
    ...extra,
    `${worker.user}@${transport.host}`,
  ];
}

function collect(child, limit = 65536) {
  const chunks = []; let size = 0;
  child.stderr.resume();
  child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 && size <= limit ? resolve(Buffer.concat(chunks)) : reject(new Error(`credential helper exited ${code}; outputBytes=${size}`)));
  });
}

function waitForExit(child, label) {
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`)));
  });
}

export async function transferCredential({ localHelper, sshPath = 'ssh.exe', sshArgs, remoteHelper, spawnImpl = spawn }) {
  if (!Array.isArray(sshArgs) || sshArgs.some((value) => /credential|dashscope|secret|api.?key/i.test(value))) {
    throw new Error('SSH arguments must contain identity/transport data only');
  }
  const source = spawnImpl(localHelper, ['export'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const remote = spawnImpl(sshPath, [...sshArgs, remoteHelper, 'import'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const transfer = pipeline(source.stdout, remote.stdin);
  const [, , imported] = await Promise.all([waitForExit(source, 'local credential export'), transfer, collect(remote)]);
  const receipt = JSON.parse(imported.toString('utf8'));
  if (receipt.schemaVersion !== 'watch-worker-credential-import/v1' || receipt.exists !== true || !Number.isInteger(receipt.blobBytes) || receipt.blobBytes < 1) {
    throw new Error('remote credential import receipt is invalid');
  }
  return receipt;
}

async function proof({ helper, sshPath, sshArgs, remoteHelper, remote, challenge, spawnImpl }) {
  const child = remote
    ? spawnImpl(sshPath, [...sshArgs, remoteHelper, 'prove'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawnImpl(helper, ['prove'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.end(challenge);
  return collect(child, 32);
}

export async function verifyCredentialMatch({ localHelper, sshPath = 'ssh.exe', sshArgs, remoteHelper, spawnImpl = spawn, randomBytesImpl = randomBytes }) {
  const challenge = randomBytesImpl(32);
  let local;
  let remote;
  try {
    [local, remote] = await Promise.all([
      proof({ helper: localHelper, challenge, spawnImpl }),
      proof({ sshPath, sshArgs, remoteHelper, remote: true, challenge, spawnImpl }),
    ]);
    if (local.length !== 32 || remote.length !== 32 || !timingSafeEqual(local, remote)) throw new Error('remote credential does not match local Credential Manager value');
    return { exists: true, blobBytes: null, matches: true };
  } finally {
    local?.fill(0);
    remote?.fill(0);
    challenge.fill(0);
  }
}

export async function provisionCredential(options) {
  const imported = await transferCredential(options);
  const verified = await verifyCredentialMatch(options);
  return {
    schemaVersion: 'watch-worker-credential-provision/v1',
    exists: verified.exists,
    blobBytes: imported.blobBytes,
    matches: verified.matches,
  };
}
