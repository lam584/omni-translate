import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

export const DEFAULT_PROVIDER_HEALTH_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const PROVIDER_NETWORK_HEALTH_TIMEOUT_MS = 5_000;
export const PROVIDER_NETWORK_HEALTH_SAMPLE_COUNT = 3;

const atomicWriteJson = (filePath, value) => {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
};

function connectTls({ host, port, timeoutMs = PROVIDER_NETWORK_HEALTH_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error(`TLS connection timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      const sample = {
        latencyMs: Math.round(performance.now() - started),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ?? null,
        protocol: socket.getProtocol(),
        certificateSubject: certificate?.subject?.CN ?? null,
        certificateValidTo: certificate?.valid_to ?? null,
      };
      socket.end();
      resolve(sample);
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function probeWebSocketUpgrade({ host, port, requestPath, timeoutMs = PROVIDER_NETWORK_HEALTH_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error(`WebSocket reachability timed out after ${timeoutMs}ms`)), timeoutMs);
    let response = '';
    socket.once('secureConnect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write([
        `GET ${requestPath || '/'} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade',
        'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`, '', '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n')) return;
      clearTimeout(timer);
      const statusCode = Number(response.match(/^HTTP\/1\.[01]\s+(\d{3})/u)?.[1] ?? 0);
      socket.end();
      if ([101, 400, 401, 403, 404, 426].includes(statusCode)) resolve({ reachable: true, statusCode });
      else reject(new Error(`unexpected WebSocket endpoint HTTP status ${statusCode || 'unknown'}`));
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function establishedOmniProviderConnections() {
  if (process.platform !== 'win32') return [];
  const source = String.raw`
$rows = @(Get-NetTCPConnection -State Established -RemotePort 443 -ErrorAction SilentlyContinue | ForEach-Object {
  $owner = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  if ($owner -and $owner.ProcessName -match '^omni-(desktop-shell|bridge-service)$') {
    [pscustomobject]@{ pid = [int]$_.OwningProcess; processName = $owner.ProcessName; remoteAddress = [string]$_.RemoteAddress; remotePort = [int]$_.RemotePort }
  }
})
$rows | ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', source,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error || Number(result.status) !== 0 || !String(result.stdout).trim()) return [];
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [{ inspectionError: 'invalid PowerShell connection inventory' }];
  }
}

export async function runProviderNetworkHealth({
  executionId,
  providerId,
  endpointUrl = process.env.OMNI_PROVIDER_NETWORK_HEALTH_URL || DEFAULT_PROVIDER_HEALTH_URL,
  outputPath,
  resolveDns = dns.lookup,
  connect = connectTls,
  probeWebSocket = probeWebSocketUpgrade,
  inspectExistingConnections = establishedOmniProviderConnections,
  now = () => new Date(),
} = {}) {
  const endpoint = new URL(endpointUrl);
  if (endpoint.protocol !== 'wss:') throw new Error('provider network health endpoint must use wss');
  const generatedAt = now();
  let addresses = [];
  let dnsError = null;
  try { addresses = await resolveDns(endpoint.hostname, { all: true }); } catch (error) { dnsError = error.message; }
  const samples = [];
  for (let index = 0; index < PROVIDER_NETWORK_HEALTH_SAMPLE_COUNT; index += 1) {
    try {
      samples.push({ index, status: 'passed', ...(await connect({ host: endpoint.hostname, port: Number(endpoint.port || 443) })) });
    } catch (error) {
      samples.push({ index, status: 'failed', error: error.message });
    }
  }
  const existingConnections = await inspectExistingConnections();
  let websocket;
  try {
    websocket = await probeWebSocket({
      host: endpoint.hostname,
      port: Number(endpoint.port || 443),
      requestPath: `${endpoint.pathname}${endpoint.search}`,
    });
  } catch (error) {
    websocket = { reachable: false, error: error.message };
  }
  const passedSamples = samples.filter((sample) => sample.status === 'passed');
  const latencies = passedSamples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const jitterMs = latencies.length > 1 ? latencies.at(-1) - latencies[0] : null;
  const receipt = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-network-health',
    generatedAt: generatedAt.toISOString(),
    executionId,
    providerId,
    endpoint: { protocol: endpoint.protocol, host: endpoint.hostname, port: Number(endpoint.port || 443), path: endpoint.pathname },
    dns: { passed: !dnsError && addresses.length > 0, addresses, error: dnsError },
    tls: { samples, passedSamples: passedSamples.length, failedSamples: samples.length - passedSamples.length, jitterMs },
    websocket,
    existingOmniProviderConnections: existingConnections,
    providerCalls: 0,
    verdict: !dnsError && addresses.length > 0 && passedSamples.length === samples.length && websocket.reachable === true && existingConnections.length === 0
      ? 'passed' : 'failed',
  };
  if (outputPath) atomicWriteJson(outputPath, receipt);
  if (receipt.verdict !== 'passed') {
    const error = new Error('provider network health failed before paid preflight authorization');
    error.receipt = receipt;
    error.receiptPath = outputPath;
    throw error;
  }
  return receipt;
}
