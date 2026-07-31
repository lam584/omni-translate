import { beforeEach, describe, expect, it } from 'vitest';

import {
  isNativeWatchDiagnosticAutostartAuthoritative,
  resetNativeWatchDiagnosticGateForTests,
  shouldSuppressGenericStartupAutostart,
  updateNativeWatchDiagnosticGateFromIpcPing,
} from './watch-mode';

describe('native Watch diagnostic startup gate', () => {
  beforeEach(() => {
    resetNativeWatchDiagnosticGateForTests();
  });

  it('requires both native authority tokens from a successful IPC ping', () => {
    expect(updateNativeWatchDiagnosticGateFromIpcPing('pong watchDiagnostic=true')).toBe(false);
    expect(updateNativeWatchDiagnosticGateFromIpcPing('pong backendAutostartAuthoritative=true')).toBe(false);
    expect(
      updateNativeWatchDiagnosticGateFromIpcPing(
        'pong watchDiagnostic=true backendAutostartAuthoritative=true',
      ),
    ).toBe(true);
    expect(isNativeWatchDiagnosticAutostartAuthoritative()).toBe(true);
  });

  it('uses native runtime truth when the build-time Vite marker is absent or expired', () => {
    const expiredViteEnv = {
      VITE_OMNI_WATCH_MODE_AUTOSTART: '1',
      VITE_OMNI_WATCH_MODE_RUN_MARKER: 'watch_mode_diagnostic.run_id=stale-build',
      VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS: '1000',
    };
    expect(shouldSuppressGenericStartupAutostart(expiredViteEnv, 2000)).toBe(false);

    updateNativeWatchDiagnosticGateFromIpcPing(
      'pong watchDiagnostic=true backendAutostartAuthoritative=true',
    );
    expect(shouldSuppressGenericStartupAutostart(expiredViteEnv, 2000)).toBe(true);
  });

  it('clears stale native truth when a later ordinary-process ping is observed', () => {
    updateNativeWatchDiagnosticGateFromIpcPing(
      'pong watchDiagnostic=true backendAutostartAuthoritative=true',
    );
    expect(updateNativeWatchDiagnosticGateFromIpcPing(
      'pong watchDiagnostic=false backendAutostartAuthoritative=false',
    )).toBe(false);
    expect(isNativeWatchDiagnosticAutostartAuthoritative()).toBe(false);
  });
});
