import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RealTimeSessionPage from './RealTimeSessionPage';
import { useAppStore } from '../stores/app-store';
import { registerFakeBridgeDomHarness } from '../test-utils/fake-bridge-dom-harness';

type ControllerOptions = {
  runBusyAction: (action: string, task: () => Promise<void>) => Promise<void>;
  confirmWatchFallback: () => Promise<boolean>;
};

let capturedOptions: ControllerOptions | null = null;
const launchSceneMock = vi.hoisted(() => vi.fn());

// The scene controller is this suite's SUBJECT BOUNDARY: the tests drive its
// `confirmWatchFallback` / `runBusyAction` callbacks directly to exercise the
// screen's dialog and busy-state behavior. Its own IPC behavior is covered by
// useSceneSessionController.test.ts and the bridge-contract integration suite.
vi.mock('./session/useSceneSessionController', () => ({
  useSceneSessionController: (options: ControllerOptions) => {
    capturedOptions = options;
    return { ensureBridgeReady: vi.fn(), launchScene: launchSceneMock, stopAll: vi.fn() };
  },
}));

// Everything else runs the REAL runtime modules against the fake bridge
// contract double instead of stubbing the runtime layer away.
vi.mock('@tauri-apps/api/core', async () =>
  (await import('../test-utils/fake-bridge-harness')).fakeBridgeTauriCoreModule());

describe('RealTimeSessionScreen watch fallback confirmation', () => {
  let container: HTMLDivElement;

  const view = registerFakeBridgeDomHarness({
    beforeBridge: () => {
      capturedOptions = null;
      launchSceneMock.mockReset();
      launchSceneMock.mockResolvedValue(undefined);
    },
    seed: (slices) => {
      slices.audioRuntimeSnapshot.inbound.streamBound = false;
      slices.audioRuntimeSnapshot.outbound.streamBound = false;
      slices.audioRuntimeSnapshot.speech.dispatchState = 'idle';
      slices.audioRuntimeSnapshot.sttConnected = false;
    },
  }).view;

  beforeEach(() => {
    ({ container } = view);
  });

  async function renderPage() {
    await view.render(
      <MemoryRouter>
        <RealTimeSessionPage />
      </MemoryRouter>,
    );
  }

  it('replaces the blocking native confirm with a non-blocking in-app dialog and clears busy before the decision', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');

    await renderPage();

    expect(capturedOptions).not.toBeNull();
    const options = capturedOptions!;

    // Simulate a launch that left the UI busy right up to the fallback branch.
    await act(async () => {
      void options.runBusyAction('watch-start', () => new Promise<void>(() => {}));
    });
    const launchButtons = () => container.querySelectorAll<HTMLButtonElement>('.provider-list button');
    expect(launchButtons()[0]?.disabled).toBe(true);

    // Request the fallback decision.
    let decision: Promise<boolean> | null = null;
    await act(async () => {
      decision = options.confirmWatchFallback();
    });

    // No event-loop-blocking native modal is used.
    expect(confirmSpy).not.toHaveBeenCalled();
    // The in-app dialog is presented instead.
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // Busy is cleared before the user decides, so the controls stay responsive.
    expect(launchButtons()[0]?.disabled).toBe(false);

    // Confirming resolves the promise to subtitle-only (true) and dismisses the dialog.
    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('.action-button')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await expect(decision as unknown as Promise<boolean>).resolves.toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    confirmSpy.mockRestore();
  });

  it('resolves the fallback decision to AEC (false) when the dialog is cancelled', async () => {
    await renderPage();

    const options = capturedOptions!;
    let decision: Promise<boolean> | null = null;
    await act(async () => {
      decision = options.confirmWatchFallback();
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('.icon-button')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    await expect(decision as unknown as Promise<boolean>).resolves.toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps Watch clickable when only the idle provider preconnect is connected', async () => {
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: {
        ...state.audioRuntimeSnapshot,
        sttConnected: true,
        inbound: { ...state.audioRuntimeSnapshot.inbound, streamBound: false },
        outbound: { ...state.audioRuntimeSnapshot.outbound, streamBound: false },
        speech: { ...state.audioRuntimeSnapshot.speech, dispatchState: 'idle' },
      },
    }));

    await renderPage();

    const [watchButton, conversationButton] = container.querySelectorAll<HTMLButtonElement>('.provider-list button');
    const stopButton = container.querySelector<HTMLButtonElement>('.control-toolbar button');
    expect(watchButton?.disabled).toBe(false);
    expect(conversationButton?.disabled).toBe(false);
    expect(stopButton?.disabled).toBe(true);

    await act(async () => {
      watchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(launchSceneMock).toHaveBeenCalledTimes(1);
    expect(launchSceneMock).toHaveBeenCalledWith(expect.objectContaining({
      launchAttemptId: expect.stringMatching(/^watch-/),
      mode: 'watch',
    }));
  });

  it('shows a visible failure when the click handler rejects unexpectedly', async () => {
    launchSceneMock.mockRejectedValueOnce(new Error('unexpected controller failure'));

    await renderPage();
    const watchButton = container.querySelector<HTMLButtonElement>('.provider-list button');

    await act(async () => {
      watchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('unexpected controller failure');
  });
});
