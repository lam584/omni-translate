import fs from 'node:fs';

// Retry publication only; callers retain ownership of staging and dispatch.
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const renameRetryWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function renameWithTransientRetrySync(
  sourcePath,
  destinationPath,
  {
    renameSync = fs.renameSync,
    sleepSync = (delayMs) => Atomics.wait(renameRetryWaitBuffer, 0, 0, delayMs),
    maxAttempts = 8,
    initialDelayMs = 20,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      renameSync(sourcePath, destinationPath);
      return { attempts: attempt };
    } catch (error) {
      if (
        !TRANSIENT_RENAME_ERROR_CODES.has(error?.code)
        || attempt === maxAttempts
      ) throw error;
      sleepSync(Math.min(initialDelayMs * (2 ** (attempt - 1)), 200));
    }
  }
  throw new Error('atomic rename retry loop ended unexpectedly');
}
