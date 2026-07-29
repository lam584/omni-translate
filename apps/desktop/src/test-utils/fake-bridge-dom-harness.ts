import { createFakeBridge, type FakeBridge } from '../mocks/fake-bridge';
import { resetDesktopApiForTests } from '../runtime/desktop-api';
import { registerDomHarness, type DomTestHarness } from './component-test-harness';
import { connectFakeBridge, disconnectFakeBridge } from './fake-bridge-harness';
import { enableTauriDesktopRuntime } from './runtime-test-harness';
import { seedRuntimeStore } from './store-seed';

export interface FakeBridgeDomHarnessOptions {
  /** Runs first in beforeEach, before the fake bridge is created (mock resets etc.). */
  beforeBridge?: () => void;
  /** Store slice mutation forwarded to seedRuntimeStore. */
  seed?: Parameters<typeof seedRuntimeStore>[0];
}

export interface FakeBridgeDomHarness {
  view: DomTestHarness;
  /** The fake bridge created for the current test. */
  readonly fake: FakeBridge;
}

/**
 * DOM harness preset for suites that run the real runtime modules against the
 * fake bridge contract double: wires connect/disconnectFakeBridge, the Tauri
 * desktop runtime flag, store seeding and desktop-api reset into the shared
 * registerDomHarness lifecycle.
 */
export function registerFakeBridgeDomHarness(options: FakeBridgeDomHarnessOptions = {}): FakeBridgeDomHarness {
  let fake: FakeBridge;
  const view = registerDomHarness({
    setup: () => {
      options.beforeBridge?.();
      fake = createFakeBridge();
      connectFakeBridge(fake.invoke);
      enableTauriDesktopRuntime();
      seedRuntimeStore(options.seed);
    },
    cleanup: () => {
      disconnectFakeBridge();
      resetDesktopApiForTests();
    },
  });
  return {
    view,
    get fake() {
      return fake;
    },
  };
}
