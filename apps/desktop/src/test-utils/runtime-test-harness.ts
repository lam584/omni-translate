import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../runtime/desktop-api';
import { PreviewDesktopApi } from '../runtime/preview-desktop-api';

/**
 * Desktop-API install sugar shared by the runtime suites. Both helpers clear
 * any previously installed boundary first, so they are safe to call from
 * `beforeEach` hooks and mid-test switches alike.
 */
export function enableTauriDesktopRuntime() {
  resetDesktopApiForTests();
  installDesktopApi(new TauriDesktopApi());
}

export function enablePreviewDesktopRuntime() {
  resetDesktopApiForTests();
  installDesktopApi(new PreviewDesktopApi());
}
