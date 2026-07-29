import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { useAppStore } from '../stores/app-store';

type RuntimeSnapshot = typeof runtimeSnapshotMock;
type BridgePatch = Partial<RuntimeSnapshot['bridge']>;
type DriverOperation = NonNullable<RuntimeSnapshot['bridge']['lastDriverOperation']>;

/**
 * Store seeding shared by the driver-management suites: a fresh config draft,
 * empty runtime notifications and the canonical runtime snapshot.
 */
export function seedDriverStoreState() {
  useAppStore.setState((state) => ({
    ...state,
    configDraft: structuredClone(appConfigDraftMock),
    runtimeNotifications: [],
    runtimeSnapshot: structuredClone(runtimeSnapshotMock),
  }));
}

/** Clones the canonical runtime snapshot and applies a bridge patch. */
export function makeBridgeSnapshot(patch: BridgePatch = {}): RuntimeSnapshot {
  const snapshot = structuredClone(runtimeSnapshotMock);
  Object.assign(snapshot.bridge, patch);
  return snapshot;
}

/** {@link makeBridgeSnapshot} plus publishing the snapshot into the store. */
export function seedBridgeSnapshot(patch: BridgePatch = {}): RuntimeSnapshot {
  const snapshot = makeBridgeSnapshot(patch);
  useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));
  return snapshot;
}

/**
 * Canonical failed driver operation record; override the fields a test cares
 * about. Timestamps match the fixtures the suites asserted on before.
 */
export function makeFailedDriverOperation(overrides: Partial<DriverOperation> = {}): DriverOperation {
  const defaults: DriverOperation = {
    schemaVersion: 1,
    operationId: 'operation-1',
    action: 'reinstall',
    succeeded: false,
    phase: 'failed',
    errorCode: 'driver.operation-failed',
    summary: 'pnputil failed',
    logPath: 'C:\\temp\\driver-operation.log',
    startedAt: '2026-06-01T00:00:00Z',
    finishedAt: '2026-06-01T00:00:01Z',
  };
  return { ...defaults, ...overrides };
}

/** Finds a button whose trimmed text equals `text` exactly. */
export function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}
