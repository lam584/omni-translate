import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { publishSuccessfulStrictMatrixManifest } from './run-watch-mode-live-matrix.mjs';

// Read-only replay of an existing matrix. The publisher's diagnostic branch
// never writes canonical evidence and never starts a Provider invocation.
export function collectStrictMatrixPublication({ outputRoot, manifestPath }) {
  const previous = process.env.WATCH_STRICT_COLLECT_ALL;
  try {
    process.env.WATCH_STRICT_COLLECT_ALL = '1';
    return publishSuccessfulStrictMatrixManifest({ outputRoot, manifestPath });
  } finally {
    if (previous === undefined) delete process.env.WATCH_STRICT_COLLECT_ALL;
    else process.env.WATCH_STRICT_COLLECT_ALL = previous;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [outputRoot, manifestPath] = process.argv.slice(2);
  if (!outputRoot || !manifestPath) {
    console.error('usage: node collect-strict-matrix-publication.mjs <evidence-root> <matrix-manifest>');
    process.exitCode = 2;
  } else {
    const result = collectStrictMatrixPublication({ outputRoot, manifestPath });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
