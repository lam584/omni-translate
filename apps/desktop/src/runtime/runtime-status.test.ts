import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { resolveRuntimeBridgeStatus } from './runtime-status';

describe('resolveRuntimeBridgeStatus', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('keeps browser preview for the pure preview mock snapshot', () => {
    expect(resolveRuntimeBridgeStatus(structuredClone(runtimeSnapshotMock))).toBe('browser-preview');
  });

  it('prefers desktop runtime whenever the current environment is tauri shell', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    expect(resolveRuntimeBridgeStatus(structuredClone(runtimeSnapshotMock))).toBe('tauri-shell');
  });

  it('treats a ready desktop snapshot as tauri shell even if bridgeStatus is stale', () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridgeStatus = 'browser-preview';
    snapshot.activeProfileId = 'desktop-shell';
    snapshot.storage.status = 'ready';
    snapshot.storage.databasePath = 'C:/Users/Red/AppData/Roaming/com.omni.translate/config/omni-config.db';
    snapshot.storage.credentialBackend = 'windows-credential-manager';
    snapshot.notifications = [
      {
        id: 'runtime-bootstrap',
        level: 'warning',
        source: 'rust-core',
        message: '前端已建立 invoke/event 通道，主窗口与托盘就绪。字幕浮窗将在首次使用时懒加载。',
        emittedAt: 'unix:1778883200',
      },
    ];

    expect(resolveRuntimeBridgeStatus(snapshot)).toBe('tauri-shell');
  });

  it('preserves runtime-error as the strongest signal', () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridgeStatus = 'runtime-error';
    snapshot.storage.status = 'ready';

    expect(resolveRuntimeBridgeStatus(snapshot)).toBe('runtime-error');
  });
});