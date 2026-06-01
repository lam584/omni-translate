import { startBridgeService } from './service/bridge-service.js';

function readArg(flag: string) {
  const index = process.argv.findIndex((value) => value === flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main() {
  const pipeName = readArg('--pipe-name');
  const runtimeRoot = readArg('--runtime-root');
  const bridgeVersion = readArg('--bridge-version');
  const service = await startBridgeService({ pipeName, runtimeRoot, bridgeVersion });

  process.stdout.write(`${JSON.stringify({ type: 'bridge-service.ready', pipePath: service.pipePath, runtimeRoot: service.runtimeRoot })}\n`);

  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});