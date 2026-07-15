import { describe, expect, it } from 'vitest';
import AudioRoutingPage from './AudioRoutingPage';
import DiagnosticsPage from './DiagnosticsPage';
import GlossaryPage from './GlossaryPage';
import ProvidersPage from './ProvidersPage';
import RealTimeSessionPage from './RealTimeSessionPage';
import SubtitleOverlayPage from './SubtitleOverlayPage';

describe('thin page entrypoints', () => {
  it('retain callable default exports after screen extraction', () => {
    for (const page of [
      AudioRoutingPage, DiagnosticsPage, GlossaryPage, ProvidersPage,
      RealTimeSessionPage, SubtitleOverlayPage,
    ]) {
      expect(page).toBeTypeOf('function');
    }
  });
});
