import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { storageRecoveryHelpers, useStorageRecovery } from './useStorageRecovery';

const mocks = vi.hoisted(() => ({
  bootstrapRuntime: vi.fn(), bootstrapStorage: vi.fn(), runtimeSnapshot: vi.fn(), isTauri: vi.fn(),
}));
vi.mock('../../runtime/tauri-runtime', () => ({ isTauriRuntime: mocks.isTauri }));
vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopApiV2: () => ({ configuration: {
    bootstrapRuntime: mocks.bootstrapRuntime,
    bootstrapStorage: mocks.bootstrapStorage,
    runtimeSnapshot: mocks.runtimeSnapshot,
  } }),
}));

describe('useStorageRecovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let failure: string | null;
  let props: Parameters<typeof useStorageRecovery>[0];
  function Harness() { failure = useStorageRecovery(props); return <output>{failure}</output>; }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true);
    mocks.bootstrapStorage.mockResolvedValue(undefined);
    mocks.runtimeSnapshot.mockResolvedValue(structuredClone(runtimeSnapshotMock));
    mocks.bootstrapRuntime.mockResolvedValue(structuredClone(runtimeSnapshotMock));
    props = { runtimeStatus: 'preview', bridgeStatus: 'tauri-shell', setRuntimeSnapshot: vi.fn() };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

  it('settles the timeout wrapper on success, rejection, and deadline', async () => {
    await expect(storageRecoveryHelpers.invokeWithTimeout(async () => 1, 'success')).resolves.toBe(1);
    await expect(storageRecoveryHelpers.invokeWithTimeout(async () => { throw 'failed'; }, 'reject')).rejects.toBe('failed');
    const pending = storageRecoveryHelpers.invokeWithTimeout(() => new Promise(() => undefined), 'slow');
    const timedOut = expect(pending).rejects.toThrow('slow timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;
  });

  it('publishes a ready storage snapshot and ignores non-ready snapshots', async () => {
    const ready = structuredClone(runtimeSnapshotMock); ready.storage.status = 'ready';
    mocks.runtimeSnapshot.mockResolvedValueOnce(ready);
    await act(async () => { root.render(<Harness />); await Promise.resolve(); await Promise.resolve(); });
    expect(props.setRuntimeSnapshot).toHaveBeenCalledWith(ready);

    const notReady = structuredClone(runtimeSnapshotMock); notReady.storage.status = 'preview';
    mocks.runtimeSnapshot.mockResolvedValue(notReady);
    vi.mocked(props.setRuntimeSnapshot).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(props.setRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it('uses the last-resort bootstrap after eight polls and handles both ready and failed recovery', async () => {
    const ready = structuredClone(runtimeSnapshotMock); ready.storage.status = 'ready';
    mocks.runtimeSnapshot.mockResolvedValue({ ...ready, storage: { ...ready.storage, status: 'preview' } });
    mocks.bootstrapRuntime.mockResolvedValueOnce(ready);
    await act(async () => { root.render(<Harness />); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(mocks.bootstrapRuntime).toHaveBeenCalled();
    expect(props.setRuntimeSnapshot).toHaveBeenCalledWith(ready);

    props = { ...props, bridgeStatus: 'tauri-shell-2', setRuntimeSnapshot: vi.fn() };
    mocks.bootstrapStorage.mockRejectedValueOnce('storage offline');
    await act(async () => { root.render(<Harness />); await Promise.resolve(); await Promise.resolve(); });
    expect(failure).toBe('storage offline');
  });

  it('does not start recovery outside Tauri or after storage is ready', async () => {
    mocks.isTauri.mockReturnValue(false);
    await act(async () => root.render(<Harness />));
    expect(mocks.bootstrapStorage).not.toHaveBeenCalled();
    mocks.isTauri.mockReturnValue(true);
    props = { ...props, runtimeStatus: 'ready' };
    await act(async () => root.render(<Harness />));
    props = { ...props, runtimeStatus: 'preview', bridgeStatus: 'runtime-error' };
    await act(async () => root.render(<Harness />));
  });

  it('ignores late ready snapshots, last-resort results, and failures after cleanup', async () => {
    const ready = structuredClone(runtimeSnapshotMock); ready.storage.status = 'ready';
    let resolveStorage!: () => void;
    mocks.bootstrapStorage.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveStorage = resolve; }));
    await act(async () => root.render(<Harness />));
    props = { ...props, runtimeStatus: 'ready' };
    await act(async () => root.render(<Harness />));
    await act(async () => { resolveStorage(); await Promise.resolve(); await Promise.resolve(); });
    expect(props.setRuntimeSnapshot).not.toHaveBeenCalledWith(ready);

    let rejectStorage!: (reason: unknown) => void;
    props = { ...props, runtimeStatus: 'preview', bridgeStatus: 'late-rejection' };
    mocks.bootstrapStorage.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectStorage = reject; }));
    await act(async () => root.render(<Harness />));
    props = { ...props, runtimeStatus: 'ready' };
    await act(async () => root.render(<Harness />));
    await act(async () => { rejectStorage('late'); await Promise.resolve(); });
    expect(failure).toBeNull();

    let resolveRuntime!: (value: typeof ready) => void;
    props = { ...props, runtimeStatus: 'preview', bridgeStatus: 'late-last-resort' };
    mocks.bootstrapStorage.mockResolvedValue(undefined);
    mocks.runtimeSnapshot.mockResolvedValue({ ...ready, storage: { ...ready.storage, status: 'preview' } });
    mocks.bootstrapRuntime.mockImplementationOnce(() => new Promise((resolve) => { resolveRuntime = resolve; }));
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(16_000));
    props = { ...props, runtimeStatus: 'ready' };
    await act(async () => root.render(<Harness />));
    await act(async () => { resolveRuntime(ready); await Promise.resolve(); });
    expect(props.setRuntimeSnapshot).not.toHaveBeenCalledWith(ready);
  });
});
