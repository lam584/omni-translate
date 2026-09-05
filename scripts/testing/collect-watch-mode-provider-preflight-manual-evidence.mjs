import { isMain, parseCliArgs } from '../lib/testing-common.mjs';

// Repackage the one already-published coordinator preflight. This entrypoint
// never launches evidence collection, builds runtime files, or issues a grant.
// Existing validators may query the frozen executable's read-only build commit.
if (isMain(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2), { defaults: {
      runtimeAuthorityPath: '', executionRoot: '',
      outputRoot: 'artifacts/testing/release-manual-collector',
    } });
    const { collectPublishedProviderPreflightManualEvidence } = await import('./release-manual-collector.mjs');
    console.log(JSON.stringify(await collectPublishedProviderPreflightManualEvidence(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
