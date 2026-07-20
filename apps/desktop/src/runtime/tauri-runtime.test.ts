import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isTauriMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => isTauriMock(),
}));

import { hasInvokeBridge, hasTauriAppOrigin, isTauriRuntime, waitForTauriRuntime } from './tauri-runtime';

describe('tauri runtime detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isTauriMock.mockReset().mockReturnValue(false);
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('detects both native and invoke bridge runtimes immediately', async () => {
    isTauriMock.mockReturnValue(true);
    expect(isTauriRuntime()).toBe(true);
    expect(await waitForTauriRuntime()).toBe(true);

    isTauriMock.mockReturnValue(false);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => undefined },
      configurable: true,
    });
    expect(hasInvokeBridge()).toBe(true);
    expect(isTauriRuntime()).toBe(true);
  });

  it('waits for a delayed invoke bridge and returns false after timeout', async () => {
    const delayed = waitForTauriRuntime(100, 10);
    await vi.advanceTimersByTimeAsync(30);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => undefined },
      configurable: true,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await delayed).toBe(true);

    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    const unavailable = waitForTauriRuntime(20, 10);
    await vi.advanceTimersByTimeAsync(30);
    expect(await unavailable).toBe(false);
  });

  it('returns false when window is unavailable', async () => {
    vi.stubGlobal('window', undefined);
    expect(hasInvokeBridge()).toBe(false);
    expect(isTauriRuntime()).toBe(false);
    expect(await waitForTauriRuntime()).toBe(false);
  });

  it('recognizes both Tauri production URL forms without relying on global injection timing', () => {
    expect(hasTauriAppOrigin({ protocol: 'tauri:', hostname: 'localhost' })).toBe(true);
    expect(hasTauriAppOrigin({ protocol: 'http:', hostname: 'tauri.localhost' })).toBe(true);
    expect(hasTauriAppOrigin({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(false);
  });
});
